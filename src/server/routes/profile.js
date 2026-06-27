// ============================================================
//  routes/profile.js — Профиль пользователя.
//  Управление подписками, сброс HWID, заморозка, баланс.
// ============================================================

const express = require('express');
const router = express.Router();
const { requireAuth, requireNotBlocked } = require('../middleware/auth');
const {
    getUserById,
    getUserSubscriptions,
    getActiveUserSubscriptions,
    updateUser,
    freezeUserSubscription,
    unfreezeUserSubscription,
    canFreezeSubscription,
    getPaymentHistory,
    syncLegacySub,
    getProductPrices,
} = require('../lib/db');
const { formatDateRu, formatDateRuFull, daysRemaining, formatPrice, escapeHtml } = require('../lib/helpers');
const { HWID_RESET_PERIOD_MONTHS, HWID_RESET_MAX, DOMAIN } = require('../lib/config');

// --- GET /profile ---
router.get('/', requireAuth, requireNotBlocked, (req, res) => {
    const user = getUserById(req.session.userId);
    if (!user) return res.redirect('/auth');

    const subscriptions = getUserSubscriptions(user.id);
    const activeSubs = getActiveUserSubscriptions(user.id);
    const payments = getPaymentHistory(user.id);

    // HWID reset availability
    const canResetHwid = checkHwidReset(user);

    res.render('profile', {
        user,
        subscriptions,
        activeSubs,
        payments,
        canResetHwid,
        formatDateRu,
        formatDateRuFull,
        daysRemaining,
        formatPrice,
        escapeHtml,
        DOMAIN,
    });
});

// --- POST /profile/hwid-reset ---
router.post('/hwid-reset', requireAuth, requireNotBlocked, (req, res) => {
    const user = getUserById(req.session.userId);
    if (!user) return res.redirect('/auth');

    if (!checkHwidReset(user)) {
        req.session.flash = { error: 'Сброс HWID недоступен. Можно 1 раз в ' + HWID_RESET_PERIOD_MONTHS + ' мес.' };
        return res.redirect('/profile');
    }

    updateUser(user.id, {
        hwid: null,
        last_hwid_reset: new Date().toISOString(),
    });

    req.session.flash = { success: 'HWID успешно сброшен' };
    res.redirect('/profile');
});

// --- POST /profile/freeze/:subId ---
router.post('/freeze/:subId', requireAuth, requireNotBlocked, (req, res) => {
    const subId = parseInt(req.params.subId, 10);
    const user = getUserById(req.session.userId);
    if (!user) return res.redirect('/auth');

    if (!canFreezeSubscription(subId)) {
        req.session.flash = { error: 'Заморозка недоступна для этой подписки' };
        return res.redirect('/profile');
    }

    freezeUserSubscription(subId);
    syncLegacySub(user.id);
    req.session.flash = { success: 'Подписка заморожена. Время компенсируется при разморозке.' };
    res.redirect('/profile');
});

// --- POST /profile/unfreeze/:subId ---
router.post('/unfreeze/:subId', requireAuth, requireNotBlocked, (req, res) => {
    const subId = parseInt(req.params.subId, 10);
    const user = getUserById(req.session.userId);
    if (!user) return res.redirect('/auth');

    const ok = unfreezeUserSubscription(subId);
    if (!ok) {
        req.session.flash = { error: 'Не удалось разморозить подписку' };
        return res.redirect('/profile');
    }

    syncLegacySub(user.id);
    req.session.flash = { success: 'Подписка разморожена. Компенсация дней применена.' };
    res.redirect('/profile');
});

// --- GET /profile/balance — Пополнение баланса ---
router.get('/balance', requireAuth, requireNotBlocked, (req, res) => {
    const user = getUserById(req.session.userId);
    if (!user) return res.redirect('/auth');
    res.render('balance', {
        user,
        formatPrice,
        escapeHtml,
    });
});

// --- POST /profile/balance — Заглушка оплаты ---
router.post('/balance/topup', requireAuth, requireNotBlocked, (req, res) => {
    req.session.flash = { error: 'Пополнение баланса временно недоступно. Следите за обновлениями.' };
    res.redirect('/profile/balance');
});

function checkHwidReset(user) {
    if (!user.last_hwid_reset) return true;
    const lastReset = new Date(user.last_hwid_reset);
    const now = new Date();
    const diffMonths = (now.getFullYear() - lastReset.getFullYear()) * 12 + (now.getMonth() - lastReset.getMonth());
    return diffMonths >= HWID_RESET_PERIOD_MONTHS;
}

module.exports = router;
