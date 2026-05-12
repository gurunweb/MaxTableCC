// Internal endpoint, слушается только на 127.0.0.1.
// Claude из своего workdir вызывает curl http://127.0.0.1:8081/internal/publish
// чтобы получить чистый URL на файл/папку.

import type { FastifyPluginAsync } from 'fastify';
import { existsSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { nanoid } from 'nanoid';
import type Database from 'better-sqlite3';

interface Options {
  db: Database.Database;
}

interface PublishBody {
  chatId: string;
  path: string;
  public?: boolean;
  ttl?: number; // seconds, для public-ссылок
}

const FILES_BASE_URL = process.env.CC_FILES_BASE_URL ?? '';

export const publishRoute: FastifyPluginAsync<Options> = async (fastify, opts) => {
  const db = opts.db;

  fastify.post<{ Body: PublishBody }>('/publish', async (request, reply) => {
    const b = request.body;
    if (!b || typeof b.chatId !== 'string' || typeof b.path !== 'string') {
      return reply.code(400).send({ error: 'bad_request', message: 'chatId and path required' });
    }

    const chat = db
      .prepare(
        `SELECT c.id, c.workdir, c.chat_dir, c.user_email, p.slug as project_slug
         FROM chats c LEFT JOIN projects p ON p.id = c.project_id
         WHERE c.id = ?`,
      )
      .get(b.chatId) as
      | {
          id: string;
          workdir: string;
          chat_dir: string | null;
          user_email: string;
          project_slug: string | null;
        }
      | undefined;
    if (!chat) {
      return reply.code(404).send({ error: 'chat_not_found' });
    }

    // Защита от path traversal — нормализуем и проверяем, что путь не выходит за workdir
    const rel = normalize(b.path).replace(/^[/\\]+/, '');
    if (rel.startsWith('..') || rel.includes('\0')) {
      return reply.code(400).send({ error: 'invalid_path' });
    }
    const abs = join(chat.workdir, rel);
    if (!abs.startsWith(chat.workdir)) {
      return reply.code(400).send({ error: 'path_outside_workdir' });
    }
    if (!existsSync(abs)) {
      return reply.code(404).send({ error: 'file_not_found', path: rel });
    }

    if (b.public) {
      // Публичная короткая ссылка
      const slug = nanoid(10);
      const expiresAt = b.ttl ? Date.now() + b.ttl * 1000 : null;
      db.prepare(
        `INSERT INTO public_links (slug, chat_id, path, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`,
      ).run(slug, b.chatId, rel, expiresAt, Date.now());
      const url = FILES_BASE_URL
        ? `${FILES_BASE_URL.replace(/\/+$/, '')}/p/${slug}`
        : `/p/${slug}`;
      return reply.send({ ok: true, url, slug, expiresAt });
    }

    // Приватная ссылка. Путь должен совпадать с nginx-location:
    //   project chat: /files/{email}/projects/{slug}/chats/{chatId}/...
    //   solo chat:    /files/{email}/chats/{chatId}/...
    //   single-tenant (WORKSPACES_FLAT=1): без email-сегмента.
    const flat = process.env.WORKSPACES_FLAT === '1';
    const safeEmail = (chat.user_email || '').replace(/[^a-zA-Z0-9@._-]/g, '_');
    const emailSeg = flat ? '' : `${safeEmail}/`;
    const pathSeg = chat.project_slug
      ? `${emailSeg}projects/${chat.project_slug}/chats/${b.chatId}`
      : `${emailSeg}chats/${b.chatId}`;
    const relUrl = rel.split('\\').join('/');
    const url = FILES_BASE_URL
      ? `${FILES_BASE_URL.replace(/\/+$/, '')}/files/${pathSeg}/${relUrl}`
      : `/files/${pathSeg}/${relUrl}`;
    const st = statSync(abs);
    return reply.send({
      ok: true,
      url,
      size: st.size,
      isDirectory: st.isDirectory(),
    });
  });
};
