# 

Полноценный сайт, панель управления и API для лоадера.

## Архитектура

```
 (HTTPS, nginx reverse proxy)
├── /                  → Главная страница (EJS)
├── /products         → Каталог товаров
├── /product/:slug     → Страница товара
├── /auth              → Вход / Регистрация (hCaptcha)
├── /profile           → Профиль (подписки, HWID, баланс)
├── /profile/balance   → Пополнение баланса (заглушка)
├── /terms             → Договор оферты
├── /privacy           → Политика конфиденциальности
├── /api/main/auth     → API: авторизация лоадера
├── /api/main/register → API: статус подписки (legacy)
├── /api/main/build    → API: информация о билде
└── /api/panel/*       → Панель администратора
```

## Технологии

- **Backend:** Node.js, Express, better-sqlite3
- **Frontend:** EJS templates, vanilla CSS/JS (тёмная тема)
- **API:** XOR-транспорт + AES-256-GCM + HMAC-SHA256 + сессии
- **Deploy:** nginx, Let's Encrypt, PM2
- **C++ Client:** WinHTTP + BCrypt (AES-GCM, HMAC-SHA256)

## Роли

| Роль | Права |
|------|-------|
| `user` | Просмотр товаров, покупка подписок, сброс HWID (1/мес), заморозка/разморозка |
| `admin` | + Управление пользователями (добавление дней, блок/разблок), заморозка продуктов |
| `owner` | + Добавление/редактирование/удаление товаров, управление ценами и билдами |

## Развёртывание на VPS (Ubuntu 26.04)

### 1. Подготовка

1. Залейте проект на GitHub
2. Обновите `REPO_URL` в `deploy.sh`
3. Зарегистрируйтесь на [hcaptcha.com](https://www.hcaptcha.com) и получите ключи
4. Настройте DNS: `A-запись aesthesia.xyz → IP вашего VPS`

### 2. SSH на сервер и запуск

```bash
chmod +x deploy.sh
./deploy.sh
```

Скрипт автоматически:
- Обновит систему и установит Node.js 22 LTS, nginx, PM2
- Проверит DNS запись домена
- Получит SSL сертификат через Let's Encrypt
- Создаст nginx конфиг в `/etc/nginx/sites-available/aesthesia.xyz`
- Сгенерирует `.env` с секретами
- Запустит приложение через PM2
- Настроит автозапуск и автообновление SSL

### 3. После деплоя

Отредактируйте `/opt/anxiety/.env`:

```env
HCAPTCHA_SITE_KEY=your_site_key
HCAPTCHA_SECRET_KEY=your_secret_key
```

Перезапустите: `pm2 restart anxiety`

## Локальная разработка

```bash
npm install
cp .env.example .env
# заполните .env
node src/server/index.js
```

Сервер запустится на `http://localhost:3000`.

## API лоадера

### Протокол (Enhanced)

```
POST /api/main/auth
Body (binary):
  [4B "ANX1"][8B timestamp][8B nonce][32B hmac_hex]
  [XOR(AES-256-GCM(JSON))]
```

Ответ: `XOR(AES-256-GCM(JSON))` или `XOR(JSON)` для legacy.

### Legacy совместимость

Старый формат (просто XOR JSON) также поддерживается для обратной совместимости с текущим C++ лоадером.

## Структура проекта

```
├── deploy.sh              # Скрипт развёртывания
├── package.json
├── .env.example
├── .gitignore
├── ssl/                   # SSL сертификаты (не в git)
├── data/                  # SQLite БД (не в git)
├── src/
│   ├── server/
│   │   ├── index.js       # Точка входа Express
│   │   ├── lib/
│   │   │   ├── config.js  # Конфигурация
│   │   │   ├── db.js      # SQLite схема + запросы
│   │   │   ├── crypto.js  # XOR, AES-256-GCM, HMAC, PBKDF2
│   │   │   └── helpers.js # Утилиты форматирования
│   │   ├── middleware/
│   │   │   ├── auth.js    # Проверка сессий
│   │   │   └── hcaptcha.js
│   │   ├── routes/
│   │   │   ├── pages.js   # Веб-страницы
│   │   │   ├── auth.js    # Вход/регистрация
│   │   │   ├── profile.js # Профиль
│   │   │   ├── api-main.js  # API для лоадера
│   │   │   └── api-panel.js # Панель администратора
│   │   ├── views/         # EJS шаблоны
│   │   └── public/        # CSS, JS, изображения
│   └── loader-client/
│       ├── MPHClient.h    # C++ API клиент (enhanced)
│       ├── loader.h       # Заголовок лоадера
│       ├── hwid.h / hwid.cpp  # HWID генерация
│       └── anxiety_loader.cpp # Точка входа
```
