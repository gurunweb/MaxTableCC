// permissionHook.ts — установка .claude/settings.json с hook'ами для cc-bridge.
//
// PostToolUse cc-auto-publish — ставится всегда. Реагирует на Write/Edit
// в outputs/ и подкладывает Claude URL опубликованного файла как additionalContext.
//
// PreToolUse cc-permission-check — ставится только в safe-режиме. Блокирует
// опасные операции или переводит задачу в awaiting_approval.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PERMISSION_HOOK =
  process.env.CC_HOOK_SCRIPT ?? '/opt/cc-bridge/hooks/cc-permission-check.sh';
const AUTO_PUBLISH_HOOK =
  process.env.CC_AUTO_PUBLISH_HOOK ?? '/opt/cc-bridge/hooks/cc-auto-publish.sh';

export interface HookOptions {
  /** safe-режим: дополнительно подключить PreToolUse permission-check. */
  safe?: boolean;
}

export function installHooks(workdir: string, opts: HookOptions = {}): void {
  const settingsDir = join(workdir, '.claude');
  if (!existsSync(settingsDir)) {
    mkdirSync(settingsDir, { recursive: true });
  }

  const settings: {
    hooks: {
      PreToolUse?: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>;
      PostToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>;
    };
  } = {
    hooks: {
      PostToolUse: [
        {
          matcher: 'Write|Edit|MultiEdit|NotebookEdit',
          hooks: [{ type: 'command', command: AUTO_PUBLISH_HOOK }],
        },
      ],
    },
  };

  if (opts.safe) {
    settings.hooks.PreToolUse = [
      {
        matcher: '*',
        hooks: [{ type: 'command', command: PERMISSION_HOOK }],
      },
    ];
  }

  writeFileSync(join(settingsDir, 'settings.json'), JSON.stringify(settings, null, 2));
}

/** @deprecated — оставлено для совместимости. Используй installHooks(workdir, {safe: true}). */
export function installSafeHook(workdir: string): void {
  installHooks(workdir, { safe: true });
}

/** @deprecated — оставлено для совместимости. Используй installHooks(workdir, {safe: false}). */
export function removeSafeHook(workdir: string): void {
  installHooks(workdir, { safe: false });
}
