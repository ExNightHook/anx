// ============================================================
//  config.js — Глобальные настройки проекта Anxiety.
//  Все секреты читаются из переменных окружения (.env).
// ============================================================

const path = require('path');

// --- Сервер ---
const PORT = parseInt(process.env.PORT || '443', 10);
const HOST = process.env.HOST || '0.0.0.0';

// --- SSL ---
const SSL_KEY_PATH = process.env.SSL_KEY_PATH || path.join(__dirname, '../../../ssl/aesthesia.xyz.key');
const SSL_CERT_PATH = process.env.SSL_CERT_PATH || path.join(__dirname, '../../../ssl/aesthesia.xyz.crt');

// --- Сессии ---
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-in-production';
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 дней

// --- Домен ---
const DOMAIN = process.env.DOMAIN || 'aesthesia.xyz';

// --- hCaptcha ---
const HCAPTCHA_SITE_KEY = process.env.HCAPTCHA_SITE_KEY || '';
const HCAPTCHA_SECRET_KEY = process.env.HCAPTCHA_SECRET_KEY || '';

// --- XOR-ключи для транспорта лоадера ---
function parseEncryptionKeys(str) {
    const raw = str || '0x5A,0x5A,0x5A,0x7CA,0x7CA,0x7CA,0x7CA,0x3A';
    return raw.split(',').map(s => parseInt(s.trim(), 16));
}
const ENCRYPTION_KEYS = parseEncryptionKeys(process.env.ENCRYPTION_KEYS);

// --- API shared secret для enhanced encryption ---
const API_SHARED_SECRET = process.env.API_SHARED_SECRET || '';

// --- PBKDF2 ---
const PBKDF2_ITERATIONS = 100000;
const PBKDF2_SALT_BYTES = 16;
const PBKDF2_HASH_BITS = 256;
const PBKDF2_PREFIX = 'pbkdf2';

// --- Лимиты ---
const MIN_PASSWORD_LENGTH = 6;
const HWID_RESET_PERIOD_MONTHS = 1;
const HWID_RESET_MAX = 1;

// --- Rate limiting ---
const RATE_LIMIT = {
    WINDOW_MS: 60 * 1000,
    MAX_ATTEMPTS: 5,
};

// --- Пути БД ---
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../../data/anxiety.db');

// --- Роли ---
const ROLES = {
    USER: 'user',
    ADMIN: 'admin',
    OWNER: 'owner',
};

// --- Проверки ---
function requireConfig() {
    const missing = [];
    if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'change-me-in-production') {
        missing.push('SESSION_SECRET');
    }
    if (!process.env.HCAPTCHA_SITE_KEY) missing.push('HCAPTCHA_SITE_KEY');
    if (!process.env.HCAPTCHA_SECRET_KEY) missing.push('HCAPTCHA_SECRET_KEY');
    if (!process.env.API_SHARED_SECRET) missing.push('API_SHARED_SECRET');
    if (missing.length > 0) {
        console.warn(`[WARN] Missing config: ${missing.join(', ')} — some features will be degraded.`);
    }
}

module.exports = {
    PORT,
    HOST,
    SSL_KEY_PATH,
    SSL_CERT_PATH,
    SESSION_SECRET,
    SESSION_MAX_AGE_MS,
    DOMAIN,
    HCAPTCHA_SITE_KEY,
    HCAPTCHA_SECRET_KEY,
    ENCRYPTION_KEYS,
    API_SHARED_SECRET,
    PBKDF2_ITERATIONS,
    PBKDF2_SALT_BYTES,
    PBKDF2_HASH_BITS,
    PBKDF2_PREFIX,
    MIN_PASSWORD_LENGTH,
    HWID_RESET_PERIOD_MONTHS,
    HWID_RESET_MAX,
    RATE_LIMIT,
    DB_PATH,
    ROLES,
    requireConfig,
};
