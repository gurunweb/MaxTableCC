import type { FastifyPluginAsync } from 'fastify';
import type Database from 'better-sqlite3';
import { stopTask } from '../lib/claudeRunner.ts';

interface Options {
  db: Database.Database;
}

export const stopRoute: FastifyPluginAsync<Options> = async (fastify, opts) => {
  fastify.post<{ Params: { taskId: string } }>('/:taskId', async (request, reply) => {
    const { taskId } = request.params;
    const ok = stopTask(opts.db, taskId);
    if (!ok) {
      return reply.code(404).send({ error: 'task_not_running', message: 'task not found or already finished' });
    }
    return reply.send({ ok: 1, taskId });
  });
};
