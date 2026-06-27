// ============================================================
//  routes/auth.js — Страница авторизации + POST login/register.
// ============================================================

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const {
    getUserByUsername,
    getUserByEmail,
    createUser,
    updateUser,
    getUserById,
} = require('../lib/db');
const { checkPassword, hashPassword, generateResetToken } = require('../lib/crypto');
const { requireCaptcha } = require('../middleware/hcaptcha');
const { requireAuth, requireNotBlocked } = require('../middleware/auth');
const { isValidEmail, isValidUsername, escapeHtml } = require('../lib/helpers');
const { MIN_PASSWORD_LENGTH } = require('../lib/config');

// Rate limit на попытки логина
const loginLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    message: { error: 'Слишком много попыток. Подождите минуту.' },
    keyGenerator: (req) => req.ip || 'unknown',
});

// --- GET /auth — форма входа/регистрации ---
router.get('/', (req, res) => {
    const redirect = req.query.redirect || '/profile';
    const error = req.query.error || '';
    const success = req.query.success || '';
    const mode = req.query.mode || 'login';
    res.render('auth', {
        error: escapeHtml(error),
        success: escapeHtml(success),
        redirect: escapeHtml(redirect),
        mode,
        user: null,
    });
});

// --- POST /auth/login ---
router.post('/login', loginLimiter, requireCaptcha, async (req, res) => {
    const { username, password, redirect: redirectTo } = req.body;
    if (!username || !password) {
        return res.redirect('/auth?error=' + encodeURIComponent('Заполните все поля'));
    }

    const user = getUserByUsername(username);
    if (!user) {
        return res.redirect('/auth?error=' + encodeURIComponent('Пользователь не найден'));
    }

    const { ok, needsRehash } = checkPassword(password, user.password);
    if (!ok) {
        return res.redirect('/auth?error=' + encodeURIComponent('Неверный пароль'));
    }

    // Lazy rehash
    if (needsRehash) {
        const hashed = hashPassword(password);
        updateUser(user.id, { password: hashed });
    }

    // Check blocked
    if (user.blocked) {
        const until = user.block_until ? new Date(user.block_until) : null;
        if (!until || until > new Date()) {
            const reason = user.block_reason || 'Блокировка аккаунта';
            return res.redirect('/auth?error=' + encodeURIComponent('Аккаунт заблокирован: ' + reason));
        } else {
            // Block expired
            updateUser(user.id, { blocked: 0, block_reason: null, block_until: null });
        }
    }

    // Create session
    req.session.userId = user.id;
    req.session.role = user.role;
    req.session.username = user.username;
    req.session.createdAt = Date.now();

    const target = redirectTo && redirectTo.startsWith('/') ? redirectTo : '/profile';
    res.redirect(target);
});

// --- POST /auth/register ---
router.post('/register', loginLimiter, requireCaptcha, async (req, res) => {
    const { username, email, password, password2 } = req.body;

    if (!username || !email || !password || !password2) {
        return res.redirect('/auth?mode=register&error=' + encodeURIComponent('Заполните все поля'));
    }

    if (!isValidUsername(username)) {
        return res.redirect('/auth?mode=register&error=' + encodeURIComponent('Никнейм: 3-32 символа, латиница, цифры, _'));
    }

    if (!isValidEmail(email)) {
        return res.redirect('/auth?mode=register&error=' + encodeURIComponent('Некорректный email'));
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
        return res.redirect('/auth?mode=register&error=' + encodeURIComponent(`Пароль минимум ${MIN_PASSWORD_LENGTH} символов`));
    }

    if (password !== password2) {
        return res.redirect('/auth?mode=register&error=' + encodeURIComponent('Пароли не совпадают'));
    }

    if (getUserByUsername(username)) {
        return res.redirect('/auth?mode=register&error=' + encodeURIComponent('Никнейм уже занят'));
    }

    if (getUserByEmail(email)) {
        return res.redirect('/auth?mode=register&error=' + encodeURIComponent('Email уже зарегистрирован'));
    }

    const hashed = hashPassword(password);
    createUser({ username, password: hashed, email });

    // Auto-login
    const user = getUserByUsername(username);
    req.session.userId = user.id;
    req.session.role = user.role;
    req.session.username = user.username;
    req.session.createdAt = Date.now();

    res.redirect('/auth?success=' + encodeURIComponent('Регистрация успешна!'));
});

// --- POST /auth/logout ---
router.post('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/');
    });
});

// --- GET /auth/reset-password — сброс пароля ---
router.get('/reset-password', (req, res) => {
    const token = req.query.token || '';
    const error = req.query.error || '';
    const success = req.query.success || '';
    res.render('reset-password', {
        token,
        error: escapeHtml(error),
        success: escapeHtml(success),
        user: null,
    });
});

router.post('/reset-password/request', loginLimiter, requireCaptcha, (req, res) => {
    const { email } = req.body;
    if (!email) {
        return res.redirect('/auth/reset-password?error=' + encodeURIComponent('Укажите email'));
    }
    const user = getUserByEmail(email);
    if (user) {
        const token = generateResetToken();
        updateUser(user.id, {
            password_reset_token: token,
            password_reset_expires: new Date(Date.now() + 3600000).toISOString(), // 1 час
        });
        // TODO: отправить email с токеном
        // Пока — редиректим с сообщением
    }
    res.redirect('/auth/reset-password?success=' + encodeURIComponent('Если аккаунт существует, ссылка отправлена на email'));
});

router.post('/reset-password/confirm', (req, res) => {
    const { token, password, password2 } = req.body;
    if (!token || !password || !password2) {
        return res.redirect('/auth/reset-password?error=' + encodeURIComponent('Заполните все поля') + '&token=' + encodeURIComponent(token));
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
        return res.redirect('/auth/reset-password?error=' + encodeURIComponent(`Пароль минимум ${MIN_PASSWORD_LENGTH} символов`) + '&token=' + encodeURIComponent(token));
    }
    if (password !== password2) {
        return res.redirect('/auth/reset-password?error=' + encodeURIComponent('Пароли не совпадают') + '&token=' + encodeURIComponent(token));
    }

    const user = require('../lib/db').getUserByResetToken(token);
    if (!user) {
        return res.redirect('/auth/reset-password?error=' + encodeURIComponent('Ссылка недействительна'));
    }
    if (new Date(user.password_reset_expires) < new Date()) {
        updateUser(user.id, { password_reset_token: null, password_reset_expires: null });
        return res.redirect('/auth/reset-password?error=' + encodeURIComponent('Ссылка истекла'));
    }

    const hashed = hashPassword(password);
    updateUser(user.id, {
        password: hashed,
        password_reset_token: null,
        password_reset_expires: null,
        password_reset_count: (user.password_reset_count || 0) + 1,
        last_password_reset: new Date().toISOString(),
    });
    res.redirect('/auth?success=' + encodeURIComponent('Пароль успешно изменён'));
});

module.exports = router;
