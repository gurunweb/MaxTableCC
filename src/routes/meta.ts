import type { FastifyPluginAsync } from 'fastify';
import type Database from 'better-sqlite3';
import { listChats } from '../lib/chats.ts';

interface Options {
  db: Database.Database;
}

export const metaRoute: FastifyPluginAsync<Options> = async (fastify, opts) => {
  const db = opts.db;

  // Список чатов юзера (для sidebar dropdown)
  fastify.get<{ Querystring: { user: string; limit?: string } }>(
    '/chats',
    async (request, reply) => {
      const user = request.query.user;
      if (!user || !user.includes('@')) {
        return reply.code(400).send({ error: 'user_required' });
      }
      const limit = Math.min(200, Number(request.query.limit ?? 50));
      const chats = listChats(db, user, limit);
      return reply.send({ chats });
    },
  );

  // Задачи в состоянии paused (для кнопки «Продолжить» в sidebar)
  fastify.get<{ Querystring: { user?: string } }>('/paused', async (request, reply) => {
    let sql = `SELECT t.id as taskId, t.chat_id as chatId, t.prompt_preview as promptPreview,
                      t.pause_summary as pauseSummary, t.started_at as startedAt, t.finished_at as finishedAt,
                      c.first_prompt as firstPrompt, c.user_email as userEmail
               FROM tasks t JOIN chats c ON t.chat_id = c.id
               WHERE t.status = 'paused'`;
    const args: unknown[] = [];
    if (request.query.user) {
      sql += ' AND c.user_email = ?';
      args.push(request.query.user);
    }
    sql += ' ORDER BY t.started_at DESC LIMIT 100';
    const tasks = db.prepare(sql).all(...args);
    return reply.send({ tasks });
  });

  // Оставшиеся лимиты Claude Max подписки
  // Пока stub — реальный механизм через парсинг stdout `claude status` добавим позже
  fastify.get('/subscription', async (_request, reply) => {
    return reply.send({
      plan: 'claude-max',
      remaining: null, // позже заполним
      resetsAt: null,
      note: 'subscription introspection not implemented yet',
    });
  });

  // Все чаты (для админ-страницы /admin/cloudcode на SaaS)
  fastify.get('/all-chats', async (_request, reply) => {
    const chats = db.prepare(
      `SELECT id, user_email, first_prompt, last_prompt, last_action, updated_at
       FROM chats ORDER BY updated_at DESC LIMIT 200`,
    ).all();
    return reply.send({ chats });
  });

  // Все задачи (для админ-мониторинга)
  fastify.get('/all-tasks', async (_request, reply) => {
    const tasks = db.prepare(
      `SELECT id, chat_id, status, prompt_preview, mode, steps_done, tokens_used, started_at, finished_at
       FROM tasks ORDER BY started_at DESC LIMIT 300`,
    ).all();
    return reply.send({ tasks });
  });
};
