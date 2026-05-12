# /db — управление базой данных проекта

Юзер пишет: «создай БД для проекта», «подключи postgres», «дай мне sqlite».

## Два режима

### SQLite (по умолчанию, ничего ставить не надо)

Файл живёт в корне проекта (`./db.sqlite`). Любой Node-код подключается через `better-sqlite3`:

```bash
npm install better-sqlite3
```

```typescript
import Database from 'better-sqlite3';
export const db = new Database('./db.sqlite');
```

Подходит для 99% кейсов: дашборды, парсеры, демо. Один файл = одна БД, изоляция на уровне проекта.

### PostgreSQL (когда нужны реляции / параллельные коннекты / extensions)

Требует, чтобы на VPS уже стоял postgres. Проверь:

```bash
if ! command -v psql >/dev/null 2>&1; then
  echo "PostgreSQL не установлен. Попроси админа: sudo apt install postgresql"
  exit 1
fi
```

#### Создание БД для проекта

Имя БД и юзера = `$CC_PROJECT_SLUG` (унификация). Пароль — рандомный.

```bash
SLUG="$CC_PROJECT_SLUG"
[ -z "$SLUG" ] && { echo "Нет $CC_PROJECT_SLUG — сначала создай проект"; exit 1; }
PASS=$(openssl rand -hex 16)

sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
CREATE USER "${SLUG}" WITH PASSWORD '${PASS}';
CREATE DATABASE "${SLUG}" OWNER "${SLUG}";
GRANT ALL PRIVILEGES ON DATABASE "${SLUG}" TO "${SLUG}";
SQL

# Записать DATABASE_URL в .env.local проекта (если Next.js) либо .env
URL="postgres://${SLUG}:${PASS}@127.0.0.1:5432/${SLUG}"
if [ -f .env.local ]; then
  echo "DATABASE_URL=\"${URL}\"" >> .env.local
else
  echo "DATABASE_URL=\"${URL}\"" >> .env
fi
```

`sudo -u postgres` обычно требует прав. На cc-bridge юзер maxclaude не имеет sudo. Если sudo не разрешён — попроси юзера выполнить команду вручную или добавить sudoers-правило.

#### Удаление БД проекта

```bash
SLUG="$CC_PROJECT_SLUG"
sudo -u postgres psql <<SQL
DROP DATABASE IF EXISTS "${SLUG}";
DROP USER IF EXISTS "${SLUG}";
SQL
```

## Что НЕ делать

- Не клади БД-файл в `outputs/` — там раздаётся статика, БД будет утечкой.
- Не клади credentials в код. Всегда в `.env` / `.env.local`, и `.gitignore`.
- Не делай `DROP TABLE` без явного запроса юзера.

## Ответ юзеру

Кратко: «БД {type} создана для проекта {slug}. Подключение через DATABASE_URL в .env.local.»
