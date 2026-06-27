// ============================================================
//  routes/pages.js — Веб-страницы сайта.
//  Главная, товары, оферта, политика, контакты.
// ============================================================

const express = require('express');
const router = express.Router();
const { optionalAuth } = require('../middleware/auth');
const { getAllProducts, getProductBySlug, getProductPrices } = require('../lib/db');
const { formatDateRu, escapeHtml, formatPrice, daysRemaining } = require('../lib/helpers');

// --- Главная страница ---
router.get('/', optionalAuth, (req, res) => {
    const products = getAllProducts(false);
    res.render('index', {
        user: req.user || null,
        products,
        formatDateRu,
        formatPrice,
        daysRemaining,
        escapeHtml,
    });
});

// --- Страница товара ---
router.get('/product/:slug', optionalAuth, (req, res) => {
    const product = getProductBySlug(req.params.slug);
    if (!product) {
        return res.status(404).render('error', { code: 404, message: 'Товар не найден', user: req.user || null });
    }
    const prices = getProductPrices(product.id);
    res.render('product', {
        user: req.user || null,
        product,
        prices,
        formatPrice,
        escapeHtml,
    });
});

// --- Все товары ---
router.get('/products', optionalAuth, (req, res) => {
    const products = getAllProducts(false);
    res.render('products', {
        user: req.user || null,
        products,
        formatPrice,
        escapeHtml,
    });
});

// --- Договор оферты ---
router.get('/terms', optionalAuth, (req, res) => {
    res.render('legal', {
        user: req.user || null,
        page: 'terms',
        title: 'Договор оферты',
    });
});

// --- Политика конфиденциальности ---
router.get('/privacy', optionalAuth, (req, res) => {
    res.render('legal', {
        user: req.user || null,
        page: 'privacy',
        title: 'Политика конфиденциальности',
    });
});

module.exports = router;
