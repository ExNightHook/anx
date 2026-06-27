// ============================================================
//  index.js — Точка входа сервера Anxiety (aesthesia.xyz).
//
//  HTTP -> Express (порт 3000, за nginx reverse-proxy)
//  HTTPS -> Express (порт 443, если запускается без nginx)
//
//  Нормально работает за nginx reverse proxy на 80/443.
// ============================================================

const express = require('express');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const cookieParser = require('cookie-parser');
const cron = require('node-cron');

const {
    PORT, HOST, SSL_KEY_PATH, SSL_CERT_PATH,
    SESSION_SECRET, SESSION_MAX_AGE_MS, DOMAIN, HCAPTCHA_SITE_KEY,
    requireConfig,
} = require('./lib/config');
const { expireOldSubscriptions } = require('./lib/db');
const { requireAuth } = require('./middleware/auth');

requireConfig();

const app = express();
const viewDir = path.join(__dirname, 'views');
const publicDir = path.join(__dirname, 'public');

// ============================================================
//  Middleware
// ============================================================

app.set('view engine', 'ejs');
app.set('views', viewDir);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Сессии (in-memory cookie store — достаточно для начала)
const session = require('express-session');
const MemoryStore = require('express-session').MemoryStore;
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: SESSION_MAX_AGE_MS,
        httpOnly: true,
        secure: false, // true если за HTTPS proxy
        sameSite: 'lax',
    },
    store: new MemoryStore(),
}));

// Статические файлы
app.use(express.static(publicDir));

// Flash messages
app.use((req, res, next) => {
    res.locals.flash = req.session.flash || {};
    req.session.flash = {};
    next();
});

// Локальные переменные для всех шаблонов
app.use((req, res, next) => {
    res.locals.user = null;
    res.locals.DOMAIN = DOMAIN;
    res.locals.HCAPTCHA_SITE_KEY = HCAPTCHA_SITE_KEY;
    res.locals.currentPath = req.path;

    if (req.session && req.session.userId) {
        const { getUserById } = require('./lib/db');
        const user = getUserById(req.session.userId);
        if (user) {
            res.locals.user = user;
        } else {
            // Session refers to deleted user — destroy
            req.session.destroy();
        }
    }
    next();
});

// ============================================================
//  Routes
// ============================================================

const pagesRouter = require('./routes/pages');
const authRouter = require('./routes/auth');
const profileRouter = require('./routes/profile');
const apiMainRouter = require('./routes/api-main');
const apiPanelRouter = require('./routes/api-panel');

app.use('/', pagesRouter);
app.use('/auth', authRouter);
app.use('/profile', profileRouter);
app.use('/api/main', apiMainRouter);
app.use('/api/panel', apiPanelRouter);

// 404
app.use((req, res) => {
    res.status(404).render('error', {
        code: 404,
        message: 'Страница не найдена',
        user: res.locals.user,
    });
});

// 500
app.use((err, req, res, _next) => {
    console.error('Server error:', err);
    res.status(500).render('error', {
        code: 500,
        message: 'Внутренняя ошибка сервера',
        user: res.locals.user,
    });
});

// ============================================================
//  Cron — очистка истёкших подписок каждую минуту
// ============================================================

cron.schedule('* * * * *', () => {
    try {
        expireOldSubscriptions();
    } catch (e) {
        console.error('Cron error:', e.message);
    }
});

// ============================================================
//  Start
// ============================================================

// Создаём data директорию
const dataDir = path.join(__dirname, '../../data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

// Проверяем SSL и запускаем
const useHttps = fs.existsSync(SSL_KEY_PATH) && fs.existsSync(SSL_CERT_PATH);

if (useHttps) {
    const sslOptions = {
        key: fs.readFileSync(SSL_KEY_PATH),
        cert: fs.readFileSync(SSL_CERT_PATH),
    };
    https.createServer(sslOptions, app).listen(PORT, HOST, () => {
        console.log(`[Anxiety] HTTPS server running on https://${DOMAIN}:${PORT}`);
    });
} else {
    // Запуск только HTTP (для nginx reverse proxy)
    const httpPort = process.env.HTTP_PORT || 3000;
    http.createServer(app).listen(httpPort, HOST, () => {
        console.log(`[Anxiety] HTTP server running on http://${HOST}:${httpPort}`);
        console.log(`[Anxiety] SSL not found — running behind nginx recommended`);
    });
}

module.exports = app;
