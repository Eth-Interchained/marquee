/**
 * The bundled Python runtime, as the UI sees it.
 *
 * Everything goes through this origin's `/runtime/*` — the shell's UI server
 * strips the prefix and adds the runtime's capability token. This page never
 * holds that token, and on the web development surface there is no shell and
 * therefore no runtime: `/runtime/health` answers 503 with a named reason and
 * the UI says exactly that instead of pretending.
 */

export type RuntimeHealth = {
  status: string;
  runtime: string;
  version: string;
  python: string;
  platform: string;
  gated: boolean;
  programs: string[];
  pty: boolean;
};

export type RuntimeState =
  | { kind: 'checking' }
  | { kind: 'ready'; health: RuntimeHealth }
  | { kind: 'unavailable'; detail: string };

export type TerminalProgram = 'shell' | 'python' | 'node';

export async function fetchRuntimeHealth(): Promise<RuntimeState> {
  try {
    const response = await fetch('/runtime/health', { cache: 'no-store' });
    if (response.ok) {
      return { kind: 'ready', health: (await response.json()) as RuntimeHealth };
    }
    let detail = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { detail?: string; error?: string };
      detail = body.detail ?? body.error ?? detail;
    } catch {
      // Non-JSON body: the status is the whole story.
    }
    return { kind: 'unavailable', detail };
  } catch (error) {
    return {
      kind: 'unavailable',
      detail: `could not reach /runtime/health: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** ws(s)://<this origin>/runtime/ws/pty?program=…&cols=…&rows=… */
export function ptySocketUrl(program: TerminalProgram, cols: number, rows: number): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const params = new URLSearchParams({ program, cols: String(cols), rows: String(rows) });
  return `${proto}//${window.location.host}/runtime/ws/pty?${params.toString()}`;
}

/** Control frame for the runtime's PTY protocol (NUL prefix + JSON). */
export function resizeFrame(cols: number, rows: number): string {
  // U+0000 prefix: the runtime treats a text frame starting with NUL as control.
  return '\u0000' + JSON.stringify({ type: 'resize', cols, rows });
}

export type PtyServerFrame = { type: 'exit'; code: number } | { type: 'error'; detail: string };

/** Server text frames are JSON control messages; anything else is a protocol bug worth naming. */
export function parseServerFrame(text: string): PtyServerFrame | { type: 'unknown'; raw: string } {
  try {
    const parsed = JSON.parse(text) as Partial<PtyServerFrame>;
    if (parsed.type === 'exit' && typeof parsed.code === 'number') return { type: 'exit', code: parsed.code };
    if (parsed.type === 'error' && typeof parsed.detail === 'string') return { type: 'error', detail: parsed.detail };
  } catch {
    // fall through
  }
  return { type: 'unknown', raw: text };
}
