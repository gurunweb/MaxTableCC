// browser.ts — управление browser-сессиями (steel-browser).
//
// Внешние (X-Bridge-Token, /v1/*):
//   GET    /v1/browser/sessions?userEmail=…   список active сессий юзера
//   GET    /v1/browser/sessions/by-chat/:chatId  текущая сессия чата
//   POST   /v1/browser/sessions/:steelId/end     явно закрыть
//
// Внутренние (localhost, /internal/*):
//   GET    /internal/browser-auth?steelId=…&email=…
//     Используется nginx auth_request: проверяет, что email-владелец сессии
//     совпадает с email из заголовка X-Auth-Email (его проставит SaaS из cookie).

import type { FastifyPluginAsync } from 'fastify';
import type Database from 'better-sqlite3';
import {
  listForUser,
  getActiveByChat,
  getBySteelId,
  closeSession,
} from '../lib/browserSession.ts';

interface Options {
  db: Database.Database;
}

const FILES_BASE_URL = (process.env.CC_FILES_BASE_URL ?? '').replace(/\/+$/, '');

function fullUrl(viewerPath: string): string {
  return FILES_BASE_URL ? `${FILES_BASE_URL}${viewerPath}` : viewerPath;
}

export const browserRoute: FastifyPluginAsync<Options> = async (fastify, opts) => {
  const db = opts.db;

  fastify.get<{ Querystring: { userEmail?: string } }>(
    '/sessions',
    async (request, reply) => {
      const email = request.query.userEmail;
      if (!email || typeof email !== 'string') {
        return reply.code(400).send({ error: 'userEmail_required' });
      }
      const rows = listForUser(db, email);
      return reply.send({
        sessions: rows.map((r) => ({
          sessionId: r.steel_id,
          viewerUrl: fullUrl(r.viewer_path),
          scope: r.scope,
          scopeId: r.scope_id,
          status: r.status,
          createdAt: r.created_at,
          lastUsedAt: r.last_used_at,
        })),
      });
    },
  );

  fastify.get<{ Params: { chatId: string } }>(
    '/sessions/by-chat/:chatId',
    async (request, reply) => {
      const r = getActiveByChat(db, request.params.chatId);
      if (!r) return reply.code(404).send({ error: 'no_active_session' });
      return reply.send({
        sessionId: r.steel_id,
        viewerUrl: fullUrl(r.viewer_path),
        scope: r.scope,
        scopeId: r.scope_id,
        status: r.status,
        createdAt: r.created_at,
        lastUsedAt: r.last_used_at,
      });
    },
  );

  fastify.post<{ Params: { steelId: string } }>(
    '/sessions/:steelId/end',
    async (request, reply) => {
      const row = getBySteelId(db, request.params.steelId);
      if (!row) return reply.code(404).send({ error: 'not_found' });
      await closeSession(db, row.id);
      return reply.send({ ok: true });
    },
  );
};

/**
 * Internal endpoint для nginx auth_request.
 *
 * Поток:
 *   nginx /browser/{steelId}/... → auth_request /_browser_auth
 *   nginx форвардит cookie SaaS-сессии (Cookie: max_session=…) в SaaS endpoint
 *     /auth/browser-check → возвращает email юзера (200) или 401.
 *   Затем nginx также форвардит этот ответ как X-Auth-Email сюда.
 *
 * Здесь сверяем X-Auth-Email с владельцем steelId в БД.
 * 200 → доступ разрешён, 403 → запрещён.
 */
export const browserAuthRoute: FastifyPluginAsync<Options> = async (fastify, opts) => {
  const db = opts.db;

  fastify.get(
    '/browser-auth',
    async (request, reply) => {
      const steelId = (request.query as Record<string, string | undefined>).steelId;
      const email = (request.headers['x-auth-email'] as string | undefined) ?? '';
      if (!steelId || !email) {
        return reply.code(401).send({ error: 'missing_auth' });
      }
      const row = getBySteelId(db, steelId);
      if (!row || row.status !== 'active') {
        return reply.code(404).send({ error: 'not_found' });
      }
      if (row.user_email.toLowerCase() !== email.toLowerCase()) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      // Бонус: считаем это «использованием» — touch last_used_at, чтобы idle-GC
      // не закрыл сессию, пока юзер активно её смотрит.
      db.prepare(
        `UPDATE browser_sessions SET last_used_at = ? WHERE id = ?`,
      ).run(Date.now(), row.id);
      return reply.send({ ok: true });
    },
  );
};
