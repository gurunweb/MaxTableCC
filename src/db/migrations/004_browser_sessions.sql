-- 004_browser_sessions.sql
-- Таблица сессий headed-chromium, управляемых через steel-browser.
-- Создаётся одна сессия на чат или проект (см. scope), переиспользуется в течение жизни.
-- Авто-закрытие по idle (15 мин) — см. cron в src/index.ts.

CREATE TABLE IF NOT EXISTS browser_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,                  -- 'project' | 'chat'
  scope_id TEXT NOT NULL,               -- project_id ИЛИ chat_id (в зависимости от scope)
  user_email TEXT NOT NULL,             -- владелец (для multi-tenant изоляции)
  steel_id TEXT NOT NULL UNIQUE,        -- идентификатор сессии в steel-browser
  ws_endpoint TEXT NOT NULL,            -- CDP-ws URL для playwright connectOverCDP
  viewer_path TEXT NOT NULL,            -- путь для nginx: /browser/{steel_id}/
  status TEXT NOT NULL DEFAULT 'active',-- active | closed
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  closed_at INTEGER
);

-- Один active per (scope, scope_id) — если scope=project, на проект; если scope=chat, на чат.
CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_sessions_active
  ON browser_sessions(scope, scope_id) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_browser_sessions_user
  ON browser_sessions(user_email, status, last_used_at DESC);

CREATE INDEX IF NOT EXISTS idx_browser_sessions_idle
  ON browser_sessions(status, last_used_at);
