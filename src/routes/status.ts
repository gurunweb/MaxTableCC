import type { FastifyPluginAsync } from 'fastify';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

interface Options {
  db: Database.Database;
}

interface StatusQuery {
  afterActionId?: string; // incremental: только новые actions с id > afterActionId
}

/** Первая непустая строка результата — компактное summary для статус-ячейки. */
function extractSummary(result: string | null): string | null {
  if (!result) return null;
  const line = result.split(/\r?\n/).find((l) => l.trim().length > 0);
  return line ? line.trim().slice(0, 240) : null;
}

/**
 * Собирает выходные файлы чата (outputs/) с URL-ами.
 * `chatDir` — папка чат-артефактов (для одиночного чата = workdir, для project — подпапка).
 * `projectSlug` — для построения URL через nginx (если чат в проекте).
 */
function listOutputFiles(
  chatDir: string,
  chatId: string,
  userEmail: string,
  projectSlug: string | null,
  filesBaseUrl: string,
): Array<{ name: string; url: string; size: number }> {
  const outDir = join(chatDir, 'outputs');
  const flat = process.env.WORKSPACES_FLAT === '1';
  const safeEmail = (userEmail || '').replace(/[^a-zA-Z0-9@._-]/g, '_');
  try {
    const entries = readdirSync(outDir, { withFileTypes: true });
    const result: Array<{ name: string; url: string; size: number }> = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      const full = join(outDir, e.name);
      let size = 0;
      try { size = statSync(full).size; } catch { /* noop */ }
      const base = filesBaseUrl.replace(/\/+$/, '');
      const emailSeg = flat ? '' : `${safeEmail}/`;
      const pathSeg = projectSlug
        ? `${emailSeg}projects/${projectSlug}/chats/${chatId}`
        : `${emailSeg}chats/${chatId}`;
      const url = base ? `${base}/files/${pathSeg}/outputs/${encodeURIComponent(e.name)}` : '';
      result.push({ name: e.name, url, size });
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export const statusRoute: FastifyPluginAsync<Options> = async (fastify, opts) => {
  const db = opts.db;
  const filesBaseUrl = process.env.CC_FILES_BASE_URL ?? '';

  fastify.get<{ Params: { taskId: string }; Querystring: StatusQuery }>(
    '/:taskId',
    async (request, reply) => {
      const { taskId } = request.params;
      const afterId = Number(request.query.afterActionId ?? 0);

      const task = db
        .prepare(
          `SELECT t.id, t.chat_id, t.status, t.result, t.partial_result, t.pause_summary,
                  t.approval_prompt, t.error_message, t.steps_done, t.tokens_used,
                  t.started_at, t.finished_at, t.mode, t.max_time_sec, t.prompt_preview,
                  c.workdir, c.chat_dir, c.app_port, c.model, c.user_email,
                  c.project_id, p.name as project_name, p.slug as project_slug
           FROM tasks t
           LEFT JOIN chats c ON c.id = t.chat_id
           LEFT JOIN projects p ON p.id = c.project_id
           WHERE t.id = ?`,
        )
        .get(taskId) as
        | {
            id: string;
            chat_id: string;
            status: string;
            result: string | null;
            partial_result: string | null;
            pause_summary: string | null;
            approval_prompt: string | null;
            error_message: string | null;
            steps_done: number;
            tokens_used: number;
            started_at: number;
            finished_at: number | null;
            mode: string;
            max_time_sec: number;
            prompt_preview: string | null;
            workdir: string | null;
            chat_dir: string | null;
            app_port: number | null;
            model: string | null;
            user_email: string | null;
            project_id: string | null;
            project_name: string | null;
            project_slug: string | null;
          }
        | undefined;

      if (!task) {
        return reply.code(404).send({ error: 'task_not_found' });
      }

      const actions = db
        .prepare(
          `SELECT id, timestamp, kind, summary FROM actions
           WHERE task_id = ? AND id > ? ORDER BY id ASC LIMIT 200`,
        )
        .all(taskId, afterId) as Array<{
        id: number;
        timestamp: number;
        kind: string;
        summary: string;
      }>;

      const lastActionId = actions.length > 0 ? actions[actions.length - 1].id : afterId;

      // Структурированный возврат — для GAS: summary (первая строка), files[], appUrl
      const isFinal = ['done', 'paused', 'error', 'timeout', 'cancelled'].includes(task.status);
      const chatDir = task.chat_dir ?? task.workdir;
      const files =
        isFinal && chatDir
          ? listOutputFiles(
              chatDir,
              task.chat_id,
              task.user_email ?? '',
              task.project_slug,
              filesBaseUrl,
            )
          : [];
      const appUrl =
        task.app_port && filesBaseUrl
          ? `${filesBaseUrl.replace(/\/+$/, '')}/apps/${task.chat_id}`
          : null;
      const summary =
        extractSummary(task.result) ?? extractSummary(task.partial_result) ?? null;

      return reply.send({
        taskId: task.id,
        chatId: task.chat_id,
        status: task.status,
        mode: task.mode,
        model: task.model,
        project: task.project_slug
          ? { id: task.project_id, name: task.project_name, slug: task.project_slug }
          : null,
        stepsDone: task.steps_done,
        tokensUsed: task.tokens_used,
        startedAt: task.started_at,
        finishedAt: task.finished_at,
        result: task.result,
        partialResult: task.partial_result,
        pauseSummary: task.pause_summary,
        approvalPrompt: task.approval_prompt,
        errorMessage: task.error_message,
        summary,
        files,
        appUrl,
        newActions: actions,
        lastActionId,
      });
    },
  );
};
