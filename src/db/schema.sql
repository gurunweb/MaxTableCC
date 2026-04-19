-- cc-bridge SQLite schema
-- WAL mode включается в коде при открытии

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- Чаты (= workdir'ы Claude-сессий)
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,                  -- chatId (например 'chat-abc123')
  user_email TEXT NOT NULL,             -- email юзера (из SaaS)
  first_prompt TEXT,                    -- первый промпт (превью для sidebar)
  last_prompt TEXT,                     -- последний промпт
  last_action TEXT,                     -- последнее действие Claude (live-статус)
  workdir TEXT NOT NULL,                -- абсолютный путь /workspaces/{email}/chats/{id}/
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chats_user ON chats(user_email, updated_at DESC);

-- Задачи
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,                  -- taskId
  chat_id TEXT NOT NULL,
  status TEXT NOT NULL,                 -- pending|running|done|error|needs-input|paused|awaiting_approval|rate_limited|timeout
  prompt_preview TEXT,                  -- первые 500 символов промпта
  mode TEXT NOT NULL DEFAULT 'auto',    -- auto|plan|safe
  max_time_sec INTEGER NOT NULL DEFAULT 1320,
  result TEXT,                          -- финальный ответ (если done)
  partial_result TEXT,                  -- частичный результат (если paused)
  pause_summary TEXT,                   -- summary от Claude при паузе (что сделано/осталось)
  approval_prompt TEXT,                 -- текст вопроса при awaiting_approval
  error_message TEXT,                   -- при status=error/timeout
  steps_done INTEGER NOT NULL DEFAULT 0,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,                  -- NULL пока не finished
  pid INTEGER,                          -- PID Claude процесса (пока running)
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tasks_chat ON tasks(chat_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, started_at DESC);

-- Лог действий (tool-use events от PostToolUse hook)
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  kind TEXT NOT NULL,                   -- emoji-код: 🔍/⚙️/✍️/🎭/💬
  summary TEXT NOT NULL,                -- короткое описание "web: market.yandex.ru"
  full_payload TEXT,                    -- JSON с полными параметрами tool-use (опционально)
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_actions_task ON actions(task_id, id);

-- View для быстрого polling (status + свежие действия)
CREATE VIEW IF NOT EXISTS task_status AS
SELECT
  t.id AS task_id,
  t.chat_id,
  t.status,
  t.result,
  t.partial_result,
  t.pause_summary,
  t.approval_prompt,
  t.error_message,
  t.steps_done,
  t.tokens_used,
  t.started_at,
  t.finished_at,
  (SELECT COUNT(*) FROM actions WHERE task_id = t.id) AS total_actions
FROM tasks t;
