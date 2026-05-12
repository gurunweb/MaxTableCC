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

echo "════════════════════════════════════════"
echo "  🤖 Claude AI cc-bridge installer"
echo "════════════════════════════════════════"
echo "  Дата:   $(date)"
echo "  Домен:  $BRIDGE_DOMAIN"
echo "  Токен:  ${BRIDGE_TOKEN:0:8}…"
echo "  Лог:    $LOG"
echo ""

# ─── DNS pre-check через Google DNS HTTPS (без зависимости от dig/resolv.conf) ─
# A-запись домена должна указывать на этот сервер, иначе certbot не выдаст SSL.
SERVER_IP=$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null \
         || curl -fsS --max-time 5 https://ifconfig.me 2>/dev/null \
         || echo "")
# Google Public DNS HTTPS API — авторитативный ответ, никакого локального кэша.
# Парсим первую строку из "Answer":[{"name":"...","type":1,"TTL":...,"data":"X.X.X.X"}]
DNS_JSON=$(curl -fsS --max-time 8 \
  "https://dns.google/resolve?name=${BRIDGE_DOMAIN}&type=A" 2>/dev/null || echo "")
DOMAIN_IP=$(echo "$DNS_JSON" \
  | grep -oE '"data":"[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+"' \
  | head -n1 \
  | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' || echo "")

if [ -z "$DOMAIN_IP" ]; then
  echo "❌ DNS ОШИБКА: $BRIDGE_DOMAIN не имеет A-записи в интернете"
  echo ""
  echo "   Google DNS не нашёл A-запись для этого домена."
  echo "   Возможные причины:"
  echo "   1. Вы не владеете этим доменом (он принадлежит кому-то другому)"
  echo "   2. NS-серверы домена не указывают на ту DNS-панель, где вы настраивали"
  echo "   3. Запись настроена, но изменения ещё не сохранены"
  echo "   4. DNS-распространение в процессе (попробуйте через 30 минут)"
  echo ""
  echo "   Проверить вручную:"
  echo "     curl 'https://dns.google/resolve?name=$BRIDGE_DOMAIN&type=A'"
  echo "     → должно быть {\"Answer\":[{\"data\":\"<IP>\"}]}"
  echo ""
  echo "   Без A-записи certbot не выдаст SSL — установка будет неполной."
  echo "   Чтобы прервать — Ctrl+C. Чтобы продолжить (без SSL) — Enter."
  read -r _ </dev/tty 2>/dev/null || true
elif [ -n "$SERVER_IP" ] && [ "$SERVER_IP" != "$DOMAIN_IP" ]; then
  echo "❌ DNS ОШИБКА: $BRIDGE_DOMAIN указывает на другой IP"
  echo ""
  echo "   A-запись $BRIDGE_DOMAIN → $DOMAIN_IP"
  echo "   Этот сервер             → $SERVER_IP"
  echo ""
  echo "   Что делать:"
  echo "   1. Зайдите в админку DNS-провайдера (где зарегистрирован $BRIDGE_DOMAIN)"
  echo "   2. Создайте/измените A-запись: $BRIDGE_DOMAIN → $SERVER_IP"
  echo "   3. Подождите 5-30 минут (DNS-распространение)"
  echo "   4. Запустите этот скрипт заново"
  echo ""
  echo "   Чтобы прервать — Ctrl+C. Чтобы продолжить (без SSL) — Enter."
  read -r _ </dev/tty 2>/dev/null || true
else
  echo "✅ DNS OK: $BRIDGE_DOMAIN → $DOMAIN_IP"
fi
echo ""

# === [1/6] Системные пакеты ===
echo "[1/6] Установка системных пакетов..."

# Ждём освобождения apt-lock — на свежем VPS unattended-upgrades часто блокирует
# первые 5-15 минут после boot. Без этой задержки скрипт падает с "Could not get
# lock /var/lib/dpkg/lock-frontend".
WAIT=0
while fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 \
   || fuser /var/lib/dpkg/lock >/dev/null 2>&1 \
   || fuser /var/lib/apt/lists/lock >/dev/null 2>&1; do
  if [ $WAIT -eq 0 ]; then
    echo "    apt занят другим процессом (вероятно unattended-upgrades). Жду..."
  fi
  WAIT=$((WAIT+5))
  if [ $WAIT -gt 900 ]; then
    echo "ERROR: apt занят >15 минут. Остановите вручную:"
    echo "    sudo systemctl stop unattended-upgrades"
    echo "    sudo killall -9 unattended-upgr 2>/dev/null"
    echo "  и запустите установку заново."
    exit 1
  fi
  sleep 5
done
[ $WAIT -gt 0 ] && echo "    apt свободен (ждали ${WAIT}с), продолжаю..."

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

# === [3/6] Клонируем cc-bridge (идемпотентно: clone или pull) ===
# Если репо был склонирован раньше — он принадлежит maxclaude (после chown),
# а git под root ругается «dubious ownership». Разрешаем root управлять им:
git config --global --add safe.directory /opt/cc-bridge 2>/dev/null || true

if [ -d /opt/cc-bridge/.git ]; then
  echo "[3/6] cc-bridge уже есть, обновляю до последней версии main..."
  cd /opt/cc-bridge
  git fetch --quiet origin main
  git reset --hard --quiet origin/main
  cd - >/dev/null
else
  echo "[3/6] Клонирую cc-bridge..."
  git clone --depth 1 https://github.com/gurunweb/MaxTableCC.git /opt/cc-bridge
fi
chown -R maxclaude:maxclaude /opt/cc-bridge
sudo -u maxclaude bash -lc 'cd /opt/cc-bridge && npm ci --omit=dev'

# === [4/6] Claude Code CLI + конфиги в /etc/cc-bridge/ ===
echo "[4/6] Установка Claude Code CLI..."
# Создаём .local/bin/ заранее — npm с -g --prefix кладёт бинарь туда
mkdir -p /home/maxclaude/.local/bin
chown -R maxclaude:maxclaude /home/maxclaude/.local
if ! sudo -u maxclaude bash -lc 'test -x /home/maxclaude/.local/bin/claude'; then
  # -g + --prefix → бинарь автоматом в /home/maxclaude/.local/bin/claude, симлинк не нужен
  sudo -u maxclaude bash -lc 'npm install -g --prefix /home/maxclaude/.local @anthropic-ai/claude-code'
fi
# Добавляем PATH в bashrc, чтобы интерактивный `claude` для OAuth-логина работал
if ! grep -q 'local/bin' /home/maxclaude/.bashrc 2>/dev/null; then
  echo 'export PATH="$HOME/.local/bin:$PATH"' | sudo tee -a /home/maxclaude/.bashrc >/dev/null
  chown maxclaude:maxclaude /home/maxclaude/.bashrc
fi

cp /opt/cc-bridge/config/system-prompt.md   /etc/cc-bridge/system-prompt.md
cp /opt/cc-bridge/config/CLAUDE.template.md /etc/cc-bridge/CLAUDE.template.md
cp /opt/cc-bridge/config/mcp.template.json  /etc/cc-bridge/mcp.json
cp /opt/cc-bridge/config/mcp-registry.json  /etc/cc-bridge/mcp-registry.json
cp -r /opt/cc-bridge/config/skills/*        /etc/cc-bridge/skills/

# Hook-скрипты должны быть исполняемыми (PreToolUse/PostToolUse)
chmod +x /opt/cc-bridge/hooks/*.sh

# jq нужен hook'ам для парсинга JSON от Claude Code
if ! command -v jq >/dev/null 2>&1; then
  apt-get install -y jq
fi

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
MCP_REGISTRY=/etc/cc-bridge/mcp-registry.json
DATABASE_PATH=/var/lib/cc-bridge/db.sqlite
PORT=8080
HOST=127.0.0.1
# Включает X-Accel-Redirect в /p/:slug (раздача файла отдаётся nginx).
# Локальный dev (без nginx) — оставьте пустым, файлы пойдут стримом.
CC_USE_XACCEL=1
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

  # Project shared/: /files/{email}/projects/{slug}/shared/... — общие файлы проекта
  location ~ ^/files/([a-zA-Z0-9@._-]+)/projects/([a-z0-9_-]+)/shared/(.+)$ {
    alias /workspaces/\$1/projects/\$2/shared/\$3;
    add_header Cache-Control "private, max-age=300";
  }
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
  # Single-tenant (WORKSPACES_FLAT=1) project shared/: /files/projects/{slug}/shared/...
  location ~ ^/files/projects/([a-z0-9_-]+)/shared/(.+)$ {
    alias /workspaces/projects/\$1/shared/\$2;
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

  # /p/{slug} — публичные короткие ссылки (через node, без auth).
  location ^~ /p/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
  }

  # X-Accel internal: node возвращает X-Accel-Redirect: /_files_internal/...
  # nginx читает файл из /workspaces (а node может сидеть в jail).
  location /_files_internal/ {
    internal;
    alias /;
  }

  # Webapp reverse-proxy: /apps/{project-slug}/...  или  /apps/c/{chatId}/...
  # auth_request → /internal/resolve-app/... → X-App-Port → proxy_pass на 127.0.0.1:port
  location = /_resolve_app {
    internal;
    proxy_pass http://127.0.0.1:8080\$resolve_app_uri;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
  }

  location ~ ^/apps/c/([A-Za-z0-9_-]+)(/.*)?$ {
    set \$chat_id \$1;
    set \$rest \$2;
    set \$resolve_app_uri /internal/resolve-app/chat/\$chat_id;
    auth_request /_resolve_app;
    auth_request_set \$app_port \$upstream_http_x_app_port;
    error_page 401 403 = @app_not_found;
    error_page 502 503 504 = @app_not_running;
    proxy_pass http://127.0.0.1:\$app_port\$rest\$is_args\$args;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 1800s;
  }

  location ~ ^/apps/([a-z0-9_-]+)(/.*)?$ {
    set \$proj_slug \$1;
    set \$rest \$2;
    set \$resolve_app_uri /internal/resolve-app/project/\$proj_slug;
    auth_request /_resolve_app;
    auth_request_set \$app_port \$upstream_http_x_app_port;
    error_page 401 403 = @app_not_found;
    error_page 502 503 504 = @app_not_running;
    proxy_pass http://127.0.0.1:\$app_port\$rest\$is_args\$args;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 1800s;
  }

  # 404 / 502 для /apps/ — понятные сообщения вместо стандартных nginx-страниц.
  location @app_not_found {
    default_type text/html;
    return 404 '<!doctype html><meta charset=utf-8><title>Не найдено</title><body style="font-family:system-ui;max-width:560px;margin:60px auto;padding:0 20px;line-height:1.5"><h1>404 — приложение не найдено</h1><p>В этом cc-bridge нет проекта или чата с таким идентификатором, либо порт ещё не назначен.</p><p>Если ты только что попросил Claude развернуть проект — подожди ~10 секунд и обнови страницу.</p></body>';
  }
  location @app_not_running {
    default_type text/html;
    return 502 '<!doctype html><meta charset=utf-8><title>Приложение не запущено</title><body style="font-family:system-ui;max-width:560px;margin:60px auto;padding:0 20px;line-height:1.5"><h1>502 — приложение не отвечает</h1><p>Проект существует, но процесс на выделенном порту не запущен или упал. Попроси Claude перезапустить dev-server (<code>npm run dev</code>).</p></body>';
  }

  location / {
    return 404 "cc-bridge: используйте /v1/*, /files/*, /apps/* или /p/*\n";
  }
}
NGINX
nginx -t && systemctl reload nginx

# === [6/6] Запуск + автоматическая проверка ===
echo "[6/6] Запуск cc-bridge..."
systemctl restart cc-bridge
sleep 2

# Локальный health-check (через 127.0.0.1, без SSL — чтобы понять что node работает)
LOCAL_HEALTH=$(curl -fsS --max-time 5 http://127.0.0.1:8080/health 2>/dev/null || echo "")
PUBLIC_HEALTH=$(curl -fsS --max-time 8 "https://$BRIDGE_DOMAIN/health" 2>/dev/null || echo "")

echo ""
echo "════════════════════════════════════════"
if [ -n "$PUBLIC_HEALTH" ]; then
  echo "  ✅ Установка успешна!"
  echo "════════════════════════════════════════"
  echo ""
  echo "  🟢 https://$BRIDGE_DOMAIN/health отвечает:"
  echo "     $PUBLIC_HEALTH"
elif [ -n "$LOCAL_HEALTH" ]; then
  echo "  ⚠️  cc-bridge работает локально, но https-доступа нет"
  echo "════════════════════════════════════════"
  echo ""
  echo "  Локально (127.0.0.1:8080/health):"
  echo "     $LOCAL_HEALTH"
  echo ""
  echo "  Скорее всего проблема с nginx/SSL/DNS:"
  echo "  - проверь A-запись: $BRIDGE_DOMAIN должна указывать на $SERVER_IP"
  echo "  - проверь nginx: sudo nginx -t && sudo systemctl status nginx"
  echo "  - проверь SSL: ls -la /etc/letsencrypt/live/$BRIDGE_DOMAIN/"
  echo "  - попробуй вручную: sudo certbot --nginx -d $BRIDGE_DOMAIN"
else
  echo "  ❌ cc-bridge не запустился"
  echo "════════════════════════════════════════"
  echo ""
  echo "  Диагностика:"
  echo "     sudo systemctl status cc-bridge"
  echo "     sudo journalctl -u cc-bridge -n 50"
fi

echo ""
echo "─────────────────────────────────────────"
echo "  ⚠️  ДАЛЬШЕ — OAuth-логин в Claude (ОБЯЗАТЕЛЬНО)"
echo "─────────────────────────────────────────"
echo ""
echo "  cc-bridge нужен ваш Claude Max OAuth-токен. Выполните:"
echo ""
echo "    sudo -u maxclaude -i"
echo "    claude"
echo ""
echo "  Появится ссылка вида https://claude.ai/oauth/authorize?...."
echo "  Откройте её в браузере, залогиньтесь под Claude Max."
echo "  Скопируйте код обратно в терминал. Затем:"
echo ""
echo "    exit                                    # выходим из shell maxclaude"
echo "    sudo systemctl restart cc-bridge"
echo ""
echo "─────────────────────────────────────────"
echo "  Финальная проверка:"
echo "    curl -fsS https://$BRIDGE_DOMAIN/health"
echo ""
echo "  Лог установки: $LOG"
echo "═════════════════════════════════════════"
