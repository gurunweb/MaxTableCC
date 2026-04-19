// cc-bridge — HTTP прокси к Claude Code CLI
// Принимает задачи от MaxTableSaaS (Cloudflare Workers), запускает claude -p, возвращает результаты

import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb } from './lib/db.ts';
import { healthRoute } from './routes/health.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Конфиг из env (читаем через systemd EnvironmentFile=/etc/cc-bridge/env)
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '127.0.0.1';
const BRIDGE_TOKEN = process.env.CLOUDCODE_BRIDGE_TOKEN;
const DATABASE_PATH = process.env.DATABASE_PATH ?? '/var/lib/cc-bridge/db.sqlite';
const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';

if (!BRIDGE_TOKEN || BRIDGE_TOKEN.length < 32) {
  console.error('FATAL: CLOUDCODE_BRIDGE_TOKEN is missing or too short (min 32 chars)');
  process.exit(1);
}

// Инициализация БД + миграция
const db = openDb(DATABASE_PATH);
const schema = readFileSync(join(__dirname, 'db', 'schema.sql'), 'utf8');
db.exec(schema);

// Версия из package.json
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
const startTime = Date.now();

const fastify = Fastify({
  logger: {
    level: LOG_LEVEL,
    transport: process.stdout.isTTY
      ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } }
      : undefined,
  },
  trustProxy: true,
});

// Middleware: проверка X-Bridge-Token на всех /v1/* endpoints
fastify.addHook('onRequest', async (request, reply) => {
  if (!request.url.startsWith('/v1/')) return;
  const token = request.headers['x-bridge-token'];
  if (token !== BRIDGE_TOKEN) {
    reply.code(401).send({ error: 'invalid_bridge_token' });
  }
});

// Health endpoint (public, для Caddy и SaaS health-check)
fastify.register(healthRoute, {
  prefix: '/health',
  version: pkg.version as string,
  startTime,
});

// TODO: остальные маршруты будут добавлены позже
// - POST /v1/cloudcode/run
// - GET  /v1/cloudcode/status/:taskId
// - POST /v1/cloudcode/stop/:taskId
// - GET  /v1/cloudcode/meta/{chats,paused,subscription}
// - DELETE /v1/cloudcode/chats/:chatId

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
