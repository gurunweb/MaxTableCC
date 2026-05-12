// /internal/resolve-app — резолвит slug проекта или ID чата в порт dev-server'а.
// Используется nginx-ом через auth_request: nginx запрашивает порт, дальше
// проксирует на 127.0.0.1:{port}.
//
// URL-схема:
//   GET /internal/resolve-app/project/{slug}    -> { port }
//   GET /internal/resolve-app/chat/{chatId}     -> { port }
//
// Nginx использует заголовок X-App-Port из ответа.

import type { FastifyPluginAsync } from 'fastify';
import type Database from 'better-sqlite3';

interface Options {
  db: Database.Database;
}

export const resolveAppRoute: FastifyPluginAsync<Options> = async (fastify, opts) => {
  const db = opts.db;

  fastify.get<{ Params: { slug: string } }>('/project/:slug', async (request, reply) => {
    const slug = request.params.slug;
    if (!/^[a-z0-9_-]{2,40}$/.test(slug)) {
      return reply.code(404).send({ error: 'bad_slug' });
    }
    const row = db
      .prepare('SELECT app_port FROM projects WHERE slug = ?')
      .get(slug) as { app_port: number | null } | undefined;
    if (!row || row.app_port == null) {
      return reply.code(404).send({ error: 'project_or_port_not_found' });
    }
    reply.header('X-App-Port', String(row.app_port));
    return reply.send({ port: row.app_port });
  });

  fastify.get<{ Params: { chatId: string } }>('/chat/:chatId', async (request, reply) => {
    const chatId = request.params.chatId;
    if (!/^[A-Za-z0-9_-]{4,40}$/.test(chatId)) {
      return reply.code(404).send({ error: 'bad_chat_id' });
    }
    const row = db
      .prepare('SELECT app_port FROM chats WHERE id = ?')
      .get(chatId) as { app_port: number | null } | undefined;
    if (!row || row.app_port == null) {
      return reply.code(404).send({ error: 'chat_or_port_not_found' });
    }
    reply.header('X-App-Port', String(row.app_port));
    return reply.send({ port: row.app_port });
  });
};
