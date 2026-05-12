-- 003_projects_app_port.sql
-- Добавляет колонку projects.app_port — выделенный TCP-порт для dev-server'а проекта.
-- Раздаётся из того же пула, что chats.app_port (3000-3999), хранится отдельно.
-- Webapp проекта проксируется nginx-ом по /apps/{slug}/ → 127.0.0.1:app_port.

ALTER TABLE projects ADD COLUMN app_port INTEGER;

CREATE INDEX IF NOT EXISTS idx_projects_app_port ON projects(app_port);
