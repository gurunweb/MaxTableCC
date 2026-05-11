# CLAUDE.md — cc-bridge

Контекст для Claude Code при работе в этом репозитории.

## Что это

**cc-bridge** — тонкая HTTP-обёртка над Claude Code CLI на собственном Ubuntu-сервере. Принимает задачи от **MaxTableSaaS** (Cloudflare Workers), запускает `claude -p` под подпиской Claude Max, возвращает результаты.

Часть экосистемы **MaxTable** (3 проекта: MaxTableGS, MaxTableSaaS, cc-bridge).

## Архитектура

```
Google Sheets (GAS) ──▶ MaxTableSaaS ──▶ cc-bridge ──▶ Claude Code CLI
                        (прокси+auth)    (этот проект)  (`claude -p`)
```

## Стек и окружение

| Компонент | Версия |
|-----------|--------|
| Node.js | 20 LTS (нативный TypeScript через `--experimental-strip-types`) |
| Fastify | 5.x |
| SQLite | через `better-sqlite3` (WAL mode) |
| OS | Ubuntu 24.04 LTS |

## Где что лежит (на сервере)

```
/opt/cc-bridge/           этот проект (git clone)
/var/lib/cc-bridge/       SQLite БД (db.sqlite) — принадлежит maxclaude
/etc/cc-bridge/env        production env (секреты) — 600 root:maxclaude
/workspaces/              workdir'ы Claude (owned by maxclaude)
  {email}/
    chats/
      {chatId}/
        .claude/          Claude session (для --resume)
        attachments/      входные файлы
        outputs/          что создал Claude
        audit.log         PostToolUse hook log
```

## Структура кода

```
src/
├── index.ts              Fastify app entrypoint (запускает listen + регистрирует роуты)
├── routes/
│   ├── health.ts         GET /health (public)
│   ├── run.ts            POST /v1/claudecode/run
│   ├── status.ts         GET /v1/claudecode/status/:taskId
│   ├── stop.ts           POST /v1/claudecode/stop/:taskId
│   ├── meta.ts           GET /v1/claudecode/meta/{chats,paused,subscription}
│   └── chats.ts          DELETE /v1/claudecode/chats/:chatId
├── lib/
│   ├── db.ts             better-sqlite3 обёртка (WAL)
│   ├── claudeRunner.ts   spawn claude -p + парсинг stream-json
│   ├── permissionHook.ts генератор settings.json с hook для режима safe
│   ├── attachments.ts    скачивание Drive/HTTP/base64 → workdir/attachments/
│   └── chats.ts          управление workdir'ами
└── db/
    └── schema.sql        SQLite schema (chats, tasks, actions, view task_status)
```

## Endpoint'ы

| Метод | URL | Описание |
|-------|-----|----------|
| GET | `/health` | public, возвращает `{ok:1, version, uptime, node, platform}` |
| POST | `/v1/claudecode/run` | запуск задачи (новая / продолжение / resume-after-pause) |
| GET | `/v1/claudecode/status/:taskId` | polling статуса + новые actions |
| POST | `/v1/claudecode/stop/:taskId` | graceful stop |
| GET | `/v1/claudecode/meta/chats` | список чатов юзера |
| GET | `/v1/claudecode/meta/paused` | приостановленные задачи |
| GET | `/v1/claudecode/meta/subscription` | лимит Claude Max |
| DELETE | `/v1/claudecode/chats/:chatId` | удаление workdir |

Все `/v1/*` требуют `X-Bridge-Token: $CLAUDECODE_BRIDGE_TOKEN` (shared secret с SaaS).

## Claude Code CLI запуск

```bash
claude -p "$PROMPT" \
  --output-format stream-json \
  --resume "$CHAT_ID" \
  --permission-mode bypassPermissions \
  --cwd "/workspaces/$USER_EMAIL/chats/$CHAT_ID"
```

**3 режима разрешений** (`params.mode` от клиента):
- `auto` — `bypassPermissions`, Claude делает всё
- `plan` — `--permission-mode plan`, только анализ, план текстом в результат
- `safe` — `bypassPermissions` + PreToolUse hook `cc-permission-check.sh`, опасные действия → пауза + запрос одобрения через A1 (в GAS) → `[CC_APPROVED]` в stdin Claude

## Таймаут → мягкая пауза (НЕ kill)

Timer на `maxTime - 30` секунд шлёт Claude в stdin: "Время кончается, финализируй промежуточное и заверши". Claude сохраняет partial result в `outputs/`, пишет summary. Процесс корректно exit=0 → `status=paused`. Hard SIGTERM только если не успел за +90 сек.

При продолжении (`/run` с `resumeFromPausedTask=...`) запускаем новый `claude --resume chatId` с системным промптом "продолжи с места остановки", передаём pauseSummary в контекст.

## Security

- Запускается от `maxclaude` (non-root, без sudo кроме управления своим systemd)
- systemd hardening: `ProtectSystem=strict`, `ReadWritePaths=/workspaces /var/lib/cc-bridge /tmp`, `NoNewPrivileges=yes`
- SQLite owned by maxclaude
- Никаких секретов в коде — всё из `/etc/cc-bridge/env`

## Деплой

```bash
ssh maxclaude@maxidea.pro
cd /opt/cc-bridge
./scripts/deploy.sh
```

`deploy.sh` делает: `git pull + npm ci + sudo systemctl restart cc-bridge + health check`.

## Конвенции кода

- TypeScript без компиляции — нативные types стрипаются Node.js 20 (`--experimental-strip-types`)
- Импорты с `.ts` расширением (Node 22+ требование)
- Без бандлера, без TypeScript compiler — только Node
- Логи через Fastify/pino — в journalctl через systemd
- Все ошибки → structured JSON в stderr

## История

- 2026-04-19: initial skeleton + deployment infra
