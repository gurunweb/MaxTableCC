// permissionHook.ts — установка PreToolUse hook для safe-режима
// Пишет .claude/settings.json в workdir чата с вызовом cc-permission-check.sh
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const HOOK_SCRIPT = process.env.CC_HOOK_SCRIPT ?? '/opt/cc-bridge/hooks/cc-permission-check.sh';

export function installSafeHook(workdir: string): void {
  const settingsDir = join(workdir, '.claude');
  if (!existsSync(settingsDir)) {
    mkdirSync(settingsDir, { recursive: true });
  }
  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: '*',
          hooks: [{ type: 'command', command: HOOK_SCRIPT }],
        },
      ],
    },
  };
  writeFileSync(join(settingsDir, 'settings.json'), JSON.stringify(settings, null, 2));
}

export function removeSafeHook(workdir: string): void {
  const settingsFile = join(workdir, '.claude', 'settings.json');
  if (existsSync(settingsFile)) {
    writeFileSync(settingsFile, '{}');
  }
}
