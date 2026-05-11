-- 001_model_project_apps.sql — добавляем model/project/app_port в chats + новые таблицы apps/public_links.
-- Применяется к существующей prod-БД, в которой уже есть таблицы chats/tasks/actions.

ALTER TABLE chats ADD COLUMN model TEXT;
ALTER TABLE chats ADD COLUMN project TEXT;
ALTER TABLE chats ADD COLUMN app_port INTEGER;

CREATE TABLE IF NOT EXISTS apps (
  chat_id TEXT PRIMARY KEY,
  port INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle',
  started_at INTEGER,
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public_links (
  slug TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  path TEXT NOT NULL,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_public_links_chat ON public_links(chat_id);
