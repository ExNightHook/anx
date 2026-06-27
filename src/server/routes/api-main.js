// ============================================================
//  routes/api-main.js — API для C++ лоадера (/api/main/*).
//
//  Усиленная защита:
//    1. XOR-транспорт (обфускация — совместимость с текущим C++)
//    2. Поверх XOR — AES-256-GCM шифрование (enhanced mode)
//    3. HMAC-SHA256 чексуммы пакетов с timestamp + nonce (anti-replay)
//    4. API-сессии после авторизации
//
//  Протокол запроса (enhanced):
//    POST /api/main/auth — авторизация, возвращает sessionId
//    POST /api/main/register — получить статус подписки (legacy)
//    POST /api/main/build — получить информацию о билде
//
//  Тело запроса (binary):
//    [4B magic: "ANX1"][8B timestamp][8B nonce][32B hmac]
//    [remaining: XOR(AES-GCM(JSON payload))]
//  Либо (legacy — просто XOR):
//    [XOR(JSON payload)]
// ============================================================

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const {
    xorCrypt,
    aesEncrypt,
    aesDecrypt,
    computePacketHmac,
    verifyPacketHmac,
    createApiSession,
    getApiSession,
    destroyApiSession,
} = require('../lib/crypto');
const { getUserByUsername, getUserById, updateUser, getActiveBuild, syncLegacySub } = require('../lib/db');
const { checkPassword, hashPassword } = require('../lib/crypto');
const { ENCRYPTION_KEYS, RATE_LIMIT } = require('../lib/config');

// Rate limit по IP
const apiLimiter = rateLimit({
    windowMs: RATE_LIMIT.WINDOW_MS,
    max: RATE_LIMIT.MAX_ATTEMPTS,
    message: 'Too Many Requests',
    keyGenerator: (req) => req.ip || 'unknown',
});

// --- Утилиты ---

function makeEncryptedResponse(obj) {
    const json = JSON.stringify(obj);
    const encrypted = aesEncrypt(json);
    return Buffer.concat([xorCrypt(encrypted)]);
}

function makeLegacyEncryptedResponse(obj) {
    const json = JSON.stringify(obj);
    return xorCrypt(Buffer.from(json, 'utf-8'));
}

function makePlainErrorResponse(msg, status = 200) {
    return makeLegacyEncryptedResponse(msg);
}

// --- Парсинг запроса ---

function parseRequest(buf) {
    // Проверяем: enhanced (ANX1 magic) или legacy
    const MAGIC = Buffer.from('ANX1', 'ascii');

    if (buf.length > 52 && buf.subarray(0, 4).equals(MAGIC)) {
        // Enhanced формат
        const timestamp = buf.subarray(4, 12).toString('ascii');
        const nonce = buf.subarray(12, 20).toString('ascii');
        const hmacHex = buf.subarray(20, 52).toString('ascii');
        const payload = buf.subarray(52);

        // Верифицируем HMAC (anti-replay встроена)
        if (!verifyPacketHmac(payload.toString('hex'), timestamp, nonce, hmacHex)) {
            return { error: 'Invalid packet signature' };
        }

        // XOR -> AES-GCM -> JSON
        const afterXor = xorCrypt(payload);
        const decrypted = aesDecrypt(afterXor);
        if (!decrypted) {
            return { error: 'Decryption failed' };
        }

        try {
            return { data: JSON.parse(decrypted), enhanced: true };
        } catch {
            return { error: 'Invalid payload' };
        }
    } else {
        // Legacy формат: просто XOR -> JSON
        try {
            const decrypted = xorCrypt(buf);
            const json = decrypted.toString('utf-8');
            return { data: JSON.parse(json), enhanced: false };
        } catch {
            return { error: 'Invalid format' };
        }
    }
}

// --- Все POST запросы ---

router.post('/*', apiLimiter, (req, res) => {
    // Читаем сырые байты
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
        const buf = Buffer.concat(chunks);
        handleApiMain(req, res, buf);
    });
});

function handleApiMain(req, res, buf) {
    const path = req.path.replace('/api/main/', '');
    const parsed = parseRequest(buf);

    if (parsed.error) {
        res.set('Content-Type', 'application/octet-stream');
        return res.status(400).send(makeLegacyEncryptedResponse(parsed.error));
    }

    const { data, enhanced } = parsed;

    // Маршрутизация
    switch (path) {
        case 'auth':
            return handleAuth(req, res, data, enhanced);
        case 'register':
            return handleRegister(req, res, data, enhanced);
        case 'build':
            return handleBuild(req, res, data, enhanced);
        default:
            res.set('Content-Type', 'application/octet-stream');
            return res.send(makeLegacyEncryptedResponse('Unknown endpoint'));
    }
}

// --- /api/main/auth — авторизация с созданием сессии ---
function handleAuth(req, res, data, enhanced) {
    const { username, password, hwid } = data;

    if (!username || !password || !hwid) {
        res.set('Content-Type', 'application/octet-stream');
        return res.send(makeLegacyEncryptedResponse('Missing fields'));
    }

    const user = getUserByUsername(String(username));
    if (!user) {
        res.set('Content-Type', 'application/octet-stream');
        return res.send(makeLegacyEncryptedResponse('User not found'));
    }

    const { ok, needsRehash } = checkPassword(password, user.password);
    if (!ok) {
        res.set('Content-Type', 'application/octet-stream');
        return res.send(makeLegacyEncryptedResponse('Password mismatch'));
    }

    // HWID check
    if (user.hwid && user.hwid !== hwid) {
        res.set('Content-Type', 'application/octet-stream');
        return res.send(makeLegacyEncryptedResponse('HWID mismatch'));
    }

    // Set HWID on first login
    if (!user.hwid) {
        updateUser(user.id, { hwid });
    }

    // Rehash if needed
    if (needsRehash) {
        try {
            updateUser(user.id, { password: hashPassword(password) });
        } catch (e) {
            console.error('Rehash failed:', e.message);
        }
    }

    // Check blocked
    if (user.blocked) {
        const until = user.block_until ? new Date(user.block_until) : null;
        if (!until || until > new Date()) {
            res.set('Content-Type', 'application/octet-stream');
            return res.send(makeLegacyEncryptedResponse('Account blocked'));
        }
    }

    // Sync legacy sub fields
    syncLegacySub(user.id);
    const refreshed = getUserById(user.id);

    // Create session
    const sessionId = createApiSession(user.id, hwid);

    const responseData = {
        status: 'Success',
        session_id: sessionId,
        user: {
            id: user.id,
            name: user.username,
            subscription_type: refreshed.sub_type || 'None',
            subscription_status: refreshed.frozen === 1 ? 'Frozen' : (refreshed.sub_type ? 'Active' : 'Inactive'),
            expiry_date: refreshed.expiry_date ? formatDateApi(new Date(refreshed.expiry_date)) : 'N/A',
            current_date: formatDateApi(new Date()),
        },
    };

    res.set('Content-Type', 'application/octet-stream');
    if (enhanced) {
        res.send(makeEncryptedResponse(responseData));
    } else {
        res.send(makeLegacyEncryptedResponse(responseData));
    }
}

// --- /api/main/register — legacy совместимость (как в старом воркере) ---
function handleRegister(req, res, data, enhanced) {
    const { id, password, hwid } = data;

    // Поддерживаем как username/id так и числовой id
    let user;
    if (typeof id === 'number' || /^\d+$/.test(String(id))) {
        user = getUserById(parseInt(id, 10));
    } else {
        user = getUserByUsername(String(id));
    }

    if (!user) {
        res.set('Content-Type', 'application/octet-stream');
        return res.send(makeLegacyEncryptedResponse('User not found'));
    }

    const { ok, needsRehash } = checkPassword(password, user.password);
    if (!ok) {
        res.set('Content-Type', 'application/octet-stream');
        return res.send(makeLegacyEncryptedResponse('Password mismatch'));
    }

    if (user.hwid && user.hwid !== hwid) {
        res.set('Content-Type', 'application/octet-stream');
        return res.send(makeLegacyEncryptedResponse('HWID mismatch'));
    }

    if (!user.hwid) {
        updateUser(user.id, { hwid });
    }

    if (needsRehash) {
        try { updateUser(user.id, { password: hashPassword(password) }); } catch {}
    }

    if (user.blocked) {
        res.set('Content-Type', 'application/octet-stream');
        return res.send(makeLegacyEncryptedResponse('Account blocked'));
    }

    syncLegacySub(user.id);
    const refreshed = getUserById(user.id);

    const responseData = {
        status: 'Success',
        id: user.id,
        name: user.username,
        subscription_type: refreshed.sub_type || 'None',
        subscription_status: refreshed.frozen === 1 ? 'Frozen' : (refreshed.sub_type ? 'Active' : 'Inactive'),
        current_date: formatDateApi(new Date()),
        expiry_date: refreshed.expiry_date ? formatDateApi(new Date(refreshed.expiry_date)) : 'N/A',
    };

    res.set('Content-Type', 'application/octet-stream');
    if (enhanced) {
        res.send(makeEncryptedResponse(responseData));
    } else {
        res.send(makeLegacyEncryptedResponse(responseData));
    }
}

// --- /api/main/build ---
function handleBuild(req, res, data, enhanced) {
    // Проверяем session_id если пришёл, иначе username/password для legacy
    const sessionId = data.session_id;
    let user = null;

    if (sessionId) {
        const session = getApiSession(sessionId);
        if (!session) {
            res.set('Content-Type', 'application/octet-stream');
            return res.send(makeLegacyEncryptedResponse('Session expired'));
        }
        user = getUserById(session.userId);
    } else if (data.id && data.password && data.hwid) {
        // Legacy auth inline
        const username = data.id;
        const u = typeof username === 'number' || /^\d+$/.test(String(username))
            ? getUserById(parseInt(username, 10))
            : getUserByUsername(String(username));
        if (!u) {
            res.set('Content-Type', 'application/octet-stream');
            return res.send(makeLegacyEncryptedResponse('User not found'));
        }
        const { ok } = checkPassword(data.password, u.password);
        if (!ok) {
            res.set('Content-Type', 'application/octet-stream');
            return res.send(makeLegacyEncryptedResponse('Password mismatch'));
        }
        if (u.hwid && u.hwid !== data.hwid) {
            res.set('Content-Type', 'application/octet-stream');
            return res.send(makeLegacyEncryptedResponse('HWID mismatch'));
        }
        user = u;
    }

    if (!user) {
        res.set('Content-Type', 'application/octet-stream');
        return res.send(makeLegacyEncryptedResponse('Auth required'));
    }

    if (user.blocked) {
        res.set('Content-Type', 'application/octet-stream');
        return res.send(makeLegacyEncryptedResponse('Account blocked'));
    }

    const productId = data.product_id || null;
    const build = getActiveBuild(productId);

    if (!build) {
        res.set('Content-Type', 'application/octet-stream');
        return res.send(makeLegacyEncryptedResponse('No active build found'));
    }

    const responseData = {
        status: 'Success',
        build_id: build.version,
        build_hash: build.hash,
    };

    res.set('Content-Type', 'application/octet-stream');
    if (enhanced) {
        res.send(makeEncryptedResponse(responseData));
    } else {
        res.send(makeLegacyEncryptedResponse(responseData));
    }
}

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function formatDateApi(d) {
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

module.exports = router;
