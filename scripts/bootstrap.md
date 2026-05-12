# Bootstrap Claude AI сервера

Этот файл читает **сам Claude Code** на свежеустановленном Ubuntu-сервере и разворачивает cc-bridge + nginx + MCP + Playwright. Запускается из `scripts/install-claude.sh`.

## Параметры окружения

При запуске уже выставлены:
- `$INSTALL_TOKEN` — одноразовый токен для регистрации в SaaS
- `$SAAS_URL` — например `https://maxtable.pro`
- `$BRIDGE_DOMAIN` — желаемый поддомен (например `chat-igor.maxidea.pro`)
- `$BRIDGE_TOKEN` — сгенерируй сам (`openssl rand -hex 32`) и сохрани

## Шаги

### 1. Системные пакеты

```bash
sudo apt-get update -y
sudo apt-get install -y curl nginx certbot python3-certbot-nginx xvfb \
  fonts-liberation libnss3 libxkbcommon0 libgbm1 libasound2t64 \
  build-essential git
```

Node 20:
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 2. Юзер `maxclaude`

```bash
id -u maxclaude || sudo useradd -m -s /bin/bash maxclaude
sudo mkdir -p /workspaces /var/lib/cc-bridge /etc/cc-bridge/skills
sudo chown -R maxclaude:maxclaude /workspaces /var/lib/cc-bridge
```

### 3. Клонируй cc-bridge

```bash
sudo -u maxclaude bash -c '
  cd /opt && sudo git clone https://github.com/gurunweb/MaxTableCC.git cc-bridge
  cd cc-bridge && sudo -u maxclaude npm ci
'
sudo chown -R maxclaude:maxclaude /opt/cc-bridge
```

### 4. Конфиги в `/etc/cc-bridge/`

```bash
sudo cp /opt/cc-bridge/config/system-prompt.md /etc/cc-bridge/system-prompt.md
sudo cp /opt/cc-bridge/config/CLAUDE.template.md /etc/cc-bridge/CLAUDE.template.md
sudo cp /opt/cc-bridge/config/mcp.template.json /etc/cc-bridge/mcp.json
sudo cp -r /opt/cc-bridge/config/skills/* /etc/cc-bridge/skills/

cat <<EOF | sudo tee /etc/cc-bridge/env
CLAUDECODE_BRIDGE_TOKEN=$BRIDGE_TOKEN
WORKSPACES_ROOT=/workspaces
WORKSPACES_FLAT=1
CC_FILES_BASE_URL=https://$BRIDGE_DOMAIN
SYSTEM_PROMPT_FILE=/etc/cc-bridge/system-prompt.md
CLAUDE_TEMPLATE=/etc/cc-bridge/CLAUDE.template.md
MCP_CONFIG=/etc/cc-bridge/mcp.json
EOF
sudo chmod 600 /etc/cc-bridge/env
sudo chown root:maxclaude /etc/cc-bridge/env
```

### 5. systemd unit

Положи `/etc/systemd/system/cc-bridge.service` с содержимым из `scripts/cc-bridge.service` репо. Затем:

```bash
sudo systemctl daemon-reload
sudo systemctl enable cc-bridge
sudo systemctl start cc-bridge
```

### 6. nginx + SSL

Настрой nginx по шаблону `config/nginx.conf.template` — он раздаёт `/files/{chatId}/...` из `/workspaces/chats/{chatId}/outputs/` и проксирует `/apps/{chatId}` на `127.0.0.1:{port}` (где port читается из БД cc-bridge через auth_request).

Получи SSL:
```bash
sudo certbot --nginx -d $BRIDGE_DOMAIN --non-interactive --agree-tos -m admin@$BRIDGE_DOMAIN
```

### 7. Playwright + Xvfb (для headed-режима через VNC)

```bash
sudo -u maxclaude npx playwright install chromium --with-deps
sudo apt-get install -y tigervnc-standalone-server tigervnc-common
```

VNC на :1 запускать вручную при необходимости логина в сайты:
```bash
vncserver :1 -geometry 1280x800 -localhost no
```

### 8. Проверка `/health`

```bash
curl -fsS https://$BRIDGE_DOMAIN/health
# {"ok":1,"version":"...","uptime":...}
```

### 9. Рапорт в SaaS

```bash
curl -fsS -X POST "$SAAS_URL/v1/servers/ready" \
  -H "Content-Type: application/json" \
  -d "{\"installToken\":\"$INSTALL_TOKEN\",\"bridgeUrl\":\"https://$BRIDGE_DOMAIN\",\"bridgeToken\":\"$BRIDGE_TOKEN\"}"
```

Ответ `{ok:true}` → готово. SaaS пометит сервер как активный и юзер увидит «✅ онлайн» в Sidebar.

## При ошибке

Сохрани полный лог установки в `outputs/install-log.md`, опиши последний неудавшийся шаг и стоп. НЕ продолжай дальше — у юзера должна быть возможность починить руками и продолжить.
