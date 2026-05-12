// cc-bridge — HTTP прокси к Claude Code CLI
// Принимает задачи от MaxTableSaaS (Cloudflare Workers), запускает claude -p, возвращает результаты

import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb, runMigrations, isFreshDb } from './lib/db.ts';
import { healthRoute } from './routes/health.ts';
import { runRoute } from './routes/run.ts';
import { statusRoute } from './routes/status.ts';
import { stopRoute } from './routes/stop.ts';
import { metaRoute } from './routes/meta.ts';
import { publishRoute } from './routes/publish.ts';
import { publicLinkRoute } from './routes/publicLink.ts';
import { resolveAppRoute } from './routes/resolveApp.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Конфиг из env (через systemd EnvironmentFile=/etc/cc-bridge/env)
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '127.0.0.1';
const BRIDGE_TOKEN = process.env.CLAUDECODE_BRIDGE_TOKEN ?? process.env.CLOUDCODE_BRIDGE_TOKEN;
const DATABASE_PATH = process.env.DATABASE_PATH ?? '/var/lib/cc-bridge/db.sqlite';
const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';

if (!BRIDGE_TOKEN || BRIDGE_TOKEN.length < 32) {
  console.error('FATAL: CLAUDECODE_BRIDGE_TOKEN is missing or too short (min 32 chars)');
  process.exit(1);
}

if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  console.warn(
    'WARN: CLAUDE_CODE_OAUTH_TOKEN is not set — claude -p will fail until login is done',
  );
}

// Инициализация БД + миграции
const db = openDb(DATABASE_PATH);
const fresh = isFreshDb(db);
const schema = readFileSync(join(__dirname, 'db', 'schema.sql'), 'utf8');
db.exec(schema);
runMigrations(db, join(__dirname, 'db', 'migrations'), fresh);

const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
  version: string;
};
const startTime = Date.now();

const fastify = Fastify({
  logger: {
    level: LOG_LEVEL,
    transport: process.stdout.isTTY
      ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } }
      : undefined,
  },
  trustProxy: true,
  bodyLimit: 50 * 1024 * 1024, // 50 MB для attachments на будущее
});

// Health public (для Caddy и SaaS health-check)
await fastify.register(healthRoute, {
  prefix: '/health',
  version: pkg.version,
  startTime,
});

// Middleware: X-Bridge-Token на всех /v1/*. /internal/* — только с localhost.
// /p/* — публичные короткие ссылки, без auth.
fastify.addHook('onRequest', async (request, reply) => {
  if (request.url.startsWith('/internal/')) {
    const ip = request.ip;
    if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
      return reply.code(403).send({ error: 'internal_localhost_only' });
    }
    return;
  }
  if (request.url.startsWith('/p/')) return;
  if (!request.url.startsWith('/v1/')) return;
  const token = request.headers['x-bridge-token'];
  if (token !== BRIDGE_TOKEN) {
    return reply.code(401).send({ error: 'invalid_bridge_token' });
  }
});

// Bridge API (внешний — через X-Bridge-Token)
await fastify.register(runRoute, { prefix: '/v1/claudecode/run', db });
await fastify.register(statusRoute, { prefix: '/v1/claudecode/status', db });
await fastify.register(stopRoute, { prefix: '/v1/claudecode/stop', db });
await fastify.register(metaRoute, { prefix: '/v1/claudecode/meta', db });

// Internal API (только с localhost — для Claude из своего workdir и nginx auth_request)
await fastify.register(publishRoute, { prefix: '/internal', db });
await fastify.register(resolveAppRoute, { prefix: '/internal/resolve-app', db });

// Публичные короткие ссылки /p/:slug (без auth)
await fastify.register(publicLinkRoute, { prefix: '/p', db });

// Запуск
try {
  await fastify.listen({ port: PORT, host: HOST });
  fastify.log.info(`cc-bridge v${pkg.version} listening on http://${HOST}:${PORT}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}

// Graceful shutdown
const shutdown = async (signal: string) => {
  fastify.log.info(`Received ${signal}, shutting down gracefully`);
  await fastify.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
