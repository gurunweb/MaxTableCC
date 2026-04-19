import type { FastifyPluginAsync } from 'fastify';
import type Database from 'better-sqlite3';

interface Options {
  db: Database.Database;
}

interface StatusQuery {
  afterActionId?: string; // incremental: только новые actions с id > afterActionId
}

export const statusRoute: FastifyPluginAsync<Options> = async (fastify, opts) => {
  const db = opts.db;

  fastify.get<{ Params: { taskId: string }; Querystring: StatusQuery }>(
    '/:taskId',
    async (request, reply) => {
      const { taskId } = request.params;
      const afterId = Number(request.query.afterActionId ?? 0);

      const task = db
        .prepare(
          `SELECT id, chat_id, status, result, pause_summary, approval_prompt,
                  error_message, steps_done, tokens_used, started_at, finished_at,
                  mode, max_time_sec, prompt_preview
           FROM tasks WHERE id = ?`,
        )
        .get(taskId) as
        | {
            id: string;
            chat_id: string;
            status: string;
            result: string | null;
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
          }
        | undefined;

      if (!task) {
        return reply.code(404).send({ error: 'task_not_found' });
      }

      // Новые actions после afterActionId
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

      return reply.send({
        taskId: task.id,
        chatId: task.chat_id,
        status: task.status,
        mode: task.mode,
        stepsDone: task.steps_done,
        tokensUsed: task.tokens_used,
        startedAt: task.started_at,
        finishedAt: task.finished_at,
        result: task.result,
        pauseSummary: task.pause_summary,
        approvalPrompt: task.approval_prompt,
        errorMessage: task.error_message,
        newActions: actions,
        lastActionId,
      });
    },
  );
};
