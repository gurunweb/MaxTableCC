# cc-bridge

HTTP-обёртка над Claude Code CLI. Принимает задачи от MaxTableSaaS (Cloudflare Workers), запускает `claude -p ...` под подпиской Claude Max, возвращает результаты.

Часть экосистемы **MaxTable** (интеграция Claude в Google Sheets через формулу `=MS_CLOUDCODE(A1)`).

## Архитектура

```
Google Sheets (GAS) ──▶ MaxTableSaaS (Cloudflare) ──▶ cc-bridge (этот проект) ──▶ Claude Code CLI
```

- **Runtime:** Node.js 20 + Fastify
- **БД:** SQLite (WAL-режим)
- **OS:** Ubuntu 24.04 LTS
- **Публичный endpoint:** https://2135.com (Caddy + Let's Encrypt TLS)
- **Запускается от:** non-root юзер `maxclaude`
- **Управление:** systemd (`cc-bridge.service`)

## Endpoints

| Метод | URL | Назначение |
|-------|-----|------------|
| POST | `/run` | submit задачи: спавн `claude -p ...`, возврат `{taskId, chatId, workdir}` |
| GET | `/status/:taskId` | polling: `{status, newActions, result, partialResult, pauseSummary, approvalPrompt}` |
| POST | `/stop/:taskId` | graceful stop (30 сек grace period, потом SIGTERM) |
| GET | `/meta/chats` | список чатов юзера |
| GET | `/meta/paused` | приостановленные задачи (по таймауту) |
| GET | `/meta/subscription` | оставшийся лимит Claude Max подписки |
| GET | `/meta/health` | health-check для SaaS (200 OK + version + uptime) |
| DELETE | `/chats/:chatId` | удалить workdir чата |

Все endpoints требуют заголовок `X-Bridge-Token: $CLOUDCODE_BRIDGE_TOKEN` (shared secret с SaaS).

## Структура

```
cc-bridge/
├── src/
│   ├── index.ts              Fastify app entrypoint
│   ├── routes/
│   │   ├── run.ts
│   │   ├── status.ts
│   │   ├── stop.ts
│   │   ├── meta.ts
│   │   └── chats.ts
│   ├── lib/
│   │   ├── claudeRunner.ts   spawn claude + stream-json parser
│   │   ├── permissionHook.ts генерация settings.json с hook PreToolUse
│   │   ├── attachments.ts    скачивание Drive/HTTP/base64 → workdir/attachments/
│   │   ├── chats.ts          управление workdir и chatId
│   │   └── db.ts             better-sqlite3 обёртка
│   └── db/
│       └── schema.sql
├── hooks/
│   └── cc-permission-check.sh  bash-хук классификации tool-use для режима safe
├── systemd/
│   └── cc-bridge.service
├── scripts/
│   ├── setup-server.sh         разовый provisioning сервера (idempotent)
│   └── deploy.sh               git pull + npm ci + systemctl restart
├── package.json
├── .env.example
├── tsconfig.json
├── CLAUDE.md
└── README.md
```

## Layout файлов на сервере

```
/opt/cc-bridge/              этот проект (git clone)
/var/lib/cc-bridge/db.sqlite задачи, action-log, chats
/etc/cc-bridge/env           production env (секреты)
/workspaces/                 workdir'ы Claude-сессий
  {email}/
    chats/
      {chatId}/
        .claude/             Claude session (resume)
        attachments/         входные файлы
        outputs/             что создал Claude
        audit.log            PostToolUse hook → build log
```

## Quickstart (разработка)

```bash
git clone git@github.com:gurunweb/cc-bridge.git /opt/cc-bridge
cd /opt/cc-bridge
npm ci
cp .env.example /etc/cc-bridge/env && nano /etc/cc-bridge/env
node --experimental-strip-types src/index.ts
```

## Deploy

```bash
ssh cc-server 'cd /opt/cc-bridge && ./scripts/deploy.sh'
```

## Связанные проекты

- **MaxTableGS** — GAS-формула `MS_CLOUDCODE` ([gurunweb/MaxGS](https://github.com/gurunweb/MaxGS))
- **MaxTableSaaS** — Cloudflare Workers прокси ([gurunweb/MaxTableSaaS](https://github.com/gurunweb/MaxTableSaaS))

## Документация

- `CLAUDE.md` — специфика проекта для Claude Code
- Полный архитектурный план: `../docs/cloudcode-plan.md` (локально, не в git)
- GAS-часть: `../MaxTableGS/docs/plan/cloudcode-gas-integration.md`
- SaaS-часть: `../MaxTableSaaS/docs/cloudcode-saas-integration.md`
