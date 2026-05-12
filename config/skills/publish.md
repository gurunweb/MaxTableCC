# /publish — публикация файла или папки

Возвращает чистый URL на файл / папку из текущего workdir.

## Использование

Юзер пишет:
- «опубликуй outputs/hello.html»
- «дай ссылку на этот файл»
- «выложи всю папку outputs/»

Ты вызываешь internal endpoint cc-bridge:

```bash
curl -s -X POST http://127.0.0.1:8080/internal/publish \
  -H 'Content-Type: application/json' \
  -d '{"chatId":"'"$CC_CHAT_ID"'","path":"outputs/hello.html","public":true}'
```

Параметры:
- `chatId` — обязательно, бери из `$CC_CHAT_ID`.
- `path` — относительный путь от workdir чата (например `outputs/hello.html` или `outputs/`).
- `public` — **по умолчанию `true`**. Возвращает короткий URL `/p/{slug}` без email в пути. Безопасно скидывать кому угодно.
- `public:false` — длинный URL с email в пути. Используй ТОЛЬКО когда юзер явно просит «приватный URL, без короткой ссылки» (редкий кейс).

PostToolUse hook автоматически делает `public:true` для всех файлов созданных через Write/Edit — тебе обычно не нужно дергать `/internal/publish` руками.
- `ttl` — опционально, для публичных: секунды до истечения (по умолчанию бессрочно).

Ответ:
```json
{ "ok": true, "url": "https://files.maxidea.pro/files/chat-xxx/outputs/hello.html" }
```

## Что делать с URL

Просто верни юзеру голым URL-ом в ответе (Sheets его кликабельным сделает сами):

```
Опубликовал hello.html: https://files.maxidea.pro/files/chat-xxx/outputs/hello.html
```

Не оборачивай в `[link](...)` — markdown в Sheets не рендерится.

## Особые случаи

- Файл не существует → endpoint вернёт 404, ты сообщи юзеру, что файла нет.
- Если юзер просит «выложи всё» — отправь `path: "outputs/"` (с трейлинг-слешем), вернёт URL папки (browseable).
