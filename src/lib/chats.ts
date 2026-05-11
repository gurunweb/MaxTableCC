import { mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import type Database from 'better-sqlite3';

const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT ?? '/workspaces';
/**
 * Multi-tenant по умолчанию: путь содержит email юзера.
 * Один сервер cc-bridge может обслуживать нескольких клиентов — каждый видит
 * только свои файлы. Админ может «подарить» свой сервер клиенту,
 * вписав те же bridge_url + bridge_token в user_servers клиента — чаты
 * клиента лягут в отдельную папку `/workspaces/{email}/chats/...`.
 *
 * WORKSPACES_FLAT=1 — режим single-tenant (без email-папки). Используется
 * только если уверены, что сервер обслуживает одного человека.
 */
const FLAT_LAYOUT = process.env.WORKSPACES_FLAT === '1';
/** Шаблон CLAUDE.md, копируется в каждый новый workdir чата. */
const CLAUDE_TEMPLATE = process.env.CLAUDE_TEMPLATE ?? '/etc/cc-bridge/CLAUDE.template.md';

/** Безопасное представление email для пути файловой системы. */
function safeEmail(email: string): string {
  return email.replace(/[^a-zA-Z0-9@._-]/g, '_');
}

/** Возвращает абсолютный путь к workdir чата. */
export function getWorkdirPath(userEmail: string, chatId: string, project?: string | null): string {
  if (project) {
    // Project-режим: общая папка проекта, у каждого чата свой .claude/<chatId>/
    return FLAT_LAYOUT
      ? join(WORKSPACES_ROOT, 'projects', project)
      : join(WORKSPACES_ROOT, safeEmail(userEmail), 'projects', project);
  }
  if (FLAT_LAYOUT) {
    return join(WORKSPACES_ROOT, 'chats', chatId);
  }
  return join(WORKSPACES_ROOT, safeEmail(userEmail), 'chats', chatId);
}

/** Подбирает свободный порт 3000-3999 для webapp этого чата. */
function pickAppPort(db: Database.Database): number {
  const used = new Set<number>(
    (db.prepare('SELECT port FROM apps').all() as Array<{ port: number }>).map((r) => r.port),
  );
  for (let p = 3000; p < 4000; p++) {
    if (!used.has(p)) return p;
  }
  throw new Error('no_free_app_port');
}

interface EnsureChatInput {
  userEmail: string;
  chatId?: string;
  firstPrompt?: string;
  model?: string;
  project?: string;
}

/** Создаёт (или подхватывает) чат, делает mkdir workdir и upsert в таблицу `chats`. */
export function ensureChat(
  db: Database.Database,
  input: EnsureChatInput,
): { chatId: string; workdir: string; created: boolean; model: string | null; project: string | null; appPort: number } {
  const chatId = input.chatId?.trim() || 'chat-' + nanoid(10);
  const workdir = getWorkdirPath(input.userEmail, chatId, input.project);

  if (!existsSync(workdir)) {
    mkdirSync(join(workdir, 'attachments'), { recursive: true });
    mkdirSync(join(workdir, 'outputs'), { recursive: true });
    // CLAUDE.md из шаблона
    const claudeMd = join(workdir, 'CLAUDE.md');
    if (existsSync(CLAUDE_TEMPLATE) && !existsSync(claudeMd)) {
      try { copyFileSync(CLAUDE_TEMPLATE, claudeMd); } catch { /* noop */ }
    }
  }

  const existing = db
    .prepare('SELECT id, model, project, app_port FROM chats WHERE id = ?')
    .get(chatId) as { id: string; model: string | null; project: string | null; app_port: number | null } | undefined;

  const now = Date.now();
  const preview = input.firstPrompt?.slice(0, 500) ?? null;

  if (existing) {
    if (preview) {
      db.prepare('UPDATE chats SET last_prompt = ?, updated_at = ? WHERE id = ?').run(
        preview,
        now,
        chatId,
      );
    } else {
      db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(now, chatId);
    }
    // Модель/проект НЕ перезаписываем после первого старта — это by design.
    const port = existing.app_port ?? pickAppPort(db);
    if (existing.app_port == null) {
      db.prepare('UPDATE chats SET app_port = ? WHERE id = ?').run(port, chatId);
      db.prepare('INSERT OR IGNORE INTO apps (chat_id, port) VALUES (?, ?)').run(chatId, port);
    }
    return {
      chatId,
      workdir,
      created: false,
      model: existing.model,
      project: existing.project,
      appPort: port,
    };
  }

  const port = pickAppPort(db);
  const modelToStore = input.model ?? null;
  const projectToStore = input.project ?? null;
  db.prepare(
    `INSERT INTO chats (id, user_email, first_prompt, last_prompt, workdir, model, project, app_port, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(chatId, input.userEmail, preview, preview, workdir, modelToStore, projectToStore, port, now, now);
  db.prepare('INSERT OR IGNORE INTO apps (chat_id, port) VALUES (?, ?)').run(chatId, port);

  return {
    chatId,
    workdir,
    created: true,
    model: modelToStore,
    project: projectToStore,
    appPort: port,
  };
}

/** Список чатов юзера (по updated_at DESC). */
export function listChats(db: Database.Database, userEmail: string, limit = 50) {
  return db
    .prepare(
      `SELECT id, first_prompt, last_prompt, last_action, model, project, created_at, updated_at
       FROM chats WHERE user_email = ? ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(userEmail, limit);
}
