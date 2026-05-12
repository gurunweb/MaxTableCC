// mcpMerge.ts — собирает финальный mcp.json для запуска Claude из трёх уровней:
//   1) Global: /etc/cc-bridge/mcp.json (по умолчанию пусто)
//   2) Project: {projectRoot}/.mcp.json (если чат в проекте)
//   3) Chat: {chatDir}/.mcp.json
//
// Чат перекрывает проект, проект перекрывает global. Результат пишется во
// временный файл, путь возвращается и передаётся как --mcp-config.
//
// Дополнительно: для playwright подменяем user-data-dir на per-user, чтобы
// cookies/логины разных юзеров не пересекались.

import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface McpServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpConfig {
  mcpServers?: Record<string, McpServer>;
}

function readConfig(path: string): McpConfig {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as McpConfig;
  } catch {
    return {};
  }
}

/**
 * Доводит конфиг playwright:
 *   - если задан cdpEndpoint (steel-browser сессия) → переключаем в attach-режим
 *     (--cdp-endpoint), убираем --user-data-dir (он управляется steel-ом);
 *   - иначе per-user user-data-dir для изоляции cookies на shared-сервере.
 */
function specializeServer(
  name: string,
  server: McpServer,
  userEmail: string,
  cdpEndpoint: string | null,
): McpServer {
  if (name !== 'playwright') return server;
  const args = [...(server.args ?? [])];

  if (cdpEndpoint) {
    // Удаляем любые args/флаги управления собственным браузером
    const filtered = args.filter(
      (a) =>
        !a.startsWith('--user-data-dir') &&
        !a.startsWith('--cdp-endpoint') &&
        !a.startsWith('--executable-path') &&
        !a.startsWith('--browser'),
    );
    filtered.push(`--cdp-endpoint=${cdpEndpoint}`);
    return { ...server, args: filtered };
  }

  const safeEmail = userEmail.replace(/[^a-zA-Z0-9@._-]/g, '_');
  const profile = `/workspaces/${safeEmail}/playwright-profile`;
  if (!args.some((a) => a === '--user-data-dir' || a.startsWith('--user-data-dir='))) {
    args.push(`--user-data-dir=${profile}`);
  }
  return { ...server, args };
}

export interface BuildMcpInput {
  globalConfigPath: string;
  workdir: string;
  chatDir: string;
  userEmail: string;
  /** Если задан — playwright MCP подключается к этому CDP вместо launch. */
  playwrightCdpEndpoint?: string | null;
}

export interface BuildMcpResult {
  path: string;
  isEmpty: boolean;
}

/**
 * Собирает финальный mcp.json и возвращает путь к нему. Если итоговый набор
 * пуст — isEmpty=true (тогда вызывающий код не передаёт --mcp-config).
 */
export function buildMergedMcpConfig(input: BuildMcpInput): BuildMcpResult {
  const layers: McpConfig[] = [
    readConfig(input.globalConfigPath),
    readConfig(join(input.workdir, '.mcp.json')),
    // chat-level применяется только если chatDir != workdir (project chat)
    input.chatDir !== input.workdir ? readConfig(join(input.chatDir, '.mcp.json')) : {},
  ];

  const merged: Record<string, McpServer> = {};
  for (const layer of layers) {
    const servers = layer.mcpServers ?? {};
    for (const [name, srv] of Object.entries(servers)) {
      if (srv === null) {
        // null = explicit disable на уровне (например, проект отключает global)
        delete merged[name];
      } else {
        merged[name] = specializeServer(
          name,
          srv,
          input.userEmail,
          input.playwrightCdpEndpoint ?? null,
        );
      }
    }
  }

  const names = Object.keys(merged);
  if (names.length === 0) {
    return { path: '', isEmpty: true };
  }

  const dir = mkdtempSync(join(tmpdir(), 'cc-mcp-'));
  const file = join(dir, 'mcp.json');
  writeFileSync(file, JSON.stringify({ mcpServers: merged }, null, 2));
  return { path: file, isEmpty: false };
}
