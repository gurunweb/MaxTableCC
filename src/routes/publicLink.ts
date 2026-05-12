// GET /p/:slug — публичная короткая ссылка на файл.
// Записи в public_links создаёт POST /internal/publish с public:true.
// Здесь резолвим slug → chat → workdir + relative path и отдаём файл
// через X-Accel-Redirect (nginx-internal location /_files/).
//
// Если nginx X-Accel недоступен (локальный dev) — пишем файл стримом.
import type { FastifyPluginAsync } from 'fastify';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

interface Options {
  db: Database.Database;
}

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  json: 'application/json',
  csv: 'text/csv; charset=utf-8',
  tsv: 'text/tab-separated-values; charset=utf-8',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  zip: 'application/zip',
};

export const publicLinkRoute: FastifyPluginAsync<Options> = async (fastify, opts) => {
  const db = opts.db;

  fastify.get<{ Params: { slug: string } }>('/:slug', async (request, reply) => {
    const slug = request.params.slug;
    if (!/^[A-Za-z0-9_-]{6,40}$/.test(slug)) {
      return reply.code(404).send({ error: 'not_found' });
    }

    const row = db
      .prepare(
        `SELECT pl.path, pl.expires_at, c.workdir
         FROM public_links pl JOIN chats c ON c.id = pl.chat_id
         WHERE pl.slug = ?`,
      )
      .get(slug) as { path: string; expires_at: number | null; workdir: string } | undefined;
    if (!row) return reply.code(404).send({ error: 'not_found' });
    if (row.expires_at && row.expires_at < Date.now()) {
      return reply.code(410).send({ error: 'expired' });
    }

    const abs = join(row.workdir, row.path);
    if (!abs.startsWith(row.workdir)) return reply.code(400).send({ error: 'bad_path' });
    if (!existsSync(abs)) return reply.code(404).send({ error: 'file_missing' });

    const ext = (row.path.split('.').pop() ?? '').toLowerCase();
    const mime = MIME[ext] ?? 'application/octet-stream';
    reply.header('Content-Type', mime);
    reply.header('Cache-Control', 'public, max-age=300');

    // Если за nginx — отдаём через X-Accel-Redirect на internal-location /_files_internal/.
    // Иначе стримим сами. Признак nginx: process.env.CC_USE_XACCEL=1.
    if (process.env.CC_USE_XACCEL === '1') {
      // Internal location mapped to /workspaces/. Полный путь от корня.
      reply.header('X-Accel-Redirect', '/_files_internal' + abs);
      return reply.send();
    }

    const st = statSync(abs);
    reply.header('Content-Length', String(st.size));
    return reply.send(createReadStream(abs));
  });
};
