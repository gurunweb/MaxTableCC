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
  -d '{"chatId":"'"$CC_CHAT_ID"'","path":"outputs/hello.html","public":false}'
```

Параметры:
- `chatId` — обязательно, бери из `$CC_CHAT_ID`.
- `path` — относительный путь от workdir чата (например `outputs/hello.html` или `outputs/`).
- `public` — `true` если хочешь публичный короткий URL (`/p/{slug}`), `false` если приватный по полному пути.
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
