// ============================================================
//  middleware/auth.js — Проверка сессии пользователя.
// ============================================================

function requireAuth(req, res, next) {
    if (!req.session || !req.session.userId) {
        return res.redirect('/auth?redirect=' + encodeURIComponent(req.originalUrl));
    }
    next();
}

function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.session || !req.session.userId) {
            return res.redirect('/auth?redirect=' + encodeURIComponent(req.originalUrl));
        }
        if (!roles.includes(req.session.role)) {
            return res.status(403).send('Доступ запрещён');
        }
        next();
    };
}

function requireAdmin(req, res, next) {
    return requireRole('admin', 'owner')(req, res, next);
}

function requireOwner(req, res, next) {
    return requireRole('owner')(req, res, next);
}

function requireNotBlocked(req, res, next) {
    if (req.session && req.session.blocked) {
        return res.status(403).send('Ваш аккаунт заблокирован: ' + (req.session.blockReason || ''));
    }
    next();
}

function optionalAuth(req, res, next) {
    // Подгружает пользователя в req.user если залогинен, но не редиректит
    if (req.session && req.session.userId) {
        const { getUserById } = require('../lib/db');
        const user = getUserById(req.session.userId);
        if (user) {
            req.user = user;
        }
    }
    next();
}

module.exports = {
    requireAuth,
    requireRole,
    requireAdmin,
    requireOwner,
    requireNotBlocked,
    optionalAuth,
};
