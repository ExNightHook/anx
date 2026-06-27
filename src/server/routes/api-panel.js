// ============================================================
//  routes/api-panel.js — API панели управления (/api/panel/*).
//  Доступ: admin и owner.
// ============================================================

const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin, requireOwner } = require('../middleware/auth');
const {
    db,
    getUserById,
    getAllUsers,
    updateUser,
    getUserSubscriptions,
    extendUserSubscription,
    freezeUserSubscription,
    unfreezeUserSubscription,
    getAllProducts,
    getProductById,
    createProduct,
    updateProduct,
    deleteProduct,
    setProductActive,
    getProductPrices,
    setProductPrices,
    getAllBuilds,
    setBuildActive,
    createBuild,
    getStats,
    expireOldSubscriptions,
    syncLegacySub,
    addPaymentRecord,
} = require('../lib/db');
const { formatDateRu, formatDateRuFull, formatPrice, escapeHtml, isAdmin, daysRemaining } = require('../lib/helpers');

// Все роуты требуют авторизации
router.use(requireAuth);

// ==================== GET: Dashboard ====================

router.get('/', requireAdmin, (req, res) => {
    const stats = getStats();
    const user = getUserById(req.session.userId);
    res.render('panel/index', {
        user,
        stats,
        formatPrice,
        formatDateRu,
        formatDateRuFull,
        escapeHtml,
        isAdmin: isAdmin(user.role),
        isOwner: user.role === 'owner',
    });
});

// ==================== Пользователи ====================

router.get('/users', requireAdmin, (req, res) => {
    const users = getAllUsers();
    const currentUser = getUserById(req.session.userId);
    res.render('panel/users', {
        user: currentUser,
        users,
        formatDateRu,
        formatDateRuFull,
        escapeHtml,
        isAdmin: isAdmin(currentUser.role),
        isOwner: currentUser.role === 'owner',
    });
});

// --- Добавить дни подписке ---
router.post('/users/:id/add-days', requireAdmin, (req, res) => {
    const userId = parseInt(req.params.id, 10);
    const days = parseInt(req.body.days, 10);
    const subId = req.body.sub_id ? parseInt(req.body.sub_id, 10) : null;

    if (!days || days <= 0) {
        req.session.flash = { error: 'Укажите корректное количество дней' };
        return res.redirect('/api/panel/users');
    }

    if (subId) {
        extendUserSubscription(subId, days);
        // sync legacy sub for user
        syncLegacySub(userId);
    } else {
        // Legacy: extend user.sub_type expiry_date
        const user = getUserById(userId);
        if (user && user.expiry_date) {
            const newExpiry = new Date(new Date(user.expiry_date).getTime() + days * 24 * 60 * 60 * 1000);
            updateUser(userId, { expiry_date: newExpiry.toISOString() });
        }
    }

    req.session.flash = { success: `Добавлено ${days} дн.` };
    res.redirect('/api/panel/users');
});

// --- Заблокировать аккаунт ---
router.post('/users/:id/block', requireAdmin, (req, res) => {
    const userId = parseInt(req.params.id, 10);
    const { reason, duration } = req.body;

    const until = duration ? new Date(Date.now() + parseInt(duration, 10) * 24 * 60 * 60 * 1000).toISOString() : null;
    updateUser(userId, {
        blocked: 1,
        block_reason: reason || 'Блокировка администратором',
        block_until: until,
    });

    req.session.flash = { success: 'Аккаунт заблокирован' };
    res.redirect('/api/panel/users');
});

// --- Разблокировать аккаунт ---
router.post('/users/:id/unblock', requireAdmin, (req, res) => {
    const userId = parseInt(req.params.id, 10);
    updateUser(userId, { blocked: 0, block_reason: null, block_until: null });
    req.session.flash = { success: 'Аккаунт разблокирован' };
    res.redirect('/api/panel/users');
});

// ==================== Заморозка продукта (глобальная) ====================

router.post('/freeze-product/:id', requireAdmin, (req, res) => {
    const productId = parseInt(req.params.id, 10);
    // Замораживаем все активные подписки на этот продукт
    db.prepare(
        `UPDATE user_subscriptions SET frozen = 1, freeze_start = datetime('now')
         WHERE product_id = ? AND status = 'active' AND frozen = 0 AND expiry_date > datetime('now')`
    ).run(productId);
    // Деактивируем продукт
    setProductActive(productId, false);

    // Sync legacy subs for affected users
    const affected = db.prepare('SELECT DISTINCT user_id FROM user_subscriptions WHERE product_id = ? AND frozen = 1').all(productId);
    for (const row of affected) syncLegacySub(row.user_id);

    req.session.flash = { success: 'Продукт заморожен. Все подписки на него заморожены.' };
    res.redirect('/api/panel/products');
});

router.post('/unfreeze-product/:id', requireAdmin, (req, res) => {
    const productId = parseInt(req.params.id, 10);
    // Размораживаем все замороженные подписки
    const subs = db.prepare(
        `SELECT id, freeze_start, expiry_date FROM user_subscriptions
         WHERE product_id = ? AND frozen = 1 AND freeze_start IS NOT NULL`
    ).all(productId);

    for (const sub of subs) {
        const freezeStart = new Date(sub.freeze_start);
        const freezeDurationDays = Math.max(1, Math.ceil((Date.now() - freezeStart.getTime()) / (1000 * 60 * 60 * 24)));
        db.prepare(
            `UPDATE user_subscriptions
             SET frozen = 0, freeze_start = NULL, total_frozen_days = total_frozen_days + ?,
                 expiry_date = datetime(expiry_date, '+${freezeDurationDays} days')
             WHERE id = ?`
        ).run(freezeDurationDays, sub.id);
    }

    setProductActive(productId, true);

    // Sync
    const affected = db.prepare('SELECT DISTINCT user_id FROM user_subscriptions WHERE product_id = ?').all(productId);
    for (const row of affected) syncLegacySub(row.user_id);

    req.session.flash = { success: 'Продукт разморожен. Компенсация применена.' };
    res.redirect('/api/panel/products');
});

// ==================== Товары (owner) ====================

router.get('/products', requireAdmin, (req, res) => {
    const products = getAllProducts(true);
    const currentUser = getUserById(req.session.userId);
    const productsWithPrices = products.map(p => ({
        ...p,
        prices: getProductPrices(p.id),
    }));
    res.render('panel/products', {
        user: currentUser,
        products: productsWithPrices,
        formatPrice,
        escapeHtml,
        isAdmin: isAdmin(currentUser.role),
        isOwner: currentUser.role === 'owner',
    });
});

// --- Добавить товар ---
router.post('/products/add', requireOwner, (req, res) => {
    const { slug, name, description, short_desc, image_url } = req.body;
    if (!slug || !name) {
        req.session.flash = { error: 'Заполните slug и название' };
        return res.redirect('/api/panel/products');
    }
    try {
        createProduct({ slug, name, description: description || '', shortDesc: short_desc || '', imageUrl: image_url || '' });
        req.session.flash = { success: 'Товар добавлен' };
    } catch (e) {
        req.session.flash = { error: 'Ошибка: ' + e.message };
    }
    res.redirect('/api/panel/products');
});

// --- Редактировать товар ---
router.post('/products/:id/edit', requireOwner, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { name, description, short_desc, image_url } = req.body;
    const patch = {};
    if (name !== undefined) patch.name = name;
    if (description !== undefined) patch.description = description;
    if (short_desc !== undefined) patch.short_desc = short_desc;
    if (image_url !== undefined) patch.image_url = image_url;
    updateProduct(id, patch);
    req.session.flash = { success: 'Товар обновлён' };
    res.redirect('/api/panel/products');
});

// --- Удалить товар ---
router.post('/products/:id/delete', requireOwner, (req, res) => {
    const id = parseInt(req.params.id, 10);
    deleteProduct(id);
    req.session.flash = { success: 'Товар удалён' };
    res.redirect('/api/panel/products');
});

// --- Цены товара ---
router.post('/products/:id/prices', requireOwner, (req, res) => {
    const productId = parseInt(req.params.id, 10);
    // format: "1:50,7:250,30:1000"
    const pricesStr = req.body.prices;
    if (!pricesStr) {
        req.session.flash = { error: 'Укажите цены' };
        return res.redirect('/api/panel/products');
    }
    const prices = pricesStr.split(',').map(s => {
        const [days, price] = s.trim().split(':');
        return { days: parseInt(days, 10), price: parseFloat(price) };
    }).filter(p => p.days > 0 && p.price >= 0);

    setProductPrices(productId, prices);
    req.session.flash = { success: 'Цены обновлены' };
    res.redirect('/api/panel/products');
});

// ==================== Билды ====================

router.get('/builds', requireAdmin, (req, res) => {
    const builds = getAllBuilds();
    const currentUser = getUserById(req.session.userId);
    res.render('panel/builds', {
        user: currentUser,
        builds,
        formatDateRuFull,
        escapeHtml,
        isAdmin: isAdmin(currentUser.role),
        isOwner: currentUser.role === 'owner',
    });
});

router.post('/builds/add', requireOwner, (req, res) => {
    const { product_id, version, hash } = req.body;
    if (!version) {
        req.session.flash = { error: 'Укажите версию' };
        return res.redirect('/api/panel/builds');
    }
    createBuild({ productId: product_id ? parseInt(product_id, 10) : null, version, hash: hash || '' });
    req.session.flash = { success: 'Билд добавлен' };
    res.redirect('/api/panel/builds');
});

router.post('/builds/:id/activate', requireOwner, (req, res) => {
    const buildId = parseInt(req.params.id, 10);
    setBuildActive(buildId);
    req.session.flash = { success: 'Билд активирован' };
    res.redirect('/api/panel/builds');
});

// ==================== JSON API endpoints для AJAX ====================

router.get('/api/users/:id/subscriptions', requireAdmin, (req, res) => {
    const userId = parseInt(req.params.id, 10);
    const subs = getUserSubscriptions(userId);
    res.json(subs.map(s => ({
        ...s,
        days_remaining: daysRemaining(s.expiry_date),
        expiry_formatted: formatDateRu(s.expiry_date),
    })));
});

router.get('/api/stats', requireAdmin, (req, res) => {
    res.json(getStats());
});

module.exports = router;
