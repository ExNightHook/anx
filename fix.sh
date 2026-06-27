#!/bin/bash
# ============================================================
#  fix.sh — Быстрый фикс после неудачного деплоя.
#  Запусти на сервере: chmod +x fix.sh && ./fix.sh
# ============================================================

set -euo pipefail

DOMAIN="aesthesia.xyz"
INSTALL_DIR="/opt/anxiety"
APP_PORT="3000"
SSL_CERT="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
SSL_KEY="/etc/letsencrypt/live/${DOMAIN}/privkey.pem"

echo "[1/5] Остановка текущего PM2 процесса..."
pm2 delete anxiety 2>/dev/null || true

echo "[2/5] Исправление nginx конфигурации..."
cat > "/etc/nginx/sites-available/${DOMAIN}" << 'NGINXEOF'
# Anxiety — aesthesia.xyz

server {
    listen 80;
    server_name DOMAIN_PLACEHOLDER;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl;
    http2 on;

    server_name DOMAIN_PLACEHOLDER;

    ssl_certificate SSL_CERT_PLACEHOLDER;
    ssl_certificate_key SSL_KEY_PLACEHOLDER;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;
    ssl_session_tickets off;

    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
    add_header X-Content-Type-Options nosniff;
    add_header X-Frame-Options DENY;

    client_max_body_size 10M;

    location / {
        proxy_pass http://127.0.0.1:APP_PORT_PLACEHOLDER;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
NGINXEOF

sed -i "s|DOMAIN_PLACEHOLDER|${DOMAIN}|g" "/etc/nginx/sites-available/${DOMAIN}"
sed -i "s|SSL_CERT_PLACEHOLDER|${SSL_CERT}|g" "/etc/nginx/sites-available/${DOMAIN}"
sed -i "s|SSL_KEY_PLACEHOLDER|${SSL_KEY}|g" "/etc/nginx/sites-available/${DOMAIN}"
sed -i "s|APP_PORT_PLACEHOLDER|${APP_PORT}|g" "/etc/nginx/sites-available/${DOMAIN}"

ln -sf "/etc/nginx/sites-available/${DOMAIN}" "/etc/nginx/sites-enabled/${DOMAIN}"
rm -f "/etc/nginx/sites-enabled/default"

nginx -t && systemctl reload nginx && echo "  nginx OK" || echo "  nginx FAILED"

echo "[3/5] Установка cron если отсутствует..."
apt-get install -y -qq cron 2>/dev/null || true

echo "[4/5] Запуск Node.js приложения через PM2..."
cd "$INSTALL_DIR"
NODE_ENV=production pm2 start src/server/index.js \
    --name anxiety \
    --cwd "$INSTALL_DIR" \
    --env production \
    --node-args="--max-old-space-size=256"

pm2 save
pm2 startup 2>/dev/null | tail -1 | bash 2>/dev/null || true
sleep 2

echo "[5/5] Проверка..."
pm2 list
curl -s -o /dev/null -w "HTTP Status: %{http_code}" http://127.0.0.1:${APP_PORT}/ || echo "App not responding"

echo ""
echo "Готово! Проверь https://${DOMAIN}"
