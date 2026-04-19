import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import type Database from 'better-sqlite3';

const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT ?? '/workspaces';

/** Возвращает абсолютный путь к workdir чата. */
export function getWorkdirPath(userEmail: string, chatId: string): string {
  const safeEmail = userEmail.replace(/[^a-zA-Z0-9@._-]/g, '_');
  return join(WORKSPACES_ROOT, safeEmail, 'chats', chatId);
}

interface EnsureChatInput {
  userEmail: string;
  chatId?: string;
  firstPrompt?: string;
}

/** Создаёт (или подхватывает) чат, делает mkdir workdir и upsert в таблицу `chats`. */
export function ensureChat(
  db: Database.Database,
  input: EnsureChatInput,
): { chatId: string; workdir: string; created: boolean } {
  const chatId = input.chatId?.trim() || 'chat-' + nanoid(10);
  const workdir = getWorkdirPath(input.userEmail, chatId);

  if (!existsSync(workdir)) {
    mkdirSync(join(workdir, 'attachments'), { recursive: true });
    mkdirSync(join(workdir, 'outputs'), { recursive: true });
  }

  const existing = db
    .prepare('SELECT id FROM chats WHERE id = ?')
    .get(chatId) as { id: string } | undefined;

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
    return { chatId, workdir, created: false };
  }

  db.prepare(
    `INSERT INTO chats (id, user_email, first_prompt, last_prompt, workdir, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(chatId, input.userEmail, preview, preview, workdir, now, now);

  return { chatId, workdir, created: true };
}

/** Список чатов юзера (по updated_at DESC). */
export function listChats(db: Database.Database, userEmail: string, limit = 50) {
  return db
    .prepare(
      `SELECT id, first_prompt, last_prompt, last_action, created_at, updated_at
       FROM chats WHERE user_email = ? ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(userEmail, limit);
}
