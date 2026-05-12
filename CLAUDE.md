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
/opt/cc-bridge/                   этот проект (git clone)
/var/lib/cc-bridge/               SQLite БД (db.sqlite) — принадлежит maxclaude
/etc/cc-bridge/
  ├── env                         production env (секреты) — 600 root:maxclaude
  ├── system-prompt.md            глобальный системный промпт (Sheets-context)
  ├── CLAUDE.template.md          шаблон, копируется в каждый новый workdir
  ├── mcp.json                    конфиг MCP (playwright, fetch)
  └── skills/                     /publish, /commit и др. — скиллы для Claude
      └── *.md
/workspaces/                      multi-tenant: каждый юзер видит только свою папку
  {safeEmail}/                    например user_at_gmail.com
    chats/                        ← одиночные чаты (без проекта)
      {chatId}/                   формат имени: YYMMDD_HHMM_XX (с 2026-05-12)
        .claude/                  hook-настройки (settings.json для safe-режима)
        CLAUDE.md                 скопирован из template
        attachments/              входные файлы
        outputs/                  что создал Claude (раздаётся nginx-ом)
        audit.log                 PostToolUse hook log
    projects/                     ← осознанные проекты (shared codebase)
      {slug}/                     имя проекта в slug-формате (lower-case, ascii)
        CLAUDE.md
        (общие файлы проекта)     ← код, документы, доступны всем чатам проекта
        chats/
          {chatId}/
            attachments/
            outputs/
            .claude/
  playwright-profile/              shared chromium profile (cookies, логины) — пер-сервер
```

**Чаты vs Проекты** (с 2026-05-12):
- **Одиночный чат** живёт в `chats/{chatId}/` — полноценный workdir с файлами и кодом.
  По умолчанию каждый запуск формулы без `projectName` создаёт одиночный чат.
- **Проект** — папка с общей кодовой базой, под которой может быть несколько чатов.
  Каждый чат проекта имеет свой `chats/{chatId}/` для приватных артефактов, а корень
  проекта — для shared codebase. Claude `cwd` = корень проекта.
- **Имя чата** всегда автогенерация: `YYMMDD_HHMM_XX` (`260512_1430_a7` = 12.05.26, 14:30,
  хвост `a7`). Пользователь не управляет именем чата.
- **Имя проекта** даёт пользователь через параметр `projectName` в формуле
  `MS_CLAUDECODE`. См. таблицу семантики ниже.
- **Сессии Claude** не зависят от структуры папок — `claude_session_id` хранится
  в `chats` и передаётся через `--resume`. Перенос workdir сломает сессию (Claude
  хранит её по path-hash в `~/.claude/projects/`), поэтому **существующие чаты НЕ
  перемещаются** на новой схеме — workdir в БД остаётся валидным.

### Семантика `projectName` (в `POST /v1/claudecode/run`)

| Сценарий | Поведение |
|---|---|
| `projectName` не задан, новый чат | Создать в `chats/{auto}/`. |
| `projectName` не задан, resume по `chatId` | Resume там, где чат лежит. |
| `projectName: "MySite"`, новый чат, проекта нет | Создать проект `projects/MySite/` + первый чат внутри. |
| `projectName: "MySite"`, новый чат, проект есть | Добавить новый чат в существующий проект. |
| `projectName: "X"`, resume чата, чат уже в `X` | No-op. |
| `projectName: "NewName"`, resume чата из `OldName`, свободно | Rename проекта (`fs.rename` + UPDATE). |
| `projectName: "NewName"`, resume, занято | **409 Conflict**. |
| `projectName: "X"`, resume одиночного чата (`/chats/`) | **409 Conflict** (одиночный не переносится). |

**Multi-tenant** (по умолчанию): один сервер обслуживает нескольких пользователей,
каждый видит только свою папку `/workspaces/{safeEmail}/`. Админ MaxTable может
дать клиенту доступ к своему серверу, просто заполнив форму подключения в админке
SaaS (`/admin/users/:id`) с теми же bridge_url+bridge_token. Клиент получит
изолированную папку по своему email.

**Single-tenant** (`WORKSPACES_FLAT=1` в env): без email-папки, чаты лежат в
`/workspaces/chats/{chatId}/`. Используйте, если уверены что сервер обслуживает
одного человека.

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

**Первичная установка** на свежем VPS (BYOS):

```bash
curl -fsSL https://raw.githubusercontent.com/gurunweb/MaxTableCC/main/scripts/install-claude.sh \
  | sudo BRIDGE_DOMAIN=claude.example.com BRIDGE_TOKEN=<hex64> WITH_BROWSER=1 bash
```

(`WITH_BROWSER=1` включает удалённый chromium через steel-browser — нужен 2+ ГБ
RAM. Без флага cc-bridge ставится «налегке».)

[scripts/install-claude.sh](scripts/install-claude.sh) ставит: системные пакеты,
Node 22 LTS, Claude Code CLI, user `maxclaude`, клонит репо, копирует конфиги в
`/etc/cc-bridge/` (system-prompt, CLAUDE.template, mcp.json с playwright, skills/),
пишет `/etc/cc-bridge/env` с переданными BRIDGE_TOKEN, поднимает systemd unit,
получает SSL через certbot, настраивает nginx (proxy на /v1/*, статика
`/files/...`, viewer steel-browser на `/browser/{steelId}/`). При `WITH_BROWSER=1`
дополнительно ставит Docker и запускает контейнер `ghcr.io/steel-dev/steel-browser:latest`
на `127.0.0.1:3000`. В конце — инструкция по одноразовому OAuth-логину Claude.

`BRIDGE_DOMAIN` и `BRIDGE_TOKEN` обычно генерируются через дашборд SaaS
(`maxtable.pro/dashboard/server`) — там же показывается полная команда с уже
зашитым `WITH_BROWSER=1`.

### Удалённый браузер (`WITH_BROWSER=1`)

Подробности — план в [docs/](docs/) и память Claude. Кратко:

- `steel-browser` контейнер на `127.0.0.1:3000` (combined image: API + viewer)
- `mcp.json` подключает `@playwright/mcp@latest`; mcpMerge при `usesBrowser=true`
  добавляет `--cdp-endpoint=ws://...` → playwright цепляется к chromium в steel
- nginx-роут `/browser/{steelId}/?token=<JWT>` с `auth_request → SaaS
  /auth/browser-check` (SaaS подписывает JWT; nginx проверяет через Cloudflare
  с правильным SNI и резолвером). HTML-viewer `/v1/sessions/debug` модифицируется
  on-the-fly через `sub_filter` (заменяет `ws://0.0.0.0:3000` на `wss://<host>`).
  Дополнительный location `^~ /v1/sessions/cast` пропускает WebSocket screencast
  напрямую в steel-контейнер.
- Сессии в БД `browser_sessions` (миграция 004), idle-GC через 15 минут.

**Обновления** на уже работающем сервере:

```bash
ssh maxclaude@<host>
cd /opt/cc-bridge
git pull
sudo systemctl restart cc-bridge
```

## Конвенции кода

- TypeScript без компиляции — нативные types стрипаются Node.js 20 (`--experimental-strip-types`)
- Импорты с `.ts` расширением (Node 22+ требование)
- Без бандлера, без TypeScript compiler — только Node
- Логи через Fastify/pino — в journalctl через systemd
- Все ошибки → structured JSON в stderr

## История

- 2026-04-19: initial skeleton + deployment infra
- 2026-05-11: model/project params, system-prompt protocol (Sheets-context), /publish skill, env CC_CALLER/CC_CHAT_ID/CC_APP_PORT/CC_FILES_BASE_URL, structured response в /status (summary, files[], appUrl)
- 2026-05-12: multi-tenant по умолчанию (workdir с email юзера), nginx-конфиг с email-сегментом URL, install-claude.sh без SaaS install-token (BRIDGE_DOMAIN+BRIDGE_TOKEN из env напрямую)
- 2026-05-12: **удалённый браузер через steel-browser.** Combined image `ghcr.io/steel-dev/steel-browser:latest` под `WITH_BROWSER=1`, playwright MCP в дефолтном mcp.json, миграция 004 (browser_sessions), nginx-роут `/browser/{id}/?token=<JWT>` с двойной защитой (JWT привязан к steelId через SaaS), sub_filter для переписывания захардкоженных `ws://0.0.0.0:3000` в HTML viewer-а, прокидывание WS `/v1/sessions/cast` напрямую в steel. SaaS `/auth/browser-check` принимает token-mode и cookie-mode. Idle-GC 15 минут. Чтобы все шаги (Docker+steel+playwright MCP+nginx routing) ставились одной командой — `WITH_BROWSER=1` всегда зашит в команду установки от SaaS.
- 2026-05-12: **проекты как первичная сущность.** Таблица `projects(id, name, slug)`, FK `chats.project_id`, миграция 002 + auto-seeding для существующих prod-БД. Новый формат имени чата `YYMMDD_HHMM_XX`. Параметр `projectName` в `/run` с полной семантикой (создать / добавить чат / переименовать / 409). Slugify с транслитерацией кириллицы. Разделение `workdir` (cwd Claude) и `chat_dir` (артефакты). Nginx-location'ы для project и solo чатов + legacy fallback. Endpoint `GET /meta/projects`. Старые workdir'ы НЕ перемещаются — workdir в БД остаётся валидным.
