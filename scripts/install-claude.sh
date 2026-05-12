#!/usr/bin/env bash
# Установщик Claude AI на свежий Ubuntu 24.04 VPS.
#
# Запуск (BRIDGE_DOMAIN и BRIDGE_TOKEN передаются клиентом из GAS):
#   curl -fsSL https://raw.githubusercontent.com/gurunweb/MaxTableCC/main/scripts/install-claude.sh \
#     | sudo BRIDGE_DOMAIN=claude.mydomain.com BRIDGE_TOKEN=<hex64> bash
#
# Ничего не отправляет в SaaS — конфигурация на bridge целиком определяется
# тем, что прилетело в env. BRIDGE_DOMAIN должен иметь A-запись на этот сервер.

set -euo pipefail

if [ -z "${BRIDGE_DOMAIN:-}" ] || [ -z "${BRIDGE_TOKEN:-}" ]; then
  echo "ERROR: BRIDGE_DOMAIN и BRIDGE_TOKEN должны быть в env"
  echo "Пример: curl -fsSL ... | sudo BRIDGE_DOMAIN=claude.example.com BRIDGE_TOKEN=abc... bash"
  exit 1
fi

if [ "$EUID" -ne 0 ]; then
  echo "ERROR: запускайте через sudo (нужен root для apt, systemd, nginx, certbot)"
  exit 1
fi

LOG=/tmp/claude-bootstrap-$(date +%s).log
exec > >(tee -a "$LOG") 2>&1

echo "=== Claude AI install: $(date) ==="
echo "Domain: $BRIDGE_DOMAIN"
echo "Token:  ${BRIDGE_TOKEN:0:8}..."
echo "Log:    $LOG"

# === [1/6] Системные пакеты ===
echo "[1/6] Установка системных пакетов..."
apt-get update -y
apt-get install -y curl git nginx certbot python3-certbot-nginx xvfb \
  fonts-liberation libnss3 libxkbcommon0 libgbm1 libasound2t64 build-essential

# Node 20 (для cc-bridge и Claude Code CLI)
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

# === [2/6] Юзер maxclaude и директории ===
echo "[2/6] Создаю maxclaude и /workspaces /var/lib/cc-bridge..."
id -u maxclaude >/dev/null 2>&1 || useradd -m -s /bin/bash maxclaude
mkdir -p /workspaces /var/lib/cc-bridge /etc/cc-bridge/skills
chown -R maxclaude:maxclaude /workspaces /var/lib/cc-bridge

# === [3/6] Клонируем cc-bridge ===
echo "[3/6] git clone cc-bridge..."
if [ ! -d /opt/cc-bridge/.git ]; then
  git clone https://github.com/gurunweb/MaxTableCC.git /opt/cc-bridge
fi
chown -R maxclaude:maxclaude /opt/cc-bridge
sudo -u maxclaude bash -lc 'cd /opt/cc-bridge && npm ci --omit=dev'

# === [4/6] Claude Code CLI + конфиги в /etc/cc-bridge/ ===
echo "[4/6] Установка Claude Code CLI..."
if ! sudo -u maxclaude bash -lc 'command -v claude' >/dev/null 2>&1; then
  sudo -u maxclaude bash -lc 'npm install --prefix /home/maxclaude/.local @anthropic-ai/claude-code && ln -sf /home/maxclaude/.local/node_modules/.bin/claude /home/maxclaude/.local/bin/claude'
fi

cp /opt/cc-bridge/config/system-prompt.md   /etc/cc-bridge/system-prompt.md
cp /opt/cc-bridge/config/CLAUDE.template.md /etc/cc-bridge/CLAUDE.template.md
cp /opt/cc-bridge/config/mcp.template.json  /etc/cc-bridge/mcp.json
cp -r /opt/cc-bridge/config/skills/*        /etc/cc-bridge/skills/

cat > /etc/cc-bridge/env <<EOF
CLAUDECODE_BRIDGE_TOKEN=$BRIDGE_TOKEN
WORKSPACES_ROOT=/workspaces
# Multi-tenant по умолчанию: каждый юзер видит свою папку /workspaces/{email}/chats/...
# Можно поделиться сервером с другим клиентом, добавив тот же bridge_url+bridge_token
# в его user_servers через админку SaaS. Если хочется single-tenant — раскомментируйте:
# WORKSPACES_FLAT=1
CC_FILES_BASE_URL=https://$BRIDGE_DOMAIN
SYSTEM_PROMPT_FILE=/etc/cc-bridge/system-prompt.md
CLAUDE_TEMPLATE=/etc/cc-bridge/CLAUDE.template.md
MCP_CONFIG=/etc/cc-bridge/mcp.json
DATABASE_PATH=/var/lib/cc-bridge/db.sqlite
PORT=8080
HOST=127.0.0.1
EOF
chmod 600 /etc/cc-bridge/env
chown root:maxclaude /etc/cc-bridge/env

# === [5/6] systemd unit + nginx + SSL ===
echo "[5/6] systemd, nginx, SSL..."

cat > /etc/systemd/system/cc-bridge.service <<'SVC'
[Unit]
Description=cc-bridge (Claude Code HTTP wrapper)
After=network.target

[Service]
Type=simple
User=maxclaude
Group=maxclaude
EnvironmentFile=/etc/cc-bridge/env
WorkingDirectory=/opt/cc-bridge
ExecStart=/usr/bin/node --experimental-strip-types /opt/cc-bridge/src/index.ts
Restart=on-failure
RestartSec=5
ProtectSystem=strict
NoNewPrivileges=yes
ReadWritePaths=/workspaces /var/lib/cc-bridge /tmp
MemoryMax=2G

[Install]
WantedBy=multi-user.target
SVC

systemctl daemon-reload
systemctl enable cc-bridge

cat > /etc/nginx/sites-available/cc-bridge <<NGINX
server {
  listen 80;
  server_name $BRIDGE_DOMAIN;
  location /.well-known/acme-challenge/ { root /var/www/html; }
  location / { return 301 https://\$host\$request_uri; }
}
NGINX
ln -sf /etc/nginx/sites-available/cc-bridge /etc/nginx/sites-enabled/cc-bridge
nginx -t && systemctl reload nginx

certbot --nginx -d "$BRIDGE_DOMAIN" --non-interactive --agree-tos -m "admin@$BRIDGE_DOMAIN" || true

# После certbot заменяем конфиг на проксирующий
cat > /etc/nginx/sites-available/cc-bridge <<NGINX
server {
  listen 80;
  server_name $BRIDGE_DOMAIN;
  return 301 https://\$host\$request_uri;
}

server {
  listen 443 ssl http2;
  server_name $BRIDGE_DOMAIN;

  ssl_certificate     /etc/letsencrypt/live/$BRIDGE_DOMAIN/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/$BRIDGE_DOMAIN/privkey.pem;

  client_max_body_size 50M;

  # Bridge API — все запросы /v1/* идут в node на 127.0.0.1:8080
  location /v1/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_read_timeout 1800s;
  }

  # Health (для UI 🟢/🔴)
  location /health {
    proxy_pass http://127.0.0.1:8080;
  }

  # Статика чатов. Multi-tenant: путь /files/{emailSafe}/...
  # ChatId формат: новый YYMMDD_HHMM_XX или старый chat-<nanoid>.
  # Регэксп общий: [A-Za-z0-9_-]+ для chat-сегмента и [a-z0-9_-]+ для slug проекта.

  # Project chats: /files/{email}/projects/{slug}/chats/{chatId}/outputs/...
  location ~ ^/files/([a-zA-Z0-9@._-]+)/projects/([a-z0-9_-]+)/chats/([A-Za-z0-9_-]+)/outputs/(.+)$ {
    alias /workspaces/\$1/projects/\$2/chats/\$3/outputs/\$4;
    add_header Cache-Control "private, max-age=300";
  }
  # Solo chats (multi-tenant): /files/{email}/chats/{chatId}/outputs/...
  location ~ ^/files/([a-zA-Z0-9@._-]+)/chats/([A-Za-z0-9_-]+)/outputs/(.+)$ {
    alias /workspaces/\$1/chats/\$2/outputs/\$3;
    add_header Cache-Control "private, max-age=300";
  }
  # Single-tenant (WORKSPACES_FLAT=1) project: /files/projects/{slug}/chats/{chatId}/outputs/...
  location ~ ^/files/projects/([a-z0-9_-]+)/chats/([A-Za-z0-9_-]+)/outputs/(.+)$ {
    alias /workspaces/projects/\$1/chats/\$2/outputs/\$3;
    add_header Cache-Control "private, max-age=300";
  }
  # Single-tenant solo: /files/chats/{chatId}/outputs/...
  location ~ ^/files/chats/([A-Za-z0-9_-]+)/outputs/(.+)$ {
    alias /workspaces/chats/\$1/outputs/\$2;
    add_header Cache-Control "private, max-age=300";
  }
  # LEGACY (старый формат до 002 миграции): /files/{email}/{chatId}/outputs/...
  location ~ ^/files/([a-zA-Z0-9@._-]+)/(chat-[^/]+)/outputs/(.+)$ {
    alias /workspaces/\$1/chats/\$2/outputs/\$3;
    add_header Cache-Control "private, max-age=300";
  }

  # Webapp reverse-proxy (порт читается из БД cc-bridge через auth_request — TODO)
  location ~ ^/apps/ {
    return 503 "Webapp routing pending\n";
  }

  location / {
    return 404 "cc-bridge: используйте /v1/* или /files/*\n";
  }
}
NGINX
nginx -t && systemctl reload nginx

# === [6/6] Логин в Claude Code (интерактивно) и запуск ===
echo "[6/6] Запуск cc-bridge..."
systemctl restart cc-bridge

echo
echo "================================================================"
echo "✅ cc-bridge установлен."
echo "    Health:     https://$BRIDGE_DOMAIN/health"
echo "    Лог:        $LOG"
echo
echo "⚠️  ВАЖНО: cc-bridge нужен Claude OAuth-токен. Выполните:"
echo ""
echo "    sudo -u maxclaude /home/maxclaude/.local/bin/claude"
echo ""
echo "    Скрипт даст OAuth-ссылку — откройте в браузере, залогиньтесь"
echo "    под аккаунтом Claude Max. После этого:"
echo ""
echo "    sudo systemctl restart cc-bridge"
echo
echo "Проверка работы:"
echo "    curl -fsS https://$BRIDGE_DOMAIN/health"
echo "================================================================"
