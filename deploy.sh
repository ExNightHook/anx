#!/bin/bash
# ============================================================
#  deploy.sh — Автоматическое развёртывание Anxiety на VPS.
#
#  Ubuntu 26.04 LTS, Node.js 22 LTS, nginx, Let's Encrypt SSL.
#
#  Использование:
#    1) Залейте проект на GitHub (публичный или приватный)
#    2) SSH на VPS
#    3) chmod +x deploy.sh && ./deploy.sh
#
#  Скрипт:
#    - Обновляет систему
#    - Ставит Node.js 22 LTS
#    - Клонирует проект с GitHub
#    - Проверяет DNS запись домена
#    - Генерирует SSL через certbot (если ещё нет)
#    - Создаёт/проверяет nginx конфиг в /etc/nginx/sites-available
#    - Создаёт .env с генерацией секретов
#    - Ставит зависимости, собирает
#    - Запускает через PM2
# ============================================================

set -euo pipefail

# --- Конфигурация ---
DOMAIN="aesthesia.xyz"
REPO_URL="https://github.com/YOUR_USERNAME/anxiety-aesthesia.git"  # ЗАМЕНИТЕ!
INSTALL_DIR="/opt/anxiety"
NODE_VERSION="22"
APP_PORT="3000"

# --- Цвета ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info()  { echo -e "${BLUE}[INFO]${NC} $1"; }
log_ok()    { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# ============================================================
#  1. Обновление системы
# ============================================================
log_info "Обновление системы..."
apt-get update -qq && apt-get upgrade -y -qq
log_ok "Система обновлена"

# ============================================================
#  2. Установка базовых зависимостей
# ============================================================
log_info "Установка базовых пакетов..."
apt-get install -y -qq \
    curl wget git unzip build-essential \
    nginx certbot python3-certbot-nginx \
    software-properties-common > /dev/null 2>&1
log_ok "Базовые пакеты установлены"

# ============================================================
#  3. Node.js 22 LTS
# ============================================================
if ! command -v node &>/dev/null || [[ "$(node -v | cut -d'.' -f1 | tr -d 'v')" -lt "$NODE_VERSION" ]]; then
    log_info "Установка Node.js ${NODE_VERSION} LTS..."
    curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - > /dev/null 2>&1
    apt-get install -y -qq nodejs > /dev/null 2>&1
    log_ok "Node.js $(node -v) установлен"
else
    log_ok "Node.js $(node -v) уже установлен"
fi

# ============================================================
#  4. PM2 (процесс-менеджер)
# ============================================================
if ! command -v pm2 &>/dev/null; then
    log_info "Установка PM2..."
    npm install -g pm2 > /dev/null 2>&1
    log_ok "PM2 установлен"
else
    log_ok "PM2 уже установлен"
fi

# ============================================================
#  5. Клонирование / обновление проекта
# ============================================================
if [[ -d "$INSTALL_DIR/.git" ]]; then
    log_info "Обновление проекта из Git..."
    cd "$INSTALL_DIR"
    git pull origin main 2>/dev/null || git pull origin master 2>/dev/null || true
else
    log_info "Клонирование проекта..."
    if [[ -d "$INSTALL_DIR" ]]; then
        mv "$INSTALL_DIR" "${INSTALL_DIR}.bak.$(date +%s)"
    fi
    git clone "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi
log_ok "Проект в $INSTALL_DIR"

# ============================================================
#  6. Установка Node.js зависимостей
# ============================================================
log_info "Установка npm-зависимостей..."
cd "$INSTALL_DIR"
npm install --production 2>&1 | tail -1
log_ok "Зависимости установлены"

# ============================================================
#  7. Создание .env если отсутствует
# ============================================================
if [[ ! -f "$INSTALL_DIR/.env" ]]; then
    log_info "Генерация .env..."

    # Генерируем секреты
    SESSION_SECRET=$(openssl rand -hex 32)
    WEBHOOK_SECRET=$(openssl rand -hex 32)
    API_SHARED_SECRET=$(openssl rand -hex 32)

    cat > "$INSTALL_DIR/.env" << ENVEOF
# Anxiety — Auto-generated .env
DOMAIN=${DOMAIN}
PORT=${APP_PORT}
HTTP_PORT=${APP_PORT}

SESSION_SECRET=${SESSION_SECRET}
API_SHARED_SECRET=${API_SHARED_SECRET}

# hCaptcha — заполните после регистрации на hcaptcha.com
HCAPTCHA_SITE_KEY=
HCAPTCHA_SECRET_KEY=

# XOR ключи (совпадают с C++ клиентом)
ENCRYPTION_KEYS=0x5A,0x5A,0x5A,0x7C,0x0A,0x7C,0x0A,0x3A

# БД
DB_PATH=./data/anxiety.db
ENVEOF

    log_warn ".env создан. Отредактируйте HCAPTCHA_SITE_KEY и HCAPTCHA_SECRET_KEY!"
else
    log_ok ".env уже существует"
fi

# ============================================================
#  8. Проверка DNS домена
# ============================================================
log_info "Проверка DNS для ${DOMAIN}..."

SERVER_IP=$(curl -4 -s --max-time 5 ifconfig.me 2>/dev/null || echo "")
if [[ -z "$SERVER_IP" ]]; then
    log_warn "Не удалось определить IP сервера"
    DNS_IP=""
else
    log_info "IP сервера: ${SERVER_IP}"
    DNS_IP=$(dig +short "${DOMAIN}" A 2>/dev/null | head -1 || echo "")
    if [[ -n "$DNS_IP" ]]; then
        if [[ "$DNS_IP" == "$SERVER_IP" ]]; then
            log_ok "DNS запись ${DOMAIN} -> ${SERVER_IP} корректна"
        else
            log_warn "DNS: ${DOMAIN} -> ${DNS_IP}, но сервер IP: ${SERVER_IP}. Проверьте DNS!"
        fi
    else
        log_warn "DNS запись для ${DOMAIN} не найдена. Добавьте A-запись -> ${SERVER_IP}"
    fi
fi

# ============================================================
#  9. SSL сертификат (Let's Encrypt)
# ============================================================
SSL_KEY="$INSTALL_DIR/ssl/${DOMAIN}.key"
SSL_CERT="$INSTALL_DIR/ssl/${DOMAIN}.crt"

mkdir -p "$INSTALL_DIR/ssl"

if [[ -f "$SSL_CERT" && -f "$SSL_KEY" ]]; then
    log_ok "SSL сертификат уже существует"
else
    # Проверяем есть ли уже сертификат от certbot
    CERTBOT_LIVE="/etc/letsencrypt/live/${DOMAIN}"
    if [[ -d "$CERTBOT_LIVE" ]]; then
        log_ok "Let's Encrypt сертификат уже активен"
        # Делаем симлинки
        ln -sf "${CERTBOT_LIVE}/privkey.pem" "$SSL_KEY"
        ln -sf "${CERTBOT_LIVE}/fullchain.pem" "$SSL_CERT"
    else
        log_info "Получение SSL сертификата через certbot..."
        # Сначала поднимаем nginx с HTTP чтобы certbot прошёл проверку
        cat > "/etc/nginx/sites-available/${DOMAIN}" << 'NGINXHTTP'
server {
    listen 80;
    server_name DOMAIN_PLACEHOLDER;
    location / {
        proxy_pass http://127.0.0.1:PORT_PLACEHOLDER;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
NGINXHTTP

        sed -i "s/DOMAIN_PLACEHOLDER/${DOMAIN}/g" "/etc/nginx/sites-available/${DOMAIN}"
        sed -i "s/PORT_PLACEHOLDER/${APP_PORT}/g" "/etc/nginx/sites-available/${DOMAIN}"

        # Enable site
        ln -sf "/etc/nginx/sites-available/${DOMAIN}" "/etc/nginx/sites-enabled/${DOMAIN}"

        # Remove default if conflicts
        if [[ -f "/etc/nginx/sites-enabled/default" ]]; then
            rm -f "/etc/nginx/sites-enabled/default"
        fi

        nginx -t && systemctl reload nginx
        log_info "Nginx HTTP временно запущен для certbot..."

        # Запускаем приложение перед certbot
        cd "$INSTALL_DIR"
        pm2 delete anxiety 2>/dev/null || true
        pm2 start "node src/server/index.js" --name anxiety --env production 2>/dev/null || true
        sleep 2

        certbot --nginx -d "${DOMAIN}" --non-interactive --agree-tos --email admin@${DOMAIN} --redirect 2>&1 || {
            log_error "Certbot не смог получить сертификат. Попробуйте позже вручную."
            log_info "Убедитесь что DNS запись ${DOMAIN} указывает на IP сервера (${SERVER_IP})"
        }

        # Копируем сертификаты
        if [[ -d "$CERTBOT_LIVE" ]]; then
            ln -sf "${CERTBOT_LIVE}/privkey.pem" "$SSL_KEY"
            ln -sf "${CERTBOT_LIVE}/fullchain.pem" "$SSL_CERT"
            log_ok "SSL сертификат получен и привязан"
        fi
    fi
fi

# ============================================================
#  10. Nginx конфиг (полный с SSL)
# ============================================================
log_info "Настройка nginx конфигурации..."

NGINX_CONF="/etc/nginx/sites-available/${DOMAIN}"

if [[ -f "$SSL_CERT" && -f "$SSL_KEY" ]]; then
    cat > "$NGINX_CONF" << NGINXHTTPS
# Anxiety — ${DOMAIN}
# Auto-generated by deploy.sh

# HTTP -> HTTPS redirect
server {
    listen 80;
    server_name ${DOMAIN};
    
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }
    
    location / {
        return 301 https://\$host\$request_uri;
    }
}

# HTTPS
server {
    listen 443 ssl http2;
    server_name ${DOMAIN};

    ssl_certificate ${SSL_CERT};
    ssl_certificate_key ${SSL_KEY};

    # SSL hardening
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;
    ssl_session_tickets off;

    # Security headers
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
    add_header X-Content-Type-Options nosniff;
    add_header X-Frame-Options DENY;
    add_header Referrer-Policy strict-origin-when-cross-origin;

    # Rate limiting
    limit_req_zone \$binary_remote_addr zone=api:10m rate=30r/m;
    limit_req_zone \$binary_remote_addr zone=general:10m rate=60r/m;

    client_max_body_size 10M;

    # Main site
    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }

    # Loader API — stricter rate limit
    location /api/main/ {
        limit_req zone=api burst=5 nodelay;
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 30s;
    }
}
NGINXHTTPS
else
    # Только HTTP
    cat > "$NGINX_CONF" << NGINXHTTPTHIS
server {
    listen 80;
    server_name ${DOMAIN};

    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINXHTTPTHIS
fi

# Enable site
ln -sf "$NGINX_CONF" "/etc/nginx/sites-enabled/${DOMAIN}"

# Remove default if conflicts
if [[ -f "/etc/nginx/sites-enabled/default" ]]; then
    rm -f "/etc/nginx/sites-enabled/default"
fi

nginx -t 2>&1 && {
    systemctl reload nginx
    log_ok "Nginx настроен и перезапущен"
} || {
    log_error "Nginx config test failed! Проверьте конфиг."
}

# ============================================================
#  11. Запуск через PM2
# ============================================================
log_info "Запуск приложения через PM2..."

cd "$INSTALL_DIR"

# Обновляем .env для PROD
if ! grep -q "NODE_ENV=production" "$INSTALL_DIR/.env" 2>/dev/null; then
    echo "NODE_ENV=production" >> "$INSTALL_DIR/.env"
fi

pm2 delete anxiety 2>/dev/null || true
NODE_ENV=production pm2 start "node src/server/index.js" \
    --name anxiety \
    --cwd "$INSTALL_DIR" \
    --env production

pm2 save
pm2 startup 2>/dev/null | tail -1 | bash 2>/dev/null || true

log_ok "Приложение запущено через PM2"

# ============================================================
#  12. Certbot auto-renew (cron)
# ============================================================
log_info "Настройка авто-обновления SSL..."
if ! crontab -l 2>/dev/null | grep -q "certbot renew"; then
    (crontab -l 2>/dev/null; echo "0 3 * * * certbot renew --quiet --deploy-hook 'systemctl reload nginx && pm2 restart anxiety'") | crontab -
    log_ok "Certbot auto-renew добавлен в cron (ежедневно в 3:00)"
else
    log_ok "Certbot auto-renew уже в cron"
fi

# ============================================================
#  Готово!
# ============================================================
echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  Anxiety успешно развёрнут!${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo -e "  Сайт:    ${BLUE}https://${DOMAIN}${NC}"
echo -e "  Панель:  ${BLUE}https://${DOMAIN}/api/panel${NC}"
echo -e "  API:     ${BLUE}https://${DOMAIN}/api/main/${NC}"
echo ""
echo -e "  Директория: ${INSTALL_DIR}"
echo -e "  PM2:       ${YELLOW}pm2 logs anxiety${NC}"
echo -e "  Restart:   ${YELLOW}pm2 restart anxiety${NC}"
echo ""
echo -e "  ${RED}Важно:${NC}"
echo -e "  1. Отредактируйте ${INSTALL_DIR}/.env — заполните HCAPTCHA ключи"
echo -e "  2. Зарегистрируйтесь на ${YELLOW}https://www.hcaptcha.com${NC} и получите ключи"
echo -e "  3. Обновите REPO_URL в скрипте перед повторным запуском"
echo ""
