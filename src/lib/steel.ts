// steel.ts — тонкий HTTP-клиент к steel-browser (https://github.com/steel-dev/steel-browser).
//
// Steel-browser крутится в Docker рядом с cc-bridge на 127.0.0.1:3000, даёт:
//   POST /v1/sessions       — создать headed-сессию chromium
//   DELETE /v1/sessions/:id — закрыть сессию
//   GET /v1/sessions        — список активных
//   GET /v1/sessions/:id    — статус
//
// Если STEEL_API_URL не задан в env → клиент возвращает isDisabled=true,
// и cc-bridge просто не создаёт browser-сессии (опциональная фича).

const STEEL_API_URL = process.env.STEEL_API_URL ?? '';
const STEEL_TIMEOUT_MS = Number(process.env.STEEL_TIMEOUT_MS ?? '10000');

export interface SteelSession {
  id: string;
  websocketUrl: string; // CDP-ws endpoint для playwright connectOverCDP
  sessionViewerUrl?: string; // встроенный noVNC-style viewer (если steel вернул)
}

export function isSteelEnabled(): boolean {
  return STEEL_API_URL.length > 0;
}

async function steelFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!STEEL_API_URL) {
    throw new Error('STEEL_API_URL not configured');
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), STEEL_TIMEOUT_MS);
  try {
    return await fetch(STEEL_API_URL.replace(/\/+$/, '') + path, {
      ...init,
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
  } finally {
    clearTimeout(t);
  }
}

export interface CreateSessionInput {
  /** Стабильный sessionId, если хотим переиспользовать (steel поддерживает). */
  sessionId?: string;
  userAgent?: string;
  dimensions?: { width: number; height: number };
  /** Timeout перед автозакрытием самого steel (мы сами GC-им раньше). */
  timeoutMs?: number;
}

export async function createSession(input: CreateSessionInput = {}): Promise<SteelSession> {
  const body: Record<string, unknown> = {
    sessionTimeout: input.timeoutMs ?? 1000 * 60 * 60, // 1 час hard-limit на стороне steel
  };
  if (input.sessionId) body.sessionId = input.sessionId;
  if (input.userAgent) body.userAgent = input.userAgent;
  if (input.dimensions) body.dimensions = input.dimensions;

  const res = await steelFetch('/v1/sessions', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`steel createSession ${res.status}: ${text}`);
  }
  const data = (await res.json()) as {
    id?: string;
    websocketUrl?: string;
    sessionViewerUrl?: string;
    debugUrl?: string;
  };
  if (!data.id || !data.websocketUrl) {
    throw new Error('steel createSession: malformed response, missing id/websocketUrl');
  }
  return {
    id: data.id,
    websocketUrl: data.websocketUrl,
    sessionViewerUrl: data.sessionViewerUrl ?? data.debugUrl,
  };
}

export async function releaseSession(sessionId: string): Promise<void> {
  try {
    const res = await steelFetch(`/v1/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    });
    // 404 трактуем как уже закрытую — OK
    if (!res.ok && res.status !== 404) {
      const text = await res.text().catch(() => '');
      console.warn(`steel releaseSession ${sessionId}: ${res.status} ${text}`);
    }
  } catch (err: any) {
    console.warn(`steel releaseSession ${sessionId} failed: ${err.message}`);
  }
}

export async function getSession(sessionId: string): Promise<SteelSession | null> {
  const res = await steelFetch(`/v1/sessions/${encodeURIComponent(sessionId)}`);
  if (res.status === 404) return null;
  if (!res.ok) return null;
  const data = (await res.json()) as {
    id?: string;
    websocketUrl?: string;
    sessionViewerUrl?: string;
  };
  if (!data.id || !data.websocketUrl) return null;
  return {
    id: data.id,
    websocketUrl: data.websocketUrl,
    sessionViewerUrl: data.sessionViewerUrl,
  };
}
