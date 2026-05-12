# /new-project — создание нового проекта (Next.js или другой стэк)

Юзер пишет: «создай Next.js проект "Cities"», «новый проект с БД», и т.п.

## Что делает скилл

Создаёт shared-проект в `/workspaces/{email}/projects/{slug}/` и разворачивает в нём стартовый шаблон. После этого у проекта появляется собственный URL `<CC_FILES_BASE_URL заменить /files/ на /apps/>/{slug}/`, привязанный к `$CC_APP_PORT`.

**ВАЖНО:** скилл предполагает, что вызов уже пришёл В контексте этого проекта (юзер передал `projectName` в формуле, и cc-bridge поставил `$CC_PROJECT_SLUG`). Если `$CC_PROJECT_SLUG` пуст — попроси юзера задать имя проекта в формуле и не продолжай.

## Алгоритм для Next.js

1. Проверь, что в текущей папке (это корень проекта) НЕТ уже `package.json`:
   ```bash
   if [ -f package.json ]; then
     echo "Проект уже инициализирован"; exit
   fi
   ```
2. Развернуть Next.js (App Router, TypeScript, Tailwind):
   ```bash
   npx create-next-app@latest . --ts --app --tailwind --no-eslint --use-npm --import-alias "@/*" --skip-install
   npm install
   ```
3. Записать порт в `.env.local`:
   ```bash
   cat > .env.local <<EOF
   PORT=$CC_APP_PORT
   HOSTNAME=127.0.0.1
   EOF
   ```
4. Если юзер просил БД — вызови скилл `/db`:
   - `--db=sqlite` (по умолчанию): добавь `better-sqlite3`, создай `lib/db.ts` с подключением к `./db.sqlite`.
   - `--db=postgres`: вызови `/db create` для создания БД и установки `DATABASE_URL`.
5. Стартанёшь dev-server:
   ```bash
   nohup npm run dev > .next-dev.log 2>&1 &
   echo $! > .next-dev.pid
   ```
6. Сообщи юзеру URL — `$CC_FILES_BASE_URL` с заменой `/files/` на `/apps/` (это путь до корня проекта).

## Другие стэки

Аналогично, но `npx create-vite@latest` / `npm create astro@latest` и т.п. Главное:
- Биндить на `127.0.0.1:$CC_APP_PORT`.
- Положить файлы в корень workdir.
- Запустить dev-server в фоне с pid-файлом.

## Если юзер просит остановить/перезапустить

```bash
# stop
[ -f .next-dev.pid ] && kill $(cat .next-dev.pid) 2>/dev/null
# restart
bash -c "kill $(cat .next-dev.pid) 2>/dev/null; nohup npm run dev > .next-dev.log 2>&1 & echo \$! > .next-dev.pid"
```

## Ответ юзеру

Коротко: «Проект {name} развёрнут на Next.js. Доступен по адресу: <URL>. БД: sqlite (./db.sqlite). dev-server запущен в фоне.»
