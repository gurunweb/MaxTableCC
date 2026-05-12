# URL-схема cc-bridge

Все ходы клиента и Claude по серверу разложены по понятным URL. Базовый домен — тот, что юзер задал при установке (`BRIDGE_DOMAIN`, например `claude.example.com`).

## Таблица URL

| Что это | URL | Кто отдаёт |
|---|---|---|
| API для SaaS (запуск задач, статус, остановка) | `/v1/claudecode/*` | Node (cc-bridge) — требует `X-Bridge-Token` |
| Health check | `/health` | Node |
| Файл из чата (приватная длинная ссылка) | `/files/{email}/chats/{chatId}/outputs/<path>` | nginx alias |
| Файл из чата внутри проекта | `/files/{email}/projects/{slug}/chats/{chatId}/outputs/<path>` | nginx alias |
| Файл из shared-папки проекта (TODO) | `/files/{email}/projects/{slug}/shared/<path>` | nginx alias (пока не подключено) |
| Файл в single-tenant `WORKSPACES_FLAT=1` | те же, без сегмента `{email}/` | nginx alias |
| Публичная короткая ссылка (с TTL/без email) | `/p/{slug}` | Node — резолвит `public_links`, отдаёт через `X-Accel-Redirect` |
| Web-app проекта (Next.js, dev-server) | `/apps/{project-slug}/...` | nginx auth_request → resolver → proxy на `127.0.0.1:{app_port}` |
| Web-app одиночного чата | `/apps/c/{chatId}/...` | nginx auth_request → resolver |
| Internal (только localhost) | `/internal/*` | Node — для Claude из workdir и nginx auth_request |

## Слаги и идентификаторы

| Что | Формат | Источник |
|---|---|---|
| `email` | как есть, но safe (`a-z A-Z 0-9 @ . _ -`) | от SaaS |
| `chatId` | новый: `YYMMDD_HHMM_XX`; старый: `chat-<nanoid>` | автогенерация |
| `project slug` | lower-case ASCII, дефисы, `[a-z0-9_-]{2,40}` | `slugifyProjectName()` |
| `public link slug` | nanoid 10 символов | `nanoid(10)` |

### Зарезервированные slug

Запрещены: `chats`, `projects`, `attachments`, `outputs`, `claude`, `.claude`, начинающиеся с `_`. См. [src/lib/chats.ts](../src/lib/chats.ts).

### Различение project-slug vs chatId

Project-slug — `[a-z0-9_-]`, не начинается с цифры по конвенции, не может равняться `c`.
ChatId — содержит подчёркивания/большие буквы (формат `YYMMDD_HHMM_XX`).
Поэтому в `/apps/...` префикс `c/` явно маркирует чат.

## Port allocation

`app_port` раздаётся из пула `3000-3999`. Один порт принадлежит либо чату (`chats.app_port`), либо проекту (`projects.app_port`). Резервируется при первом запуске чата / создании проекта, не освобождается (TODO: GC).

Внутри dev-server'а биндинг должен быть `127.0.0.1:$CC_APP_PORT`. Снаружи nginx раскрывает на тот же порт через `/apps/...`.

## Резолвинг (auth_request)

```
nginx           cc-bridge
  GET /apps/cities/login
       │
       └─auth_request──► GET /internal/resolve-app/project/cities
                            ◄── 200 + X-App-Port: 3041
       │
       └─proxy_pass──────► http://127.0.0.1:3041/login
```

Если резолвер вернул 404 — nginx отдаёт 401/403 юзеру (auth_request не пропустил). Это норма: проект/чат не создан или порт не назначен.

## Что НЕ через URL

- Сессии Claude — `claude_session_id` хранится в БД и передаётся CLI через `--resume`. Юзер их не видит.
- MCP-конфиги — `.mcp.json` в workdir-папках, не URL.
- Hook-настройки — `.claude/settings.json` в workdir, не URL.
