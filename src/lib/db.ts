import Database from 'better-sqlite3';
import { dirname, join } from 'node:path';
import { mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs';

export type CcDb = ReturnType<typeof openDb>;

export function openDb(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  // WAL для параллельных writes от stream-json парсеров
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

/**
 * Применяет инкрементальные миграции из директории `migrationsDir`.
 * Файлы должны называться `NNN_*.sql` (например, `002_projects.sql`).
 * Применённые миграции записываются в таблицу `schema_migrations`.
 *
 * @param freshDb — `true` если DB только что создана через schema.sql.
 *   В этом случае все миграции отмечаются как «применены» без выполнения
 *   (схема уже содержит все актуальные структуры).
 */
export function runMigrations(
  db: Database.Database,
  migrationsDir: string,
  freshDb: boolean,
): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`);

  if (!existsSync(migrationsDir)) return;

  const files = readdirSync(migrationsDir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();

  const applied = new Set<string>(
    (db.prepare('SELECT name FROM schema_migrations').all() as Array<{ name: string }>).map(
      (r) => r.name,
    ),
  );

  const now = Date.now();
  const markApplied = db.prepare(
    'INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES (?, ?)',
  );

  // Auto-seed: для prod-БД, где миграции применялись вручную до появления schema_migrations,
  // помечаем 001/002 как применённые если соответствующие колонки уже есть.
  if (!freshDb && applied.size === 0) {
    const hasCol = (table: string, col: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(
        (c) => c.name === col,
      );
    if (hasCol('chats', 'project')) {
      markApplied.run('001_model_project_apps.sql', now);
      applied.add('001_model_project_apps.sql');
    }
    if (hasCol('chats', 'project_id')) {
      markApplied.run('002_projects.sql', now);
      applied.add('002_projects.sql');
    }
  }

  for (const file of files) {
    if (applied.has(file)) continue;

    if (freshDb) {
      // На свежей БД schema.sql уже создал актуальные структуры — просто помечаем.
      markApplied.run(file, now);
      continue;
    }

    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    const tx = db.transaction(() => {
      db.exec(sql);
      markApplied.run(file, now);
    });
    try {
      tx();
    } catch (err: any) {
      console.error(`Migration ${file} failed:`, err.message);
      throw err;
    }
  }
}

/** Проверяет, существует ли в БД хотя бы одна пользовательская таблица. */
export function isFreshDb(db: Database.Database): boolean {
  const row = db
    .prepare(
      "SELECT COUNT(*) as n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'",
    )
    .get() as { n: number };
  return row.n === 0;
}
