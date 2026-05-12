import { mkdirSync, existsSync, copyFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import type Database from 'better-sqlite3';

const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT ?? '/workspaces';
/**
 * Multi-tenant по умолчанию: путь содержит email юзера.
 * WORKSPACES_FLAT=1 — single-tenant (без email-сегмента).
 */
const FLAT_LAYOUT = process.env.WORKSPACES_FLAT === '1';
/** Шаблон CLAUDE.md, копируется в корень workdir чата/проекта при первом создании. */
const CLAUDE_TEMPLATE = process.env.CLAUDE_TEMPLATE ?? '/etc/cc-bridge/CLAUDE.template.md';

/** Зарезервированные slug — нельзя использовать как имя проекта. */
const RESERVED_SLUGS = new Set([
  'chats',
  'projects',
  'attachments',
  'outputs',
  'claude',
  'claude.md',
  '.claude',
]);

/** Простой транслит кириллицы → ascii (для slugify). */
const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/**
 * Приводит человеческое имя проекта к slug'у для ФС.
 * Возвращает строку или null если результат пустой/невалидный/зарезервирован.
 */
export function slugifyProjectName(input: string): string | null {
  if (typeof input !== 'string') return null;
  const lower = input.trim().toLowerCase();
  let out = '';
  for (const ch of lower) {
    if (TRANSLIT[ch] !== undefined) out += TRANSLIT[ch];
    else if (/[a-z0-9]/.test(ch)) out += ch;
    else if (/[\s_\-]/.test(ch)) out += '-';
    // прочие символы (знаки препинания, эмодзи) — отбрасываем
  }
  out = out.replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (out.length < 2 || out.length > 40) return null;
  if (!/^[a-z0-9_-]+$/.test(out)) return null;
  if (RESERVED_SLUGS.has(out)) return null;
  if (out.startsWith('_')) return null;
  return out;
}

/** Безопасное представление email для пути файловой системы. */
function safeEmail(email: string): string {
  return email.replace(/[^a-zA-Z0-9@._-]/g, '_');
}

/** Корень workspace юзера (с учётом FLAT_LAYOUT). */
function userRoot(userEmail: string): string {
  return FLAT_LAYOUT ? WORKSPACES_ROOT : join(WORKSPACES_ROOT, safeEmail(userEmail));
}

/**
 * Имя чата: YYMMDD_HHMM_XX, где XX — 2 случайных символа base36.
 * Пример: '260512_1430_a7'.
 */
export function generateChatName(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  const yy = pad(d.getFullYear() % 100);
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  const tail = nanoid(2).toLowerCase().replace(/[^a-z0-9]/g, 'x'); // только [a-z0-9]
  return `${yy}${mm}${dd}_${hh}${mi}_${tail}`;
}

/**
 * Возвращает пару путей для чата:
 *   - workdir: cwd для Claude (корень проекта или папка одиночного чата)
 *   - chatDir: куда писать attachments/outputs/audit.log (для project — подпапка chats/{id})
 */
export function getPaths(
  userEmail: string,
  chatId: string,
  projectSlug?: string | null,
): { workdir: string; chatDir: string } {
  const root = userRoot(userEmail);
  if (projectSlug) {
    const proj = join(root, 'projects', projectSlug);
    return { workdir: proj, chatDir: join(proj, 'chats', chatId) };
  }
  const chat = join(root, 'chats', chatId);
  return { workdir: chat, chatDir: chat };
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

/** Структура проекта в БД. */
interface ProjectRow {
  id: string;
  user_email: string;
  name: string;
  slug: string;
  created_at: number;
  updated_at: number;
}

/** Ищет проект по (user_email, slug). */
export function findProject(
  db: Database.Database,
  userEmail: string,
  slug: string,
): ProjectRow | null {
  const row = db
    .prepare('SELECT * FROM projects WHERE user_email = ? AND slug = ?')
    .get(userEmail, slug) as ProjectRow | undefined;
  return row ?? null;
}

/** Создаёт проект. Бросает Error('project_exists') если slug занят. */
export function createProject(
  db: Database.Database,
  userEmail: string,
  name: string,
  slug: string,
): ProjectRow {
  const existing = findProject(db, userEmail, slug);
  if (existing) {
    const err: any = new Error('project_exists');
    err.code = 'project_exists';
    err.slug = slug;
    throw err;
  }
  const id = 'proj_' + nanoid(10);
  const now = Date.now();
  db.prepare(
    `INSERT INTO projects (id, user_email, name, slug, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, userEmail, name, slug, now, now);
  // Создаём корень проекта + копируем CLAUDE.md
  const root = join(userRoot(userEmail), 'projects', slug);
  mkdirSync(root, { recursive: true });
  const claudeMd = join(root, 'CLAUDE.md');
  if (existsSync(CLAUDE_TEMPLATE) && !existsSync(claudeMd)) {
    try { copyFileSync(CLAUDE_TEMPLATE, claudeMd); } catch { /* noop */ }
  }
  return { id, user_email: userEmail, name, slug, created_at: now, updated_at: now };
}

/**
 * Переименование проекта: атомарно меняет slug на ФС + в БД + во всех chats этого проекта.
 * Бросает Error('project_exists') если новый slug занят.
 */
export function renameProject(
  db: Database.Database,
  userEmail: string,
  projectId: string,
  newName: string,
  newSlug: string,
): ProjectRow {
  // Эксклюзивная блокировка на запись (advisory)
  const tx = db.transaction(() => {
    const cur = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as
      | ProjectRow
      | undefined;
    if (!cur) {
      const err: any = new Error('project_not_found');
      err.code = 'project_not_found';
      throw err;
    }
    if (cur.user_email !== userEmail) {
      const err: any = new Error('forbidden');
      err.code = 'forbidden';
      throw err;
    }
    if (cur.slug === newSlug) {
      // только name обновить
      if (cur.name !== newName) {
        db.prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?').run(
          newName,
          Date.now(),
          projectId,
        );
      }
      return cur;
    }
    // Проверка коллизии
    const taken = findProject(db, userEmail, newSlug);
    if (taken) {
      const err: any = new Error('project_exists');
      err.code = 'project_exists';
      err.slug = newSlug;
      throw err;
    }
    // Rename папки на ФС
    const root = userRoot(userEmail);
    const oldPath = join(root, 'projects', cur.slug);
    const newPath = join(root, 'projects', newSlug);
    if (existsSync(oldPath)) {
      renameSync(oldPath, newPath); // атомарный rename
    } else {
      // ФС-папки нет — создаём новую, не падаем
      mkdirSync(newPath, { recursive: true });
    }
    const now = Date.now();
    db.prepare(
      'UPDATE projects SET name = ?, slug = ?, updated_at = ? WHERE id = ?',
    ).run(newName, newSlug, now, projectId);
    // Обновляем workdir/chat_dir всех чатов этого проекта
    const chats = db
      .prepare('SELECT id FROM chats WHERE project_id = ?')
      .all(projectId) as Array<{ id: string }>;
    for (const c of chats) {
      const { workdir, chatDir } = getPaths(userEmail, c.id, newSlug);
      db.prepare('UPDATE chats SET workdir = ?, chat_dir = ?, updated_at = ? WHERE id = ?').run(
        workdir,
        chatDir,
        now,
        c.id,
      );
    }
    return { ...cur, name: newName, slug: newSlug, updated_at: now };
  });
  // Если транзакция упала на ФС-операции — SQLite откатит, но ФС останется как есть.
  // Откат ФС вручную не делаем: renameSync атомарен, либо прошёл, либо нет.
  return tx();
}

interface EnsureChatInput {
  userEmail: string;
  chatId?: string;
  firstPrompt?: string;
  model?: string;
  /** ID проекта, если чат должен быть в проекте. */
  projectId?: string | null;
  /** Slug проекта (вычисляется выше по project_id). */
  projectSlug?: string | null;
}

export interface EnsureChatResult {
  chatId: string;
  workdir: string;
  chatDir: string;
  created: boolean;
  model: string | null;
  projectId: string | null;
  appPort: number;
}

/**
 * Создаёт (или подхватывает) чат, делает mkdir путей и upsert в таблицу `chats`.
 * Если чат уже существует — возвращает его текущее состояние из БД, НИЧЕГО не меняя
 * (модель/проект фиксируются на первом запуске).
 */
export function ensureChat(db: Database.Database, input: EnsureChatInput): EnsureChatResult {
  const chatId = input.chatId?.trim() || generateChatName();

  const existing = db
    .prepare(
      'SELECT id, model, project_id, app_port, workdir, chat_dir FROM chats WHERE id = ?',
    )
    .get(chatId) as
    | {
        id: string;
        model: string | null;
        project_id: string | null;
        app_port: number | null;
        workdir: string;
        chat_dir: string | null;
      }
    | undefined;

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
    const port = existing.app_port ?? pickAppPort(db);
    if (existing.app_port == null) {
      db.prepare('UPDATE chats SET app_port = ? WHERE id = ?').run(port, chatId);
      db.prepare('INSERT OR IGNORE INTO apps (chat_id, port) VALUES (?, ?)').run(chatId, port);
    }
    return {
      chatId,
      workdir: existing.workdir,
      chatDir: existing.chat_dir ?? existing.workdir,
      created: false,
      model: existing.model,
      projectId: existing.project_id,
      appPort: port,
    };
  }

  // Новый чат — пути по новой схеме
  const { workdir, chatDir } = getPaths(input.userEmail, chatId, input.projectSlug);

  // mkdir и копирование CLAUDE.md
  // Корень workdir создаётся (если ещё нет — для одиночных чатов или нового project root)
  if (!existsSync(workdir)) {
    mkdirSync(workdir, { recursive: true });
  }
  // CLAUDE.md в корень workdir (для проекта — общий; для одиночного — в чате)
  const claudeMd = join(workdir, 'CLAUDE.md');
  if (existsSync(CLAUDE_TEMPLATE) && !existsSync(claudeMd)) {
    try { copyFileSync(CLAUDE_TEMPLATE, claudeMd); } catch { /* noop */ }
  }
  // chat-specific папки
  mkdirSync(join(chatDir, 'attachments'), { recursive: true });
  mkdirSync(join(chatDir, 'outputs'), { recursive: true });

  const port = pickAppPort(db);
  const modelToStore = input.model ?? null;
  const projectIdToStore = input.projectId ?? null;
  db.prepare(
    `INSERT INTO chats (id, user_email, first_prompt, last_prompt, workdir, chat_dir,
                        model, project_id, app_port, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    chatId,
    input.userEmail,
    preview,
    preview,
    workdir,
    chatDir,
    modelToStore,
    projectIdToStore,
    port,
    now,
    now,
  );
  db.prepare('INSERT OR IGNORE INTO apps (chat_id, port) VALUES (?, ?)').run(chatId, port);

  return {
    chatId,
    workdir,
    chatDir,
    created: true,
    model: modelToStore,
    projectId: projectIdToStore,
    appPort: port,
  };
}

/** Список чатов юзера (по updated_at DESC). */
export function listChats(db: Database.Database, userEmail: string, limit = 50) {
  return db
    .prepare(
      `SELECT c.id, c.first_prompt, c.last_prompt, c.last_action, c.model,
              c.project_id, p.name as project_name, p.slug as project_slug,
              c.created_at, c.updated_at
       FROM chats c LEFT JOIN projects p ON c.project_id = p.id
       WHERE c.user_email = ? ORDER BY c.updated_at DESC LIMIT ?`,
    )
    .all(userEmail, limit);
}

/** Список проектов юзера с количеством чатов. */
export function listProjects(db: Database.Database, userEmail: string, limit = 100) {
  return db
    .prepare(
      `SELECT p.id, p.name, p.slug, p.created_at, p.updated_at,
              (SELECT COUNT(*) FROM chats WHERE project_id = p.id) as chats_count
       FROM projects p
       WHERE p.user_email = ?
       ORDER BY p.updated_at DESC LIMIT ?`,
    )
    .all(userEmail, limit);
}
