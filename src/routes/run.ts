import type { FastifyPluginAsync } from 'fastify';
import type Database from 'better-sqlite3';
import { startTask } from '../lib/claudeRunner.ts';
import {
  findProject,
  createProject,
  renameProject,
  slugifyProjectName,
} from '../lib/chats.ts';

interface Options {
  db: Database.Database;
}

interface RunBody {
  userEmail: string;
  chatId?: string;
  prompt: string;
  mode?: 'auto' | 'plan' | 'safe';
  maxTimeSec?: number;
  resumeFromPausedTask?: string;
  /** Модель: 'opus' | 'sonnet' | 'haiku' (фиксируется за чатом на первом запуске). */
  model?: string;
  /**
   * Имя проекта. См. таблицу семантики в plan/cc-bridge:
   *   - не задано  → одиночный чат (в /chats/) или resume на месте.
   *   - задано     → создать проект / добавить чат / переименовать (зависит от состояния).
   */
  projectName?: string;
}

const ALLOWED_MODELS = new Set(['opus', 'sonnet', 'haiku']);

export const runRoute: FastifyPluginAsync<Options> = async (fastify, opts) => {
  const db = opts.db;

  fastify.post<{ Body: RunBody }>('/', async (request, reply) => {
    const b = request.body;

    if (!b || typeof b.prompt !== 'string' || b.prompt.trim().length === 0) {
      return reply.code(400).send({ error: 'prompt_required' });
    }
    if (typeof b.userEmail !== 'string' || !b.userEmail.includes('@')) {
      return reply.code(400).send({ error: 'invalid_user_email' });
    }

    const model = b.model && ALLOWED_MODELS.has(b.model) ? b.model : undefined;

    // ─── Резолв проекта ───────────────────────────────────────────────────────
    // На выходе: projectId, projectSlug, projectName (или все null — одиночный чат).
    let projectId: string | null = null;
    let projectSlug: string | null = null;
    let projectName: string | null = null;

    const rawProjectName = typeof b.projectName === 'string' ? b.projectName.trim() : '';
    const hasChatId = typeof b.chatId === 'string' && b.chatId.trim().length > 0;

    // Текущий проект чата (если чат уже существует)
    let currentChatProjectId: string | null = null;
    let currentChatProjectSlug: string | null = null;
    if (hasChatId) {
      const row = db
        .prepare(
          `SELECT c.project_id, p.slug
           FROM chats c LEFT JOIN projects p ON c.project_id = p.id
           WHERE c.id = ?`,
        )
        .get(b.chatId) as { project_id: string | null; slug: string | null } | undefined;
      if (row) {
        currentChatProjectId = row.project_id;
        currentChatProjectSlug = row.slug;
      }
    }

    if (rawProjectName) {
      const slug = slugifyProjectName(rawProjectName);
      if (!slug) {
        return reply.code(400).send({
          error: 'invalid_project_name',
          message:
            'Название проекта должно содержать 2–40 символов (буквы/цифры/-/_), не быть зарезервированным.',
        });
      }

      // Сценарий: продолжение чата в проекте, имя совпадает с текущим — no-op
      if (hasChatId && currentChatProjectSlug === slug) {
        projectId = currentChatProjectId;
        projectSlug = slug;
        projectName = rawProjectName;
      }
      // Сценарий: продолжение чата в проекте, новое имя — RENAME проекта
      else if (hasChatId && currentChatProjectId) {
        try {
          const renamed = renameProject(
            db,
            b.userEmail,
            currentChatProjectId,
            rawProjectName,
            slug,
          );
          projectId = renamed.id;
          projectSlug = renamed.slug;
          projectName = renamed.name;
        } catch (err: any) {
          if (err.code === 'project_exists') {
            return reply.code(409).send({
              error: 'project_exists',
              message: `Название проекта «${rawProjectName}» (slug: ${slug}) уже занято. Выбери другое.`,
            });
          }
          if (err.code === 'project_not_found') {
            return reply.code(500).send({ error: 'inconsistent_state' });
          }
          throw err;
        }
      }
      // Сценарий: продолжение одиночного чата (без проекта) + projectName → запрещено
      else if (hasChatId && !currentChatProjectId) {
        // Чат может существовать без project_id, либо чата ещё нет (тогда это новый чат).
        // Если чат уже есть в БД и без проекта — отказ.
        const exists = db
          .prepare('SELECT 1 FROM chats WHERE id = ?')
          .get(b.chatId) as { 1: number } | undefined;
        if (exists) {
          return reply.code(409).send({
            error: 'cannot_move_solo_chat',
            message:
              'Одиночный чат нельзя перенести в проект. Создай новый чат с этим projectName.',
          });
        }
        // chatId передан, но чата ещё нет — трактуем как новый чат с проектом (см. ниже).
        const project = await ensureProject(db, b.userEmail, rawProjectName, slug, reply);
        if (!project) return;
        projectId = project.id;
        projectSlug = project.slug;
        projectName = project.name;
      }
      // Сценарий: новый чат + projectName
      else {
        const project = await ensureProject(db, b.userEmail, rawProjectName, slug, reply);
        if (!project) return;
        projectId = project.id;
        projectSlug = project.slug;
        projectName = project.name;
      }
    } else if (hasChatId && currentChatProjectId) {
      // Продолжение чата в проекте, projectName не передан — берём текущий проект.
      projectId = currentChatProjectId;
      projectSlug = currentChatProjectSlug;
      const p = db
        .prepare('SELECT name FROM projects WHERE id = ?')
        .get(currentChatProjectId) as { name: string } | undefined;
      projectName = p?.name ?? null;
    }
    // ─────────────────────────────────────────────────────────────────────────

    try {
      const result = startTask(db, {
        userEmail: b.userEmail,
        chatId: b.chatId,
        prompt: b.prompt,
        mode: b.mode,
        maxTimeSec: b.maxTimeSec,
        resumeFromPausedTask: b.resumeFromPausedTask,
        model,
        projectId,
        projectSlug,
        projectName,
      });
      return reply.send(result);
    } catch (err: any) {
      fastify.log.error({ err }, 'startTask failed');
      return reply.code(500).send({ error: 'start_failed', message: err.message });
    }
  });
};

/**
 * Гарантирует существование проекта (находит существующий или создаёт новый).
 * При коллизии (slug занят другим юзером — невозможно из-за UNIQUE на (user_email, slug))
 * или ошибке — отправляет reply и возвращает null.
 */
async function ensureProject(
  db: Database.Database,
  userEmail: string,
  name: string,
  slug: string,
  reply: any,
): Promise<{ id: string; slug: string; name: string } | null> {
  const existing = findProject(db, userEmail, slug);
  if (existing) return existing;
  try {
    const created = createProject(db, userEmail, name, slug);
    return created;
  } catch (err: any) {
    if (err.code === 'project_exists') {
      // race condition — крайне маловероятно, но обрабатываем
      const after = findProject(db, userEmail, slug);
      if (after) return after;
    }
    reply.code(500).send({ error: 'create_project_failed', message: err.message });
    return null;
  }
}
