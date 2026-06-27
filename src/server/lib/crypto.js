// ============================================================
//  crypto.js — Криптография проекта Anxiety.
//
//  - XOR-транспорт (совместимость с C++ лоадером)
//  - PBKDF2-SHA256 хэширование паролей
//  - AES-256-GCM для enhanced encryption API
//  - HMAC-SHA256 чексуммы пакетов
//  - Timing-safe сравнения
//  - Управление API-сессиями для лоадера
// ============================================================

const crypto = require('crypto');
const {
    PBKDF2_ITERATIONS,
    PBKDF2_SALT_BYTES,
    PBKDF2_HASH_BITS,
    PBKDF2_PREFIX,
    ENCRYPTION_KEYS,
    API_SHARED_SECRET,
} = require('./config');

// ---------------------------------------------------------------------------
//  Утилиты кодирования
// ---------------------------------------------------------------------------

function stringToByteArray(str) {
    return Buffer.from(str, 'utf-8');
}

function byteArrayToString(bytes) {
    return Buffer.from(bytes).toString('utf-8');
}

function bytesToBase64(buf) {
    return buf.toString('base64');
}

function base64ToBytes(b64) {
    return Buffer.from(b64, 'base64');
}

function bytesToHex(buf) {
    return buf.toString('hex');
}

// ---------------------------------------------------------------------------
//  Constant-time сравнение
// ---------------------------------------------------------------------------

function timingSafeEqual(a, b) {
    const bufA = Buffer.isBuffer(a) ? a : Buffer.from(a);
    const bufB = Buffer.isBuffer(b) ? b : Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    let diff = 0;
    for (let i = 0; i < bufA.length; i++) {
        diff |= bufA[i] ^ bufB[i];
    }
    return diff === 0;
}

// ---------------------------------------------------------------------------
//  XOR-транспорт между C++ лоадером и /api/main/*
// ---------------------------------------------------------------------------

function xorCrypt(data) {
    const keys = ENCRYPTION_KEYS;
    const result = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i++) {
        result[i] = data[i] ^ keys[i % keys.length];
    }
    return result;
}

// ---------------------------------------------------------------------------
//  PBKDF2-SHA256 хэширование паролей
//  Формат: pbkdf2$<iterations>$<base64(salt)>$<base64(hash)>
// ---------------------------------------------------------------------------

function hashPassword(password) {
    const salt = crypto.randomBytes(PBKDF2_SALT_BYTES);
    const hash = pbkdf2(password, salt, PBKDF2_ITERATIONS);
    return `${PBKDF2_PREFIX}$${PBKDF2_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(hash)}`;
}

function pbkdf2(password, salt, iterations) {
    return crypto.pbkdf2Sync(password, salt, iterations, PBKDF2_HASH_BITS / 8, 'sha256');
}

function verifyHashedPassword(password, stored) {
    const parts = String(stored).split('$');
    if (parts.length !== 4 || parts[0] !== PBKDF2_PREFIX) return false;
    const iterations = parseInt(parts[1], 10);
    const salt = base64ToBytes(parts[2]);
    const expected = base64ToBytes(parts[3]);
    if (!Number.isFinite(iterations) || iterations <= 0) return false;
    const actual = pbkdf2(password, salt, iterations);
    return timingSafeEqual(actual, expected);
}

function isHashed(stored) {
    return typeof stored === 'string' && stored.startsWith(`${PBKDF2_PREFIX}$`);
}

function checkPassword(password, stored) {
    if (stored == null) return { ok: false, needsRehash: false };
    if (isHashed(stored)) {
        return { ok: verifyHashedPassword(password, stored), needsRehash: false };
    }
    // Plaintext fallback (legacy)
    if (timingSafeEqual(password, String(stored))) {
        return { ok: true, needsRehash: true };
    }
    return { ok: false, needsRehash: false };
}

// ---------------------------------------------------------------------------
//  AES-256-GCM шифрование (enhanced encryption для API лоадера)
// ---------------------------------------------------------------------------

function deriveAesKey() {
    // Используем API_SHARED_SECRET как основу для deriving ключа
    return crypto.createHash('sha256').update(API_SHARED_SECRET).digest();
}

function aesEncrypt(plaintext) {
    const key = deriveAesKey();
    const iv = crypto.randomBytes(12); // 96-bit IV для GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(plaintext, 'utf-8');
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    const authTag = cipher.getAuthTag(); // 16-byte auth tag
    // Формат: iv(12) + ciphertext + tag(16)
    return Buffer.concat([iv, encrypted, authTag]);
}

function aesDecrypt(encryptedBuf) {
    if (encryptedBuf.length < 28) return null; // минимум: 12 + 0 + 16
    const key = deriveAesKey();
    const iv = encryptedBuf.subarray(0, 12);
    const authTag = encryptedBuf.subarray(encryptedBuf.length - 16);
    const ciphertext = encryptedBuf.subarray(12, encryptedBuf.length - 16);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    try {
        const decrypted = decipher.update(ciphertext);
        return Buffer.concat([decrypted, decipher.final()]).toString('utf-8');
    } catch (e) {
        return null; // Тег не совпал — данные изменены
    }
}

// ---------------------------------------------------------------------------
//  HMAC-SHA256 чексуммы пакетов
// ---------------------------------------------------------------------------

function computePacketHmac(payload, timestamp, nonce) {
    const hmac = crypto.createHmac('sha256', API_SHARED_SECRET);
    hmac.update(`${timestamp}:${nonce}:`);
    hmac.update(payload);
    return hmac.digest('hex');
}

function verifyPacketHmac(payload, timestamp, nonce, receivedHmac) {
    if (!receivedHmac) return false;
    // Защита от replay: отклоняем пакеты старше 60 секунд
    const age = (Date.now() - parseInt(timestamp, 10)) / 1000;
    if (Math.abs(age) > 60) return false;
    const expected = computePacketHmac(payload, timestamp, nonce);
    return timingSafeEqual(expected, receivedHmac);
}

// ---------------------------------------------------------------------------
//  API-сессии для лоадера (in-memory)
//  Когда лоадер авторизуется через /api/main/auth, создаётся сессия
//  с уникальным sessionId, которая действует 1 час и продлевается при
//  каждом запросе.
// ---------------------------------------------------------------------------

const apiSessions = new Map(); // sessionId -> { userId, hwid, createdAt, lastUsed }

const API_SESSION_TTL_MS = 60 * 60 * 1000; // 1 час

function createApiSession(userId, hwid) {
    const sessionId = crypto.randomBytes(24).toString('hex');
    const now = Date.now();
    apiSessions.set(sessionId, { userId, hwid, createdAt: now, lastUsed: now });
    return sessionId;
}

function getApiSession(sessionId) {
    const session = apiSessions.get(sessionId);
    if (!session) return null;
    if (Date.now() - session.lastUsed > API_SESSION_TTL_MS) {
        apiSessions.delete(sessionId);
        return null;
    }
    session.lastUsed = Date.now();
    return session;
}

function destroyApiSession(sessionId) {
    apiSessions.delete(sessionId);
}

// GC каждые 10 минут
setInterval(() => {
    const now = Date.now();
    for (const [id, s] of apiSessions) {
        if (now - s.lastUsed > API_SESSION_TTL_MS) apiSessions.delete(id);
    }
}, 10 * 60 * 1000);

// ---------------------------------------------------------------------------
//  Генерация токенов для сброса пароля
// ---------------------------------------------------------------------------

function generateResetToken() {
    return crypto.randomBytes(32).toString('hex');
}

function generateEmailVerificationToken() {
    return crypto.randomBytes(24).toString('hex');
}

module.exports = {
    stringToByteArray,
    byteArrayToString,
    bytesToBase64,
    base64ToBytes,
    bytesToHex,
    timingSafeEqual,
    xorCrypt,
    hashPassword,
    checkPassword,
    isHashed,
    aesEncrypt,
    aesDecrypt,
    computePacketHmac,
    verifyPacketHmac,
    createApiSession,
    getApiSession,
    destroyApiSession,
    generateResetToken,
    generateEmailVerificationToken,
};
