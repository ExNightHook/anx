// ============================================================
//  db.js — Инициализация SQLite и все запросы к данным.
//  Без бизнес-логики — только SQL и минимальные преобразования.
// ============================================================

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { DB_PATH } = require('./config');

// --- Подготовка директории и подключение ---
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(DB_PATH);

// WAL-mode для лучшей конкурентности
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ============================================================
//  Schema
// ============================================================

db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        username      TEXT    NOT NULL UNIQUE,
        password      TEXT    NOT NULL,
        email         TEXT    NOT NULL UNIQUE,
        role          TEXT    NOT NULL DEFAULT 'user',
        hwid          TEXT,
        balance       REAL    NOT NULL DEFAULT 0,

        -- Подписка (legacy single sub — сохраняем для совместимости с лоадером)
        sub_type      TEXT,
        expiry_date   TEXT,
        frozen        INTEGER NOT NULL DEFAULT 0,
        freeze_start_date TEXT,
        total_frozen_days  INTEGER NOT NULL DEFAULT 0,

        -- Управление
        blocked       INTEGER NOT NULL DEFAULT 0,
        block_reason  TEXT,
        block_until   TEXT,

        -- Парольный сброс
        password_reset_token TEXT,
        password_reset_expires TEXT,
        password_reset_count  INTEGER NOT NULL DEFAULT 0,
        last_password_reset   TEXT,

        -- HWID сброс
        last_hwid_reset   TEXT,

        -- Timestamps
        created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_subscriptions (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        product_id      INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        product_name    TEXT    NOT NULL,
        days_purchased  INTEGER NOT NULL,
        price_paid      REAL    NOT NULL DEFAULT 0,
        status          TEXT    NOT NULL DEFAULT 'active',
        activated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
        expiry_date     TEXT    NOT NULL,

        -- Заморозка per-subscription
        frozen          INTEGER NOT NULL DEFAULT 0,
        freeze_start    TEXT,
        total_frozen_days INTEGER NOT NULL DEFAULT 0,
        freeze_used     INTEGER NOT NULL DEFAULT 0,

        created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_user_subs_user ON user_subscriptions(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_subs_product ON user_subscriptions(product_id);

    CREATE TABLE IF NOT EXISTS products (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        slug        TEXT    NOT NULL UNIQUE,
        name        TEXT    NOT NULL,
        description TEXT    NOT NULL DEFAULT '',
        short_desc  TEXT    NOT NULL DEFAULT '',
        image_url   TEXT    NOT NULL DEFAULT '',
        is_active   INTEGER NOT NULL DEFAULT 1,
        sort_order  INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS product_prices (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        days        INTEGER NOT NULL,
        price       REAL    NOT NULL,
        UNIQUE(product_id, days)
    );

    CREATE TABLE IF NOT EXISTS builds (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id  INTEGER REFERENCES products(id) ON DELETE SET NULL,
        version     TEXT    NOT NULL,
        hash        TEXT    NOT NULL DEFAULT '',
        is_active   INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS api_sessions (
        id          TEXT PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        hwid        TEXT,
        ip          TEXT,
        user_agent  TEXT,
        created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
        last_used   TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS payment_history (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        amount      REAL    NOT NULL,
        description TEXT    NOT NULL DEFAULT '',
        status      TEXT    NOT NULL DEFAULT 'pending',
        created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
`);

// ============================================================
//  Helpers
// ============================================================

function now() {
    return new Date().toISOString();
}

// ============================================================
//  Users
// ============================================================

function getUserById(id) {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function getUserByUsername(username) {
    return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function getUserByEmail(email) {
    return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

function createUser({ username, password, email }) {
    return db.prepare(
        `INSERT INTO users (username, password, email) VALUES (?, ?, ?)`
    ).run(username, password, email);
}

function updateUser(id, patch) {
    const keys = Object.keys(patch);
    if (keys.length === 0) return;
    const sets = keys.map(k => `${k} = ?`).join(', ');
    const values = keys.map(k => patch[k]);
    values.push(id);
    db.prepare(`UPDATE users SET ${sets}, updated_at = datetime('now') WHERE id = ?`).run(...values);
}

function getUserByResetToken(token) {
    return db.prepare('SELECT * FROM users WHERE password_reset_token = ?').get(token);
}

function getAllUsers() {
    return db.prepare(
        `SELECT id, username, email, role, sub_type, expiry_date, frozen, freeze_start_date, blocked, block_reason, block_until, balance, created_at
         FROM users ORDER BY id`
    ).all();
}

// ============================================================
//  User Subscriptions
// ============================================================

function getUserSubscriptions(userId) {
    return db.prepare(
        `SELECT us.*, p.name as product_name, p.slug as product_slug, p.image_url
         FROM user_subscriptions us
         LEFT JOIN products p ON p.id = us.product_id
         WHERE us.user_id = ?
         ORDER BY us.expiry_date DESC`
    ).all(userId);
}

function getActiveUserSubscriptions(userId) {
    return db.prepare(
        `SELECT us.*, p.name as product_name, p.slug as product_slug, p.image_url
         FROM user_subscriptions us
         LEFT JOIN products p ON p.id = us.product_id
         WHERE us.user_id = ? AND us.status = 'active' AND us.expiry_date > datetime('now')
         ORDER BY us.expiry_date DESC`
    ).all(userId);
}

function createUserSubscription({ userId, productId, productName, daysPurchased, pricePaid, expiryDate }) {
    return db.prepare(
        `INSERT INTO user_subscriptions (user_id, product_id, product_name, days_purchased, price_paid, expiry_date)
         VALUES (?, ?, ?, ?, ?, ?)`
    ).run(userId, productId, productName, daysPurchased, pricePaid, expiryDate);
}

function extendUserSubscription(subId, extraDays) {
    db.prepare(
        `UPDATE user_subscriptions
         SET expiry_date = datetime(expiry_date, '+${extraDays} days'),
             updated_at = datetime('now')
         WHERE id = ?`
    ).run(subId);
}

function freezeUserSubscription(subId) {
    const sub = db.prepare('SELECT * FROM user_subscriptions WHERE id = ?').get(subId);
    if (!sub || sub.frozen === 1) return false;
    db.prepare(
        `UPDATE user_subscriptions SET frozen = 1, freeze_start = datetime('now') WHERE id = ?`
    ).run(subId);
    return true;
}

function unfreezeUserSubscription(subId) {
    const sub = db.prepare('SELECT * FROM user_subscriptions WHERE id = ?').get(subId);
    if (!sub || sub.frozen !== 1 || !sub.freeze_start) return false;

    const freezeStart = new Date(sub.freeze_start);
    const freezeDurationMs = Date.now() - freezeStart.getTime();
    const freezeDurationDays = Math.max(1, Math.ceil(freezeDurationMs / (1000 * 60 * 60 * 24)));

    db.prepare(
        `UPDATE user_subscriptions
         SET frozen = 0, freeze_start = NULL,
             total_frozen_days = total_frozen_days + ?,
             freeze_used = 1,
             expiry_date = datetime(expiry_date, '+${freezeDurationDays} days')
         WHERE id = ?`
    ).run(freezeDurationDays, subId);
    return true;
}

function canFreezeSubscription(subId) {
    const sub = db.prepare('SELECT * FROM user_subscriptions WHERE id = ?').get(subId);
    if (!sub || sub.frozen === 1 || sub.freeze_used === 1) return false;
    if (new Date(sub.expiry_date) <= new Date()) return false;
    return true;
}

// ============================================================
//  Legacy compatibility — users.sub_type / expiry_date
//  Лоадер работает через эти поля. Синхронизируем.
// ============================================================

function syncLegacySub(userId) {
    // Находим "самую длинную" активную подписку и пишем в users таблицу
    const subs = db.prepare(
        `SELECT product_name, expiry_date, frozen
         FROM user_subscriptions
         WHERE user_id = ? AND status = 'active' AND expiry_date > datetime('now')
         ORDER BY expiry_date DESC LIMIT 1`
    ).all(userId);

    if (subs.length > 0) {
        const best = subs[0];
        updateUser(userId, {
            sub_type: best.product_name,
            expiry_date: best.expiry_date,
            frozen: best.frozen === 1 ? 1 : 0,
        });
    } else {
        updateUser(userId, { sub_type: null, expiry_date: null, frozen: 0 });
    }
}

// ============================================================
//  Builds
// ============================================================

function getActiveBuild(productId) {
    return db.prepare('SELECT * FROM builds WHERE is_active = 1 AND (product_id = ? OR product_id IS NULL) LIMIT 1').get(productId || null);
}

function getAllBuilds() {
    return db.prepare('SELECT b.*, p.name as product_name FROM builds b LEFT JOIN products p ON p.id = b.product_id ORDER BY b.id DESC').all();
}

function setBuildActive(buildId) {
    db.prepare('UPDATE builds SET is_active = 0').run();
    db.prepare('UPDATE builds SET is_active = 1 WHERE id = ?').run(buildId);
}

function createBuild({ productId, version, hash }) {
    return db.prepare(
        `INSERT INTO builds (product_id, version, hash, is_active) VALUES (?, ?, ?, 0)`
    ).run(productId, version, hash);
}

// ============================================================
//  Products
// ============================================================

function getAllProducts(showInactive) {
    if (showInactive) {
        return db.prepare('SELECT * FROM products ORDER BY sort_order, id').all();
    }
    return db.prepare('SELECT * FROM products WHERE is_active = 1 ORDER BY sort_order, id').all();
}

function getProductById(id) {
    return db.prepare('SELECT * FROM products WHERE id = ?').get(id);
}

function getProductBySlug(slug) {
    return db.prepare('SELECT * FROM products WHERE slug = ?').get(slug);
}

function createProduct({ slug, name, description, shortDesc, imageUrl }) {
    return db.prepare(
        `INSERT INTO products (slug, name, description, short_desc, image_url) VALUES (?, ?, ?, ?, ?)`
    ).run(slug, name, description, shortDesc || '', imageUrl || '');
}

function updateProduct(id, patch) {
    const keys = Object.keys(patch);
    if (keys.length === 0) return;
    const sets = keys.map(k => `p.${k} = ?`).join(', ');
    const values = keys.map(k => patch[k]);
    values.push(id);
    db.prepare(`UPDATE products p SET ${sets}, p.updated_at = datetime('now') WHERE p.id = ?`).run(...values);
}

function deleteProduct(id) {
    db.prepare('DELETE FROM products WHERE id = ?').run(id);
}

function setProductActive(id, active) {
    db.prepare('UPDATE products SET is_active = ?, updated_at = datetime("now") WHERE id = ?').run(active ? 1 : 0, id);
}

// --- Prices ---

function getProductPrices(productId) {
    return db.prepare('SELECT * FROM product_prices WHERE product_id = ? ORDER BY days').all(productId);
}

function setProductPrices(productId, prices) {
    // prices: [{ days, price }]
    db.prepare('DELETE FROM product_prices WHERE product_id = ?').run(productId);
    const stmt = db.prepare('INSERT INTO product_prices (product_id, days, price) VALUES (?, ?, ?)');
    for (const p of prices) {
        stmt.run(productId, p.days, p.price);
    }
}

// ============================================================
//  Payment History
// ============================================================

function getPaymentHistory(userId) {
    return db.prepare('SELECT * FROM payment_history WHERE user_id = ? ORDER BY created_at DESC').all(userId);
}

function addPaymentRecord({ userId, amount, description, status }) {
    return db.prepare(
        `INSERT INTO payment_history (user_id, amount, description, status) VALUES (?, ?, ?, ?)`
    ).run(userId, amount, description || '', status || 'pending');
}

// ============================================================
//  Stats (for admin panel)
// ============================================================

function getStats() {
    const users = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
    const activeSubs = db.prepare("SELECT COUNT(*) as count FROM user_subscriptions WHERE status = 'active' AND expiry_date > datetime('now')").get().count;
    const totalRevenue = db.prepare("SELECT COALESCE(SUM(price_paid), 0) as total FROM user_subscriptions").get().total;
    const productCount = db.prepare('SELECT COUNT(*) as count FROM products').get().count;
    return { users, activeSubs, totalRevenue, productCount };
}

// ============================================================
//  Cleanup: expire old subs (called by cron)
// ============================================================

function expireOldSubscriptions() {
    db.prepare(
        `UPDATE user_subscriptions SET status = 'expired' WHERE status = 'active' AND expiry_date <= datetime('now')`
    ).run();
    // Sync legacy fields for affected users
    const affected = db.prepare(
        `SELECT DISTINCT user_id FROM user_subscriptions WHERE status = 'expired' AND expiry_date <= datetime('now')`
    ).all();
    for (const row of affected) {
        syncLegacySub(row.user_id);
    }
}

module.exports = {
    db,
    getUserById,
    getUserByUsername,
    getUserByEmail,
    createUser,
    updateUser,
    getUserByResetToken,
    getAllUsers,
    getUserSubscriptions,
    getActiveUserSubscriptions,
    createUserSubscription,
    extendUserSubscription,
    freezeUserSubscription,
    unfreezeUserSubscription,
    canFreezeSubscription,
    syncLegacySub,
    getActiveBuild,
    getAllBuilds,
    setBuildActive,
    createBuild,
    getAllProducts,
    getProductById,
    getProductBySlug,
    createProduct,
    updateProduct,
    deleteProduct,
    setProductActive,
    getProductPrices,
    setProductPrices,
    getPaymentHistory,
    addPaymentRecord,
    getStats,
    expireOldSubscriptions,
};
