import type { FastifyPluginAsync } from 'fastify';
import type Database from 'better-sqlite3';
import { startTask } from '../lib/claudeRunner.ts';

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
  // На будущее: context, dataInfo (attachments). Пока — только prompt
}

export const runRoute: FastifyPluginAsync<Options> = async (fastify, opts) => {
  fastify.post<{ Body: RunBody }>('/', async (request, reply) => {
    const b = request.body;

    if (!b || typeof b.prompt !== 'string' || b.prompt.trim().length === 0) {
      return reply.code(400).send({ error: 'prompt_required' });
    }
    if (typeof b.userEmail !== 'string' || !b.userEmail.includes('@')) {
      return reply.code(400).send({ error: 'invalid_user_email' });
    }

    try {
      const result = startTask(opts.db, {
        userEmail: b.userEmail,
        chatId: b.chatId,
        prompt: b.prompt,
        mode: b.mode,
        maxTimeSec: b.maxTimeSec,
        resumeFromPausedTask: b.resumeFromPausedTask,
      });
      return reply.send(result);
    } catch (err: any) {
      fastify.log.error({ err }, 'startTask failed');
      return reply.code(500).send({ error: 'start_failed', message: err.message });
    }
  });
};
