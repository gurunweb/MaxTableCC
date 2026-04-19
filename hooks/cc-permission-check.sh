#!/bin/bash
# cc-permission-check.sh — PreToolUse hook для safe-режима cc-bridge.
# Вход: JSON через stdin от Claude Code ({session_id, hook_event_name, tool_name, tool_input, cwd})
# Выход:
#   exit 0 — allow
#   exit 2 с [CC_AWAITING_APPROVAL] или [CC_DENIED] в stderr — block
# cc-bridge парсит stderr и переводит задачу в awaiting_approval.

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // ""')
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // ""')
PATH_ARG=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // ""')
CWD=$(echo "$INPUT" | jq -r '.cwd // ""')

# --- BLOCK: автоматический deny ---
if echo "$CMD" | grep -qE '^\s*sudo\s'; then
  echo "[CC_DENIED] sudo запрещён: $CMD" >&2
  exit 2
fi
if echo "$CMD" | grep -qE '(rm\s+-rf\s+/|chmod\s+[0-7]+\s+/etc|curl.*>\s*/etc)'; then
  echo "[CC_DENIED] разрушительная операция: $CMD" >&2
  exit 2
fi

# --- Read-only + чтение/запись в workdir → allow ---
case "$TOOL" in
  Read|Glob|Grep|WebSearch|WebFetch|TodoWrite|Task|NotebookRead|SlashCommand|ToolSearch)
    exit 0
    ;;
esac

# Write/Edit только в пределах workdir (CWD)
if [[ "$TOOL" == "Write" || "$TOOL" == "Edit" || "$TOOL" == "MultiEdit" || "$TOOL" == "NotebookEdit" ]]; then
  if [[ -n "$PATH_ARG" && "$PATH_ARG" == "$CWD"* ]]; then
    # запрет на attachments/ (input-папка)
    if [[ "$PATH_ARG" == "$CWD/attachments/"* ]]; then
      echo "[CC_DENIED] запись в attachments/ запрещена: $PATH_ARG" >&2
      exit 2
    fi
    exit 0
  fi
  echo "[CC_AWAITING_APPROVAL] type=$TOOL reason=Запись вне workdir: $PATH_ARG" >&2
  exit 2
fi

# Bash: различаем безопасные vs требующие одобрения
if [[ "$TOOL" == "Bash" ]]; then
  # Безопасные read-only команды
  if echo "$CMD" | grep -qE '^\s*(ls|cat|head|tail|find|grep|rg|jq|wc|echo|pwd|which|file|du|df|date|uname|stat|tree|diff|sort|uniq|awk|sed)\b'; then
    exit 0
  fi
  # Выполнение собственных скриптов в workdir
  if echo "$CMD" | grep -qE '^\s*(python3?|node|bash|sh)\s+\.?/'; then
    exit 0
  fi
  # Установка пакетов → approval
  if echo "$CMD" | grep -qE '\b(pip|pip3|npm|yarn|pnpm|apt|apt-get|brew)\s+(install|add)\b'; then
    echo "[CC_AWAITING_APPROVAL] type=pkg_install reason=Установка пакетов: $CMD" >&2
    exit 2
  fi
  # Выход за пределы workdir (абсолютные пути вне cwd)
  if echo "$CMD" | grep -qE '(^|\s)(/home|/etc|/var|/usr|/root)/'; then
    echo "[CC_AWAITING_APPROVAL] type=fs_escape reason=Доступ за пределы workdir: $CMD" >&2
    exit 2
  fi
  # Потенциально разрушительное
  if echo "$CMD" | grep -qE '\b(rm|mv|chmod|chown)\b'; then
    echo "[CC_AWAITING_APPROVAL] type=destructive reason=Потенциально разрушительная операция: $CMD" >&2
    exit 2
  fi
  # Всё остальное — allow (работа в пределах workdir не вредна)
  exit 0
fi

# Неизвестный tool → разрешить (консервативно не трогаем MCP/custom tools)
exit 0
