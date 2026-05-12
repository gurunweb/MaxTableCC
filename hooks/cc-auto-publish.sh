#!/bin/bash
# cc-auto-publish.sh — PostToolUse hook для cc-bridge.
# Если Claude создал/изменил публикуемый файл внутри outputs/ — автоматически
# вызывает /internal/publish и отдаёт URL обратно как additionalContext.
#
# Вход: JSON через stdin от Claude Code:
#   {session_id, hook_event_name, tool_name, tool_input, tool_response, cwd}
# Выход: JSON в stdout с полем hookSpecificOutput.additionalContext — попадает
#   в контекст Claude и он использует URL в финальном ответе.
#
# Никогда не блокирует turn (exit 0 всегда).

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // ""')

# Hook реагирует только на изменения файлов.
case "$TOOL" in
  Write|Edit|MultiEdit|NotebookEdit) ;;
  *) exit 0 ;;
esac

FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // ""')
[ -z "$FILE" ] && exit 0

# Файл должен лежать внутри workdir чата под outputs/.
# CC_CHAT_DIR — это chats/{chatId}/ внутри workspaces (см. claudeRunner env).
WORKDIR="${CC_CHAT_DIR:-${PWD}}"
OUTPUTS_DIR="${WORKDIR%/}/outputs"

# Канонизируем и проверяем префикс.
case "$FILE" in
  "$OUTPUTS_DIR"/*) REL="${FILE#${WORKDIR%/}/}" ;;
  *) exit 0 ;;
esac

# Allowlist — публикуем только видимые юзеру форматы.
case "${FILE,,}" in
  *.png|*.jpg|*.jpeg|*.gif|*.webp|*.svg|*.bmp|*.ico) ;;
  *.html|*.htm|*.pdf|*.csv|*.tsv|*.xlsx|*.docx|*.txt|*.md|*.json) ;;
  *.mp4|*.webm|*.mov|*.mp3|*.wav|*.ogg|*.m4a) ;;
  *.zip|*.tar|*.gz|*.tgz) ;;
  *) exit 0 ;;
esac

CHAT_ID="${CC_CHAT_ID:-}"
[ -z "$CHAT_ID" ] && exit 0

BRIDGE_URL="${CC_BRIDGE_INTERNAL_URL:-http://127.0.0.1:8080}"

# public:true → endpoint вернёт короткий URL /p/{slug} без email в пути.
# Если юзер хочет приватный URL (с email-сегментом) — он явно попросит Claude
# через skill /publish с public:false.
RESP=$(curl -s -m 5 -X POST "${BRIDGE_URL%/}/internal/publish" \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg c "$CHAT_ID" --arg p "$REL" '{chatId:$c, path:$p, public:true}')" 2>/dev/null)

URL=$(echo "$RESP" | jq -r '.url // empty' 2>/dev/null)
[ -z "$URL" ] && exit 0

CTX="Файл $REL опубликован: $URL"
jq -nc --arg ctx "$CTX" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: $ctx
  }
}'
exit 0
