// browserSession.ts — слой между cc-bridge и steel-browser.
//
// getOrCreateForChat(chatId):
//   1) определяет scope: если у чата есть project_id → scope='project',
//      иначе scope='chat';
//   2) ищет active в browser_sessions; если есть и steel её ещё знает —
//      возвращает (с обновлением last_used_at);
//   3) иначе создаёт новую через steel.createSession() и пишет в БД.
//
// closeSession / closeIdleSessions — для cron-GC.

import type Database from 'better-sqlite3';
import * as steel from './steel.ts';

const IDLE_TIMEOUT_MS = Number(process.env.BROWSER_IDLE_TIMEOUT_MS ?? '900000'); // 15 минут

export interface BrowserSessionRow {
  id: number;
  scope: 'project' | 'chat';
  scope_id: string;
  user_email: string;
  steel_id: string;
  ws_endpoint: string;
  viewer_path: string;
  status: 'active' | 'closed';
  created_at: number;
  last_used_at: number;
  closed_at: number | null;
}

export interface ActiveSession {
  steelId: string;
  wsEndpoint: string;
  viewerPath: string;
  scope: 'project' | 'chat';
  scopeId: string;
}

/**
 * Найти или создать browser-сессию для чата.
 * Возвращает null, если steel не сконфигурирован (опциональная фича).
 */
export async function getOrCreateForChat(
  db: Database.Database,
  chatId: string,
): Promise<ActiveSession | null> {
  if (!steel.isSteelEnabled()) return null;

  const chat = db
    .prepare('SELECT id, user_email, project_id FROM chats WHERE id = ?')
    .get(chatId) as { id: string; user_email: string; project_id: string | null } | undefined;
  if (!chat) throw new Error(`browserSession: chat ${chatId} not found`);

  const scope: 'project' | 'chat' = chat.project_id ? 'project' : 'chat';
  const scopeId = chat.project_id ?? chat.id;

  // Существующая active?
  const existing = db
    .prepare(
      `SELECT * FROM browser_sessions WHERE scope = ? AND scope_id = ? AND status = 'active'`,
    )
    .get(scope, scopeId) as BrowserSessionRow | undefined;

  if (existing) {
    // Сверяем, что steel её ещё знает (контейнер мог рестартнуться)
    const alive = await steel.getSession(existing.steel_id);
    if (alive) {
      db.prepare(`UPDATE browser_sessions SET last_used_at = ? WHERE id = ?`).run(
        Date.now(),
        existing.id,
      );
      return {
        steelId: existing.steel_id,
        wsEndpoint: existing.ws_endpoint,
        viewerPath: existing.viewer_path,
        scope,
        scopeId,
      };
    }
    // steel забыл — пометим closed и создадим заново
    db.prepare(
      `UPDATE browser_sessions SET status = 'closed', closed_at = ? WHERE id = ?`,
    ).run(Date.now(), existing.id);
  }

  // Создаём новую
  const created = await steel.createSession({
    dimensions: { width: 1280, height: 800 },
  });
  const now = Date.now();
  const viewerPath = `/browser/${created.id}/`;

  db.prepare(
    `INSERT INTO browser_sessions
       (scope, scope_id, user_email, steel_id, ws_endpoint, viewer_path,
        status, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  ).run(scope, scopeId, chat.user_email, created.id, created.websocketUrl, viewerPath, now, now);

  return {
    steelId: created.id,
    wsEndpoint: created.websocketUrl,
    viewerPath,
    scope,
    scopeId,
  };
}

export function getActiveByChat(
  db: Database.Database,
  chatId: string,
): BrowserSessionRow | null {
  const chat = db
    .prepare('SELECT id, project_id FROM chats WHERE id = ?')
    .get(chatId) as { id: string; project_id: string | null } | undefined;
  if (!chat) return null;
  const scope = chat.project_id ? 'project' : 'chat';
  const scopeId = chat.project_id ?? chat.id;
  const row = db
    .prepare(
      `SELECT * FROM browser_sessions WHERE scope = ? AND scope_id = ? AND status = 'active'`,
    )
    .get(scope, scopeId) as BrowserSessionRow | undefined;
  return row ?? null;
}

export function getBySteelId(
  db: Database.Database,
  steelId: string,
): BrowserSessionRow | null {
  const row = db
    .prepare(`SELECT * FROM browser_sessions WHERE steel_id = ?`)
    .get(steelId) as BrowserSessionRow | undefined;
  return row ?? null;
}

export function listForUser(
  db: Database.Database,
  userEmail: string,
): BrowserSessionRow[] {
  return db
    .prepare(
      `SELECT * FROM browser_sessions
       WHERE user_email = ? AND status = 'active'
       ORDER BY last_used_at DESC`,
    )
    .all(userEmail) as BrowserSessionRow[];
}

export function touchByScope(
  db: Database.Database,
  scope: 'project' | 'chat',
  scopeId: string,
): void {
  db.prepare(
    `UPDATE browser_sessions SET last_used_at = ?
     WHERE scope = ? AND scope_id = ? AND status = 'active'`,
  ).run(Date.now(), scope, scopeId);
}

export async function closeSession(
  db: Database.Database,
  sessionId: number,
): Promise<void> {
  const row = db
    .prepare(`SELECT steel_id FROM browser_sessions WHERE id = ?`)
    .get(sessionId) as { steel_id: string } | undefined;
  if (!row) return;
  await steel.releaseSession(row.steel_id);
  db.prepare(
    `UPDATE browser_sessions SET status = 'closed', closed_at = ? WHERE id = ?`,
  ).run(Date.now(), sessionId);
}

/**
 * GC: закрыть все active с last_used_at старше IDLE_TIMEOUT_MS.
 * Вызывается из setInterval в index.ts.
 */
export async function closeIdleSessions(db: Database.Database): Promise<number> {
  if (!steel.isSteelEnabled()) return 0;
  const cutoff = Date.now() - IDLE_TIMEOUT_MS;
  const rows = db
    .prepare(
      `SELECT id, steel_id FROM browser_sessions
       WHERE status = 'active' AND last_used_at < ?`,
    )
    .all(cutoff) as Array<{ id: number; steel_id: string }>;
  let n = 0;
  for (const r of rows) {
    try {
      await steel.releaseSession(r.steel_id);
      db.prepare(
        `UPDATE browser_sessions SET status = 'closed', closed_at = ? WHERE id = ?`,
      ).run(Date.now(), r.id);
      n++;
    } catch (err: any) {
      console.warn(`closeIdleSessions: failed for ${r.steel_id}: ${err.message}`);
    }
  }
  return n;
}
