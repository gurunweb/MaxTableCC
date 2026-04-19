import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import type Database from 'better-sqlite3';
import { ensureChat } from './chats.ts';
import { installSafeHook, removeSafeHook } from './permissionHook.ts';

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? '/home/maxclaude/.local/bin/claude';

export type TaskStatus =
  | 'running'
  | 'done'
  | 'error'
  | 'paused'
  | 'needs-input'
  | 'awaiting_approval'
  | 'rate_limited'
  | 'timeout'
  | 'cancelled';

export type Mode = 'auto' | 'plan' | 'safe';

export interface RunTaskInput {
  userEmail: string;
  chatId?: string;
  prompt: string;
  mode?: Mode;
  maxTimeSec?: number;
  resumeFromPausedTask?: string;
}

export interface RunTaskResult {
  taskId: string;
  chatId: string;
  workdir: string;
}

interface Running {
  proc: ChildProcess;
  softTimer: NodeJS.Timeout;
  hardTimer?: NodeJS.Timeout;
  softSignalSent?: boolean;
}

const running = new Map<string, Running>();

export function getRunning(taskId: string): Running | undefined {
  return running.get(taskId);
}

/** Человеко-читаемое описание tool-use */
function describeTool(name: string, input: unknown): { kind: string; summary: string } {
  const inp = (input ?? {}) as Record<string, unknown>;
  const truncate = (s: string, n = 120) => (s.length > n ? s.slice(0, n) + '…' : s);
  switch (name) {
    case 'Bash':
      return { kind: '⚙️', summary: 'bash: ' + truncate(String(inp.command ?? '')) };
    case 'Read':
      return { kind: '📖', summary: 'read: ' + String(inp.file_path ?? inp.path ?? '') };
    case 'Write':
      return { kind: '✍️', summary: 'write: ' + String(inp.file_path ?? '') };
    case 'Edit':
    case 'MultiEdit':
      return { kind: '✏️', summary: 'edit: ' + String(inp.file_path ?? '') };
    case 'WebSearch':
      return { kind: '🔍', summary: 'web: ' + truncate(String(inp.query ?? '')) };
    case 'WebFetch':
      return { kind: '🌐', summary: 'fetch: ' + truncate(String(inp.url ?? '')) };
    case 'Task':
      return {
        kind: '🤖',
        summary: 'agent: ' + truncate(String(inp.description ?? inp.prompt ?? '')),
      };
    case 'Grep':
      return { kind: '🔎', summary: 'grep: ' + truncate(String(inp.pattern ?? '')) };
    case 'Glob':
      return { kind: '📂', summary: 'glob: ' + truncate(String(inp.pattern ?? '')) };
    case 'TodoWrite':
      return { kind: '📋', summary: 'todo update' };
    default:
      return { kind: '🔧', summary: name + ': ' + truncate(JSON.stringify(inp), 80) };
  }
}

/** Старт задачи: inserts row в tasks + spawn claude + возвращает {taskId, chatId, workdir}. */
export function startTask(db: Database.Database, input: RunTaskInput): RunTaskResult {
  const mode: Mode = input.mode ?? 'auto';
  const maxTimeSec = Math.max(60, Math.min(3600, input.maxTimeSec ?? 1320));

  const { chatId, workdir } = ensureChat(db, {
    userEmail: input.userEmail,
    chatId: input.chatId,
    firstPrompt: input.prompt,
  });

  const taskId = 'task-' + nanoid(12);
  const now = Date.now();

  db.prepare(
    `INSERT INTO tasks (id, chat_id, status, prompt_preview, mode, max_time_sec, started_at)
     VALUES (?, ?, 'running', ?, ?, ?, ?)`,
  ).run(taskId, chatId, input.prompt.slice(0, 500), mode, maxTimeSec, now);

  // Собираем системный префикс для resume-after-pause
  let actualPrompt = input.prompt;
  if (input.resumeFromPausedTask) {
    const paused = db
      .prepare('SELECT pause_summary FROM tasks WHERE id = ?')
      .get(input.resumeFromPausedTask) as { pause_summary?: string } | undefined;
    const summary = paused?.pause_summary ?? '';
    actualPrompt =
      `[SYSTEM] You were previously paused by time limit. ` +
      `Summary of your last state:\n${summary}\n\n` +
      `Continue where you stopped, using files in outputs/ if any.\n\n` +
      `User: ${input.prompt}`;
  }

  // Команда claude
  const args = ['-p', actualPrompt, '--output-format', 'stream-json', '--verbose'];

  // --resume только если есть сохранённый claude_session_id
  const chatRow = db
    .prepare('SELECT claude_session_id FROM chats WHERE id = ?')
    .get(chatId) as { claude_session_id: string | null } | undefined;
  if (chatRow?.claude_session_id) {
    args.push('--resume', chatRow.claude_session_id);
  }

  // Permission mode
  if (mode === 'plan') {
    args.push('--permission-mode', 'plan');
    removeSafeHook(workdir);
  } else if (mode === 'safe') {
    // safe: default permissions + PreToolUse hook который даёт allow/ask/deny
    installSafeHook(workdir);
    args.push('--permission-mode', 'default');
  } else {
    // auto — полный байпас, hook чистим
    removeSafeHook(workdir);
    args.push('--permission-mode', 'bypassPermissions');
  }

  // Spawn claude
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // CLAUDE_CODE_OAUTH_TOKEN уже в env через systemd EnvironmentFile
  };
  const proc = spawn(CLAUDE_BIN, args, {
    cwd: workdir,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  db.prepare('UPDATE tasks SET pid = ? WHERE id = ?').run(proc.pid ?? null, taskId);

  // Парсим stdout построчно (stream-json = одна JSON-запись на строку)
  let stdoutBuf = '';
  proc.stdout.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString('utf8');
    let idx: number;
    while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (line) handleEvent(db, taskId, line);
    }
  });

  let stderrBuf = '';
  proc.stderr.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf8');
  });

  proc.on('close', (code) => {
    handleClose(db, taskId, code, stderrBuf);
    const r = running.get(taskId);
    if (r) {
      clearTimeout(r.softTimer);
      if (r.hardTimer) clearTimeout(r.hardTimer);
      running.delete(taskId);
    }
  });

  proc.on('error', (err) => {
    db.prepare(
      `UPDATE tasks SET status = 'error', error_message = ?, finished_at = ? WHERE id = ?`,
    ).run('spawn failed: ' + err.message, Date.now(), taskId);
  });

  // soft timeout — за 30 секунд до лимита шлём Claude инструкцию финализировать
  const softDelay = Math.max(30_000, (maxTimeSec - 30) * 1000);
  const softTimer = setTimeout(() => {
    try {
      proc.stdin.write(
        '\n[SYSTEM] Time budget is nearly exhausted. STOP current work NOW. ' +
          'Finalize immediately with a pause summary using these EXACT markers:\n' +
          '`## DONE` — bullet list of what was completed / files written\n' +
          '`## REMAINING` — bullet list of what remains to be done\n' +
          'Save intermediate results to outputs/. Then finish your turn.\n',
      );
    } catch {
      // stdin may already be closed
    }
    const r = running.get(taskId);
    if (r) {
      r.softSignalSent = true;
      // Hard kill 90s later — если Claude не финализирует
      r.hardTimer = setTimeout(() => {
        const still = running.get(taskId);
        if (still && !still.proc.killed) {
          still.proc.kill('SIGTERM');
          db.prepare(
            `UPDATE tasks SET status = 'timeout', error_message = 'hard timeout after soft-signal', finished_at = ? WHERE id = ?`,
          ).run(Date.now(), taskId);
        }
      }, 90_000);
    }
  }, softDelay);

  running.set(taskId, { proc, softTimer });

  return { taskId, chatId, workdir };
}

/** Обработка одной stream-json строки. */
function handleEvent(db: Database.Database, taskId: string, line: string): void {
  let ev: any;
  try {
    ev = JSON.parse(line);
  } catch {
    return; // non-JSON noise
  }

  // system init — сохраняем session_id для следующего --resume
  if (ev.type === 'system' && ev.subtype === 'init') {
    if (ev.session_id) {
      db.prepare(
        `UPDATE chats SET claude_session_id = ?, updated_at = ? WHERE id = (SELECT chat_id FROM tasks WHERE id = ?)`,
      ).run(String(ev.session_id), Date.now(), taskId);
    }
    return;
  }

  // user message с tool_result — проверяем маркеры hook'а
  if (ev.type === 'user' && ev.message?.content) {
    const content = ev.message.content as Array<{ type: string; content?: unknown; is_error?: boolean }>;
    for (const part of content) {
      if (part.type === 'tool_result') {
        const text =
          typeof part.content === 'string'
            ? part.content
            : Array.isArray(part.content)
              ? (part.content as Array<{ text?: string }>).map((p) => p.text ?? '').join('\n')
              : '';
        const awaiting = text.match(/\[CC_AWAITING_APPROVAL\]\s*(.+)/);
        if (awaiting) {
          const prompt = awaiting[1].trim();
          // Помечаем задачу как awaiting_approval. Процесс Claude сам завершит turn —
          // его result event игнорируется guard'ом. Session сохраняется → --resume работает.
          db.prepare(
            `UPDATE tasks SET status = 'awaiting_approval', approval_prompt = ?, finished_at = ? WHERE id = ?`,
          ).run(prompt, Date.now(), taskId);
          return;
        }
        const denied = text.match(/\[CC_DENIED\]\s*(.+)/);
        if (denied) {
          db.prepare(
            `INSERT INTO actions (task_id, timestamp, kind, summary) VALUES (?, ?, ?, ?)`,
          ).run(taskId, Date.now(), '🚫', 'denied: ' + denied[1].trim().slice(0, 160));
        }
      }
    }
    return;
  }

  // assistant message с tool_use
  if (ev.type === 'assistant' && ev.message?.content) {
    const content = ev.message.content as Array<{ type: string; name?: string; input?: unknown; text?: string }>;
    for (const part of content) {
      if (part.type === 'tool_use' && part.name) {
        const { kind, summary } = describeTool(part.name, part.input);
        db.prepare(
          `INSERT INTO actions (task_id, timestamp, kind, summary) VALUES (?, ?, ?, ?)`,
        ).run(taskId, Date.now(), kind, summary);
        // Обновим last_action в chats
        db.prepare(
          `UPDATE chats SET last_action = ?, updated_at = ? WHERE id = (SELECT chat_id FROM tasks WHERE id = ?)`,
        ).run(`${kind} ${summary}`, Date.now(), taskId);
      }
      // text-part ассистента можем тоже регистрировать как 💬
      if (part.type === 'text' && part.text && part.text.trim().length > 0) {
        db.prepare(
          `INSERT INTO actions (task_id, timestamp, kind, summary) VALUES (?, ?, ?, ?)`,
        ).run(taskId, Date.now(), '💬', 'говорит: ' + part.text.slice(0, 160));
      }
    }
    return;
  }

  // Финальный результат
  if (ev.type === 'result') {
    // Защита: если уже перевели в терминальный статус (awaiting_approval/paused/cancelled) — не перезаписываем
    const cur = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string } | undefined;
    if (cur && ['awaiting_approval', 'paused', 'cancelled', 'timeout'].includes(cur.status)) {
      return;
    }
    const r = running.get(taskId);
    const wasPaused = !!r?.softSignalSent;
    const resultText =
      typeof ev.result === 'string' ? ev.result : JSON.stringify(ev.result ?? '');
    const tokens =
      (ev.usage?.input_tokens ?? 0) +
      (ev.usage?.output_tokens ?? 0) +
      (ev.usage?.cache_read_input_tokens ?? 0);

    if (wasPaused && ev.subtype === 'success') {
      // Извлекаем pause_summary из секций "Сделано:" / "Осталось:"
      const pauseSummary = extractPauseSummary(resultText);
      db.prepare(
        `UPDATE tasks SET status = 'paused', partial_result = ?, pause_summary = ?,
         finished_at = ?, steps_done = ?, tokens_used = ? WHERE id = ?`,
      ).run(resultText, pauseSummary, Date.now(), ev.num_turns ?? 0, tokens, taskId);
    } else {
      const status: TaskStatus = ev.subtype === 'success' ? 'done' : 'error';
      db.prepare(
        `UPDATE tasks SET status = ?, result = ?, finished_at = ?, steps_done = ?, tokens_used = ? WHERE id = ?`,
      ).run(status, resultText, Date.now(), ev.num_turns ?? 0, tokens, taskId);
    }
    return;
  }
}

/** Извлекает pause-summary: секции `## DONE` и `## REMAINING` (или рус. «Сделано/Осталось»). */
function extractPauseSummary(text: string): string {
  const patterns: Array<[RegExp, RegExp]> = [
    [/##\s*DONE\b[\s\S]*?(?=##\s*REMAINING|$)/i, /##\s*REMAINING\b[\s\S]*/i],
    [/Сделано:[\s\S]*?(?=Осталось:|$)/i, /Осталось:[\s\S]*/i],
  ];
  for (const [doneRe, leftRe] of patterns) {
    const d = text.match(doneRe);
    const l = text.match(leftRe);
    if (d || l) {
      return [d?.[0], l?.[0]].filter(Boolean).map((s) => s!.trim()).join('\n\n').slice(0, 2000);
    }
  }
  return text.slice(-500);
}

/** Обработка завершения процесса (если не было `result` → помечаем как error/timeout). */
function handleClose(
  db: Database.Database,
  taskId: string,
  code: number | null,
  stderr: string,
): void {
  const task = db
    .prepare('SELECT status FROM tasks WHERE id = ?')
    .get(taskId) as { status: TaskStatus } | undefined;

  if (!task) return;

  // Уже в финальном состоянии
  if (
    task.status === 'done' ||
    task.status === 'error' ||
    task.status === 'timeout' ||
    task.status === 'cancelled' ||
    task.status === 'paused' ||
    task.status === 'awaiting_approval'
  ) {
    return;
  }

  // Процесс умер сам, но result event не пришёл
  const msg = stderr.slice(-500) || `exited with code ${code}`;
  db.prepare(
    `UPDATE tasks SET status = 'error', error_message = ?, finished_at = ? WHERE id = ?`,
  ).run(msg, Date.now(), taskId);
}

/** Graceful stop — SIGTERM через 30 сек если не завершился. */
export function stopTask(db: Database.Database, taskId: string): boolean {
  const r = running.get(taskId);
  if (!r) return false;

  try {
    r.proc.stdin.write('\n[SYSTEM] User requested cancel. Finish immediately.\n');
  } catch {
    /* stdin closed */
  }

  // Через 30 сек — SIGTERM
  setTimeout(() => {
    const still = running.get(taskId);
    if (still && !still.proc.killed) {
      still.proc.kill('SIGTERM');
    }
  }, 30_000);

  db.prepare(`UPDATE tasks SET status = 'cancelled', finished_at = ? WHERE id = ?`).run(
    Date.now(),
    taskId,
  );
  return true;
}
