#!/usr/bin/env bash
# Установщик Claude AI на свежий Ubuntu 24.04 VPS.
# Запускается как: curl -fsSL https://maxtable.pro/install/claudeai | bash -s -- INSTALL_TOKEN
set -euo pipefail

INSTALL_TOKEN="${1:-}"
SAAS_URL="${SAAS_URL:-https://maxtable.pro}"

if [ -z "$INSTALL_TOKEN" ]; then
  echo "ERROR: INSTALL_TOKEN не передан"
  echo "Использование: curl -fsSL $SAAS_URL/install/claudeai | bash -s -- INSTALL_TOKEN"
  exit 1
fi

LOG=/tmp/claude-bootstrap-$(date +%s).log
exec > >(tee -a "$LOG") 2>&1

echo "=== Claude AI install: $(date) ==="
echo "Install token: ${INSTALL_TOKEN:0:8}..."
echo "Log: $LOG"

# Запрос конфигурации сервера у SaaS по install-token
echo "[1/5] Получаю конфигурацию у $SAAS_URL..."
CONFIG=$(curl -fsS -X POST "$SAAS_URL/install/claudeai/config" \
  -H "Content-Type: application/json" \
  -d "{\"installToken\":\"$INSTALL_TOKEN\"}")
BRIDGE_DOMAIN=$(echo "$CONFIG" | sed -n 's/.*"bridgeDomain":"\([^"]*\)".*/\1/p')
if [ -z "$BRIDGE_DOMAIN" ]; then
  echo "ERROR: SaaS не вернул bridgeDomain"
  exit 1
fi
export INSTALL_TOKEN SAAS_URL BRIDGE_DOMAIN
export BRIDGE_TOKEN=$(openssl rand -hex 32)
echo "Bridge domain: $BRIDGE_DOMAIN"

# Установка Claude Code CLI (под root, доступен глобально)
echo "[2/5] Устанавливаю Claude Code CLI..."
if ! command -v claude >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
  npm install -g @anthropic-ai/claude-code
fi

# Логин Claude Code (юзер должен сделать сам — интерактивно).
# Альтернатива: использовать API-key из подписки Anthropic.
echo "[3/5] Проверь логин Claude Code:"
echo "      Запусти 'claude' в отдельной SSH-сессии и пройди OAuth."
echo "      После этого нажми Enter здесь, чтобы продолжить."
read -r _

# Запуск Claude Code с bootstrap.md
echo "[4/5] Запускаю Claude Code для установки cc-bridge..."
curl -fsSL https://raw.githubusercontent.com/gurunweb/MaxTableCC/main/scripts/bootstrap.md \
  -o /tmp/bootstrap.md

cd /root
claude -p "$(cat /tmp/bootstrap.md)

Все параметры окружения ($INSTALL_TOKEN, $SAAS_URL, $BRIDGE_DOMAIN, $BRIDGE_TOKEN) уже экспортированы. Выполни все шаги по порядку. При ошибке остановись и опиши проблему." \
  --output-format stream-json \
  --verbose \
  --permission-mode bypassPermissions

echo "[5/5] Готово."
echo
echo "Bridge URL: https://$BRIDGE_DOMAIN"
echo "Health check: curl https://$BRIDGE_DOMAIN/health"
echo
echo "Полный лог: $LOG"
