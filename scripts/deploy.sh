#!/bin/bash
# Deploy cc-bridge: git pull + npm ci + restart systemd
# Запускать от maxclaude (sudo настроен в /etc/sudoers.d/maxclaude)

set -euo pipefail

DEPLOY_DIR="/opt/cc-bridge"
cd "$DEPLOY_DIR"

echo "→ git pull"
git pull --ff-only

echo "→ npm ci"
npm ci --silent

echo "→ sudo systemctl restart cc-bridge"
sudo systemctl restart cc-bridge

sleep 2
echo "→ статус:"
sudo systemctl status cc-bridge --no-pager | head -8

echo "→ health:"
curl -sf http://localhost:8080/health | head -1 || echo "HEALTH FAIL"
