-- 002_projects.sql — первичная сущность «проект» + FK на chats.project_id.
--
-- Что делает:
--   1) Создаёт таблицу projects (id, user_email, name, slug, created_at, updated_at).
--   2) Добавляет в chats колонку project_id (nullable FK → projects.id).
--   3) Мигрирует данные: для каждого чата со старым chats.project создаётся (или
--      переиспользуется) запись в projects, и chats.project_id привязывается.
--   4) Старая колонка chats.project (TEXT) НЕ удаляется на этом шаге — оставляется
--      как «hot backup» для отката. Удалить в 003_drop_legacy_project.sql после
--      нескольких дней наблюдения за prod.
--
-- ВАЖНО: ничего НЕ двигаем на ФС. chats.workdir остаётся валидным для существующих
-- чатов (старая структура папок). Новые чаты пишутся по новой структуре, см. lib/chats.ts.

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,                  -- nanoid
  user_email TEXT NOT NULL,
  name TEXT NOT NULL,                   -- человеческое имя (с кириллицей)
  slug TEXT NOT NULL,                   -- slug для ФС
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_email, slug)
);

CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_email, updated_at DESC);

-- Добавляем project_id; колонку project (старая) трогаем в 003.
ALTER TABLE chats ADD COLUMN project_id TEXT;
ALTER TABLE chats ADD COLUMN chat_dir TEXT;

CREATE INDEX IF NOT EXISTS idx_chats_project ON chats(project_id);

-- Для существующих чатов chat_dir = workdir (одиночные) или workdir для project-чатов
-- (там артефакты лежат в корне shared workdir, что соответствует старой модели).
UPDATE chats SET chat_dir = workdir WHERE chat_dir IS NULL;

-- Миграция данных: для каждого уникального (user_email, project) создаём projects
-- запись с id = 'proj_' || lower(hex(randomblob(6))), привязываем chats.project_id.
INSERT INTO projects (id, user_email, name, slug, created_at, updated_at)
SELECT
  'proj_' || lower(hex(randomblob(6))) AS id,
  user_email,
  project AS name,
  project AS slug,
  MIN(created_at) AS created_at,
  MAX(updated_at) AS updated_at
FROM chats
WHERE project IS NOT NULL AND project != ''
GROUP BY user_email, project;

UPDATE chats
SET project_id = (
  SELECT p.id FROM projects p
  WHERE p.user_email = chats.user_email AND p.slug = chats.project
)
WHERE project IS NOT NULL AND project != '';
