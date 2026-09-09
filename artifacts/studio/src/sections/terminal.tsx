import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { Plus, RotateCcw, SquareTerminal, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SectionShell, type SectionProps } from '@/sections/section-shell';
import {
  fetchRuntimeHealth,
  parseServerFrame,
  ptySocketUrl,
  resizeFrame,
  type RuntimeState,
  type TerminalProgram,
} from '@/lib/runtime-client';
import { cn } from '@/lib/utils';

/**
 * A real terminal — a PTY served by the shell's bundled Python, rendered by
 * xterm.js. Not a log viewer, not a textarea: colours, cursor, vim, htop.
 *
 * The program is chosen from a closed list the runtime enforces; the page
 * cannot spawn arbitrary argv. On the web development surface there is no
 * shell and therefore no runtime, and the panel says so in the runtime's own
 * words rather than showing an empty box.
 */

type Tab = {
  id: string;
  program: TerminalProgram;
  title: string;
  status: 'connecting' | 'live' | 'exited' | 'error';
  detail?: string;
};

const PROGRAM_LABEL: Record<TerminalProgram, string> = {
  shell: 'Shell',
  python: 'Python',
  node: 'Node',
};

const PROGRAM_HINT: Record<TerminalProgram, string> = {
  shell: 'your login shell',
  python: 'python3 -i, the bundled interpreter',
  node: 'node',
};

let tabCounter = 0;

/**
 * The xterm palette is set from the app's own tokens so the terminal is the
 * same dark surface as the rest of the shell, with the holo hues as ANSI
 * accents: violet for blue, mint for green, coral for red — the three colours
 * the composer's bloom already uses. One vocabulary.
 */
const THEME = {
  background: 'hsl(228 20% 7%)',
  foreground: 'hsl(220 22% 92%)',
  cursor: 'hsl(255 84% 68%)',
  cursorAccent: 'hsl(228 20% 7%)',
  selectionBackground: 'rgb(124 92 255 / 0.28)',
  black: '#0f1117',
  red: '#ff8d69',
  green: '#40d9a0',
  yellow: '#f5c26b',
  blue: '#7c5cff',
  magenta: '#d17cff',
  cyan: '#5fd3ff',
  white: '#d9dbe3',
  brightBlack: '#5b6070',
  brightRed: '#ffa88d',
  brightGreen: '#6ff0bd',
  brightYellow: '#ffd98a',
  brightBlue: '#a08cff',
  brightMagenta: '#e5a3ff',
  brightCyan: '#8fe3ff',
  brightWhite: '#ffffff',
};

function TerminalPane({
  tab,
  active,
  onStatus,
}: {
  tab: Tab;
  active: boolean;
  onStatus: (id: string, status: Tab['status'], detail?: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontSize: 13,
      fontFamily: '"JetBrains Mono", "Fira Code", Menlo, monospace',
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowProposedApi: true,
      scrollback: 5000,
      theme: THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try {
      term.loadAddon(new WebglAddon());
    } catch (error) {
      // The canvas renderer is the fallback; say so once rather than silently.
      console.warn('[terminal] WebGL renderer unavailable, using canvas:', error);
    }
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    const socket = new WebSocket(ptySocketUrl(tab.program, term.cols, term.rows));
    socket.binaryType = 'arraybuffer';
    socketRef.current = socket;

    socket.addEventListener('open', () => onStatus(tab.id, 'live'));
    socket.addEventListener('message', (event: MessageEvent<ArrayBuffer | string>) => {
      if (typeof event.data === 'string') {
        const frame = parseServerFrame(event.data);
        if (frame.type === 'exit') {
          term.write(`\r\n\x1b[2m[${PROGRAM_LABEL[tab.program]} exited with code ${frame.code}]\x1b[0m\r\n`);
          onStatus(tab.id, 'exited', `exit ${frame.code}`);
        } else if (frame.type === 'error') {
          term.write(`\r\n\x1b[31m[runtime] ${frame.detail}\x1b[0m\r\n`);
          onStatus(tab.id, 'error', frame.detail);
        } else {
          console.error('[terminal] unrecognised control frame from runtime:', frame.raw);
        }
        return;
      }
      term.write(new Uint8Array(event.data));
    });
    socket.addEventListener('close', (event) => {
      if (event.code === 1000 || event.code === 1005) return; // normal, after exit
      const reason = event.reason || `socket closed (${event.code})`;
      term.write(`\r\n\x1b[31m[terminal] ${reason}\x1b[0m\r\n`);
      onStatus(tab.id, 'error', reason);
    });
    socket.addEventListener('error', () => {
      // The close event that follows carries the code; this one only confirms
      // the pipe broke. Log it so a dead runtime is not mistaken for a slow one.
      console.error('[terminal] websocket error for tab', tab.id);
    });

    const inputDisposable = term.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    });
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(resizeFrame(cols, rows));
    });

    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // Fitting a hidden pane throws; it fits again when shown.
      }
    });
    observer.observe(host);

    return () => {
      observer.disconnect();
      inputDisposable.dispose();
      resizeDisposable.dispose();
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(1000, 'tab closed');
      }
      term.dispose();
      termRef.current = null;
      socketRef.current = null;
    };
    // The pane is keyed by tab id; a new tab is a new pane.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

  useEffect(() => {
    if (!active) return;
    // Re-fit and focus when this tab becomes visible again.
    const id = window.requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {
        /* hidden */
      }
      termRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(id);
  }, [active]);

  return (
    <div
      ref={hostRef}
      className={cn('absolute inset-0 p-2', active ? 'block' : 'hidden')}
      data-testid={`terminal-pane-${tab.id}`}
    />
  );
}

export function TerminalSection({ workspace }: SectionProps) {
  const [runtime, setRuntime] = useState<RuntimeState>({ kind: 'checking' });
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  const probe = useCallback(async () => {
    setRuntime({ kind: 'checking' });
    setRuntime(await fetchRuntimeHealth());
  }, []);

  useEffect(() => {
    void probe();
  }, [probe]);

  const openTab = useCallback((program: TerminalProgram) => {
    tabCounter += 1;
    const tab: Tab = {
      id: `t${tabCounter}`,
      program,
      title: `${PROGRAM_LABEL[program]} ${tabCounter}`,
      status: 'connecting',
    };
    setTabs((current) => [...current, tab]);
    setActiveId(tab.id);
  }, []);

  const closeTab = useCallback((id: string) => {
    setTabs((current) => {
      const remaining = current.filter((tab) => tab.id !== id);
      setActiveId((active) => (active === id ? (remaining.at(-1)?.id ?? null) : active));
      return remaining;
    });
  }, []);

  const setStatus = useCallback((id: string, status: Tab['status'], detail?: string) => {
    setTabs((current) => current.map((tab) => (tab.id === id ? { ...tab, status, detail } : tab)));
  }, []);

  // First visit with a live runtime: open a shell so the section is never an
  // empty room. Only once — closing the last tab is a choice, not a bug.
  const autoOpened = useRef(false);
  useEffect(() => {
    if (runtime.kind === 'ready' && runtime.health.pty && !autoOpened.current) {
      autoOpened.current = true;
      openTab('shell');
    }
  }, [runtime, openTab]);

  const ready = runtime.kind === 'ready';
  const ptyOk = ready && runtime.health.pty;

  return (
    <SectionShell
      title="Terminal"
      description={
        ready
          ? `A real PTY from the shell's bundled Python ${runtime.health.python} on ${runtime.health.platform}. Colours, cursor, vim — the whole thing. Runs in the ${workspace.name} workspace's data directory.`
          : 'A real terminal served by the shell’s bundled Python. It needs the desktop shell: the web surface has no runtime to connect to.'
      }
      actions={
        <>
          <RuntimeBadge state={runtime} onRetry={probe} />
          {(['shell', 'python', 'node'] as TerminalProgram[]).map((program) => (
            <Tooltip key={program}>
              <TooltipTrigger asChild>
                <Button
                  variant={program === 'shell' ? 'default' : 'outline'}
                  size="sm"
                  disabled={!ptyOk}
                  onClick={() => openTab(program)}
                  data-testid={`button-open-${program}`}
                >
                  <Plus className="mr-1.5 h-3.5 w-3.5" />
                  {PROGRAM_LABEL[program]}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{PROGRAM_HINT[program]}</TooltipContent>
            </Tooltip>
          ))}
        </>
      }
    >
      <div
        className={cn(
          'relative flex min-h-[520px] flex-col overflow-hidden rounded-lg border border-card-border bg-[hsl(228_20%_7%)]',
          runtime.kind === 'checking' && 'mq-ghost',
        )}
        style={{ boxShadow: `inset 0 2px 0 0 ${workspace.accent}` }}
      >
        {/* Tab strip — same shape as the browser chrome's workspace tabs. */}
        <div className="flex items-end gap-1 border-b border-border/60 bg-sidebar px-2 pt-2">
          <SquareTerminal className="mb-2 ml-1 mr-1 h-4 w-4 text-muted-foreground" />
          <div className="flex min-w-0 flex-1 items-end gap-1 overflow-x-auto">
            {tabs.map((tab) => {
              const isActive = tab.id === activeId;
              return (
                <div
                  key={tab.id}
                  className={cn(
                    'group relative flex h-8 min-w-[140px] max-w-[220px] shrink-0 items-center gap-2 rounded-t-md border border-b-0 px-3 text-xs transition-colors',
                    isActive
                      ? 'border-border bg-[hsl(228_20%_7%)] text-foreground'
                      : 'border-transparent text-muted-foreground hover-elevate',
                  )}
                  style={isActive ? { boxShadow: `inset 0 2px 0 0 ${workspace.accent}` } : undefined}
                >
                  <button
                    type="button"
                    onClick={() => setActiveId(tab.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    data-testid={`tab-terminal-${tab.id}`}
                  >
                    <StatusDot status={tab.status} />
                    <span className="truncate font-mono">{tab.title}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Close ${tab.title}`}
                    onClick={() => closeTab(tab.id)}
                    className="rounded p-0.5 opacity-0 transition-opacity hover-elevate group-hover:opacity-100"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
          </div>
          {tabs.length > 0 ? (
            <span className="mb-2 mr-1 font-mono text-[10px] text-muted-foreground">
              {tabs.find((tab) => tab.id === activeId)?.detail ?? ''}
            </span>
          ) : null}
        </div>

        {/* Panes: every open tab stays mounted so its scrollback survives switching. */}
        <div className="relative flex-1">
          {tabs.map((tab) => (
            <TerminalPane key={tab.id} tab={tab} active={tab.id === activeId} onStatus={setStatus} />
          ))}

          {tabs.length === 0 ? (
            <div className="absolute inset-0 flex items-center justify-center p-8 text-center">
              <div className="max-w-md space-y-3">
                <SquareTerminal className="mx-auto h-8 w-8 text-muted-foreground" />
                {runtime.kind === 'unavailable' ? (
                  <>
                    <p className="text-sm font-medium">No runtime to connect to</p>
                    <p className="font-mono text-xs leading-relaxed text-muted-foreground">{runtime.detail}</p>
                    <p className="text-xs text-muted-foreground">
                      The terminal is served by the desktop shell’s bundled Python. Run the shell (<code>pnpm --filter @marquee/shell start</code>) rather than the web dev server.
                    </p>
                  </>
                ) : runtime.kind === 'ready' && !runtime.health.pty ? (
                  <>
                    <p className="text-sm font-medium">PTY not available on {runtime.health.platform}</p>
                    <p className="text-xs text-muted-foreground">
                      The runtime is up, but a pseudo-terminal on this platform needs pywinpty, which is not wired yet. <code>/run_code</code> still works.
                    </p>
                  </>
                ) : runtime.kind === 'checking' ? (
                  <p className="text-sm text-muted-foreground">Reaching the runtime…</p>
                ) : (
                  <>
                    <p className="text-sm font-medium">No open terminals</p>
                    <p className="text-xs text-muted-foreground">Open a shell, a Python REPL, or Node from the buttons above.</p>
                  </>
                )}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </SectionShell>
  );
}

function StatusDot({ status }: { status: Tab['status'] }) {
  return (
    <span
      className={cn(
        'h-1.5 w-1.5 shrink-0 rounded-full',
        status === 'live' && 'bg-chart-2',
        status === 'connecting' && 'animate-pulse bg-chart-1',
        status === 'exited' && 'bg-muted-foreground',
        status === 'error' && 'bg-destructive',
      )}
    />
  );
}

function RuntimeBadge({ state, onRetry }: { state: RuntimeState; onRetry: () => void }) {
  if (state.kind === 'checking') {
    return <Badge variant="outline" className="font-mono text-[10px]">runtime · checking</Badge>;
  }
  if (state.kind === 'ready') {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" className="gap-1.5 font-mono text-[10px]" data-testid="badge-runtime">
            <span className="h-1.5 w-1.5 rounded-full bg-chart-2" />
            runtime · py {state.health.python}
            {state.health.gated ? ' · gated' : ' · UNGATED'}
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs font-mono text-[11px]">
          {state.health.runtime} v{state.health.version} · {state.health.platform} · programs: {state.health.programs.join(', ')}
        </TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Button variant="outline" size="sm" onClick={onRetry} data-testid="button-runtime-retry" className="gap-1.5 text-destructive">
      <RotateCcw className="h-3.5 w-3.5" />
      runtime unavailable · retry
    </Button>
  );
}
