import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppWindow, Camera, Clapperboard, Mic, Monitor, MonitorUp, Radio, Receipt, ShieldCheck, ShieldAlert, Square, Volume2, X } from 'lucide-react';
import {
  getGetStudioSceneQueryKey,
  getListStudioEventsQueryKey,
  useGetStudioScene,
  useListStudioEvents,
  useRecordStudioEvent,
  useSaveStudioScene,
  type StudioEvent,
  type StudioEventKind,
} from '@workspace/api-client-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { SectionShell, type SectionProps } from '@/sections/section-shell';
import { getShell, type ShellCaptureSource } from '@/lib/shell-bridge';
import { Mixer } from '@/lib/studio/audio.ts';
import { captureCamera, captureMic, captureScreen, stopStream, videoFor, type CaptureError } from '@/lib/studio/capture.ts';
import { Compositor } from '@/lib/studio/compositor.ts';
import { viewerUrls, WhipPublisher, type WhipState } from '@/lib/studio/whip.ts';
import { Input } from '@/components/ui/input';
import {
  bringToFront,
  defaultScene,
  hitHandle,
  hitTest,
  moveRect,
  resizeRect,
  toNormalised,
  updateLayer,
  type Handle,
  type Layer,
  type Scene,
} from '@/lib/studio/scene.ts';
import { cn } from '@/lib/utils';

/**
 * The Studio: screen or game, a camera in the corner, a mixer — composited on
 * one canvas that is both the preview and, in the next step, the broadcast.
 *
 * Inside the shell, screen capture goes through the shell's own picker: the
 * page lists the OS's screens and windows, arms the shell with the choice, and
 * only then calls getDisplayMedia(). On the web surface there is no shell and
 * the browser's built-in picker is used, which the panel says out loud —
 * along with the one limit that is Chromium's, not ours: system audio.
 */

type Drag =
  | { mode: 'move'; id: string; lastX: number; lastY: number }
  | { mode: 'resize'; id: string; handle: Handle; lastX: number; lastY: number };

type Notice = { level: 'info' | 'warn' | 'error'; text: string; raw?: string; at: number };

const CORNER = { w: 0.24, h: 0.24 * (16 / 9) * (1080 / 1920) };
const CORNERS: Array<{ label: string; rect: Layer['rect'] }> = [
  { label: '↘', rect: { x: 0.735, y: 0.69, ...CORNER } },
  { label: '↙', rect: { x: 0.025, y: 0.69, ...CORNER } },
  { label: '↗', rect: { x: 0.735, y: 0.04, ...CORNER } },
  { label: '↖', rect: { x: 0.025, y: 0.04, ...CORNER } },
];

export function StudioSection({ workspace }: SectionProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const compositorRef = useRef<Compositor | null>(null);
  const mixerRef = useRef<Mixer | null>(null);
  const streamsRef = useRef<Record<string, MediaStream>>({});
  const dragRef = useRef<Drag | null>(null);

  const [scene, setScene] = useState<Scene>(() => defaultScene());
  const [selected, setSelected] = useState<string | null>('camera');
  const [notices, setNotices] = useState<Notice[]>([]);
  const [fps, setFps] = useState(0);
  const [sources, setSources] = useState<Record<string, string>>({});
  const [levels, setLevels] = useState<Record<string, number>>({});
  const [gains, setGains] = useState<Record<string, number>>({});
  const [picker, setPicker] = useState<{ open: boolean; loading: boolean; sources: ShellCaptureSource[]; error: string | null }>({
    open: false,
    loading: false,
    sources: [],
    error: null,
  });
  const [withSystemAudio, setWithSystemAudio] = useState(true);

  const notify = useCallback((level: Notice['level'], text: string, raw?: string) => {
    setNotices((prev) => [{ level, text, raw, at: Date.now() }, ...prev].slice(0, 6));
    if (level === 'error') console.error(`[studio] ${text}${raw ? ` — ${raw}` : ''}`);
  }, []);

  // ---- receipts: every on-air event is an append-only document in the store ----
  const recordEvent = useRecordStudioEvent();
  const saveScene = useSaveStudioScene();
  const eventsQuery = useListStudioEvents({ workspaceId: workspace.id, limit: 8 }, { query: { retry: false, queryKey: getListStudioEventsQueryKey({ workspaceId: workspace.id, limit: 8 }) } });
  const savedScene = useGetStudioScene(workspace.id, { query: { retry: false, queryKey: getGetStudioSceneQueryKey(workspace.id) } });
  const liveEventIdRef = useRef<string | null>(null);

  /**
   * Record an event, never silently. A receipt that fails to write is shown
   * as a notice with the server's reason; the on-air action itself is not
   * blocked by it — the stream is the operator's, the ledger is ours to keep.
   */
  const record = useCallback(
    async (kind: StudioEventKind, payload: Record<string, unknown>, causedBy: string[] = []): Promise<string | null> => {
      try {
        const result = await recordEvent.mutateAsync({ data: { workspaceId: workspace.id, kind, payload, causedBy } });
        void eventsQuery.refetch();
        return result.event.id;
      } catch (error) {
        notify('warn', `Receipt for ${kind} was NOT recorded: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    },
    [eventsQuery, notify, recordEvent, workspace.id],
  );

  // Restore the last saved scene once, before the operator has touched anything.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || !savedScene.data) return;
    restoredRef.current = true;
    const doc = savedScene.data.scene as unknown as Scene;
    if (doc && Array.isArray(doc.layers) && typeof doc.width === 'number') {
      setScene(doc);
      notify('info', `Restored scene v${savedScene.data.version} from the store.`);
    }
  }, [notify, savedScene.data]);

  // Autosave the scene, debounced; each save is a versioned document plus a
  // scene_saved event chained to the previous save.
  const sceneDirtyRef = useRef(false);
  useEffect(() => {
    if (!sceneDirtyRef.current) {
      sceneDirtyRef.current = true; // skip the initial render
      return;
    }
    const timer = window.setTimeout(() => {
      saveScene
        .mutateAsync({ workspaceId: workspace.id, data: { scene: scene as unknown as Record<string, unknown> } })
        .then(() => void eventsQuery.refetch())
        .catch((error: unknown) => notify('warn', `Scene was NOT saved: ${error instanceof Error ? error.message : String(error)}`));
    }, 1500);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, workspace.id]);

  // Go Live — one WHIP upstream to mediamtx. Settings persist per browser so
  // the operator does not retype the ingest host every session. The password
  // is kept in sessionStorage only: it leaves with the tab.
  const LIVE_KEY = 'ua-studio-live';
  const [live, setLive] = useState<{ base: string; path: string; user: string; pass: string }>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(LIVE_KEY) ?? '{}') as Partial<{ base: string; path: string; user: string }>;
      return {
        base: saved.base ?? '',
        path: saved.path ?? `marquee/${workspace.accountHandle || 'me'}`.replace(/^@/, ''),
        user: saved.user ?? 'marquee',
        pass: sessionStorage.getItem(`${LIVE_KEY}:pass`) ?? '',
      };
    } catch {
      return { base: '', path: 'marquee/me', user: 'marquee', pass: '' };
    }
  });
  const [whip, setWhip] = useState<WhipState>({ kind: 'idle' });
  const publisherRef = useRef<WhipPublisher | null>(null);
  const saveLive = (next: typeof live) => {
    setLive(next);
    localStorage.setItem(LIVE_KEY, JSON.stringify({ base: next.base, path: next.path, user: next.user }));
    sessionStorage.setItem(`${LIVE_KEY}:pass`, next.pass);
  };
  const whipEndpoint = live.base ? `${live.base.replace(/\/+$/, '')}:8889/${live.path.replace(/^\/+|\/+$/g, '')}/whip` : '';
  const viewer = live.base ? viewerUrls(live.base, live.path) : null;

  const goLive = useCallback(async () => {
    const comp = compositorRef.current;
    if (!comp) return;
    if (!live.base) {
      notify('error', 'Set the ingest host first (e.g. https://live.example.com — mediamtx on your VPS).');
      return;
    }
    const stream = comp.captureStream(30);
    const mixed = mixerRef.current?.output.getAudioTracks()[0];
    if (mixed) stream.addTrack(mixed);
    else notify('warn', 'Going live with video only — add a microphone or share with audio for sound.');
    const publisher = new WhipPublisher({
      endpoint: whipEndpoint,
      auth: live.pass ? { kind: 'basic', user: live.user, pass: live.pass } : { kind: 'none' },
      maxVideoBitrate: 4_500_000,
      onState: setWhip,
    });
    publisherRef.current = publisher;
    try {
      await publisher.start(stream);
      notify('info', `Live. Viewers: ${viewer?.hls}`);
      liveEventIdRef.current = await record('go_live', {
        host: live.base,
        path: live.path,
        endpoint: whipEndpoint,
        viewer: viewer?.hls ?? null,
        sources: Object.keys(streamsRef.current),
        audio: Boolean(mixed),
      });
    } catch (error) {
      publisherRef.current = null;
      notify('error', error instanceof Error ? error.message : String(error));
    }
  }, [live, notify, record, viewer, whipEndpoint]);

  const endLive = useCallback(async () => {
    const p = publisherRef.current;
    publisherRef.current = null;
    const since = p?.getState();
    await p?.stop();
    const cause = liveEventIdRef.current;
    liveEventIdRef.current = null;
    await record(
      'stream_ended',
      { reason: 'operator', durationMs: since?.kind === 'live' ? Date.now() - since.since : null },
      cause ? [cause] : [],
    );
  }, [record]);

  useEffect(() => {
    return () => {
      void publisherRef.current?.stop('section closed');
    };
  }, []);

  const shell = getShell();
  const shellPicker = Boolean(shell?.studio);

  // A stream that drops while live is an event too — chained to its go_live.
  useEffect(() => {
    if (whip.kind === 'error' && liveEventIdRef.current) {
      const cause = liveEventIdRef.current;
      liveEventIdRef.current = null;
      void record('stream_error', { message: whip.message }, [cause]);
    }
  }, [record, whip]);

  // Compositor lifetime = section lifetime.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const comp = new Compositor(canvas, scene);
    comp.selected = selected;
    comp.start();
    compositorRef.current = comp;
    const meter = window.setInterval(() => {
      setFps(comp.stats.fps);
      const m = mixerRef.current;
      if (m) {
        const next: Record<string, number> = {};
        for (const s of m.list()) next[s.id] = m.level(s.id);
        setLevels(next);
      }
    }, 250);
    return () => {
      window.clearInterval(meter);
      comp.stop();
      compositorRef.current = null;
      for (const s of Object.values(streamsRef.current)) stopStream(s);
      streamsRef.current = {};
      mixerRef.current?.close().catch((error: unknown) => console.error('[studio] mixer close failed', error));
      mixerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    compositorRef.current?.setScene(scene);
  }, [scene]);
  useEffect(() => {
    if (compositorRef.current) compositorRef.current.selected = selected;
  }, [selected]);

  const ensureMixer = useCallback(async () => {
    if (!mixerRef.current) mixerRef.current = new Mixer();
    await mixerRef.current.resume();
    return mixerRef.current;
  }, []);

  const attachStream = useCallback(
    (layerId: string, stream: MediaStream, label: string) => {
      const prev = streamsRef.current[layerId];
      if (prev) stopStream(prev);
      streamsRef.current[layerId] = stream;
      compositorRef.current?.setSource(layerId, videoFor(stream));
      setSources((s) => ({ ...s, [layerId]: label }));
      void record('source_added', { source: layerId, label, audio: stream.getAudioTracks().length > 0 });
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        compositorRef.current?.setSource(layerId, null);
        delete streamsRef.current[layerId];
        mixerRef.current?.remove(layerId);
        setSources((s) => {
          const n = { ...s };
          delete n[layerId];
          return n;
        });
        notify('info', `${label} stopped — the source ended.`);
        void record('source_removed', { source: layerId, label, reason: 'ended' });
      });
    },
    [notify, record],
  );

  /** Actually capture, after the shell (if any) has been armed. */
  const runScreenCapture = useCallback(
    async (label: string) => {
      try {
        const cap = await captureScreen(withSystemAudio);
        attachStream('screen', cap.stream, label);
        if (cap.hasAudio) {
          const m = await ensureMixer();
          m.add('screen', 'System / tab audio', cap.stream, 1);
          setGains((g) => ({ ...g, screen: 1 }));
        } else if (withSystemAudio) {
          notify(
            'warn',
            shellPicker
              ? 'Captured video only. System-audio loopback is Windows-only in Chromium; on this platform route game audio through the mic input or a virtual audio device.'
              : 'Captured video only. In a browser, audio comes only with a Chrome TAB share (not a window or screen). Pick a tab, or route audio through the mic input.',
          );
        }
      } catch (error) {
        const e = error as CaptureError;
        notify('error', e.message ?? String(error), e.raw);
      }
    },
    [attachStream, ensureMixer, notify, shellPicker, withSystemAudio],
  );

  const openPicker = useCallback(async () => {
    if (!shell?.studio) {
      // No shell: the browser's own picker is the only one there is.
      await runScreenCapture('Screen (browser picker)');
      return;
    }
    setPicker({ open: true, loading: true, sources: [], error: null });
    try {
      const list = await shell.studio.listCaptureSources();
      setPicker({ open: true, loading: false, sources: list, error: null });
    } catch (error) {
      setPicker({ open: true, loading: false, sources: [], error: error instanceof Error ? error.message : String(error) });
    }
  }, [runScreenCapture, shell]);

  const pickSource = useCallback(
    async (source: ShellCaptureSource) => {
      if (!shell?.studio) return;
      setPicker((p) => ({ ...p, open: false }));
      try {
        await shell.studio.selectCaptureSource({ sourceId: source.id, withAudio: withSystemAudio });
      } catch (error) {
        notify('error', `The shell refused the capture selection: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      await runScreenCapture(`${source.kind === 'screen' ? 'Screen' : 'Window'} · ${source.name}`);
    },
    [notify, runScreenCapture, shell, withSystemAudio],
  );

  const addCamera = useCallback(async () => {
    try {
      const cap = await captureCamera();
      attachStream('camera', cap.stream, cap.label);
    } catch (error) {
      const e = error as CaptureError;
      notify('error', e.message ?? String(error), e.raw);
    }
  }, [attachStream, notify]);

  const addMic = useCallback(async () => {
    try {
      const cap = await captureMic();
      const m = await ensureMixer();
      const prev = streamsRef.current.mic;
      if (prev) stopStream(prev);
      streamsRef.current.mic = cap.stream;
      m.add('mic', cap.label, cap.stream, 1);
      setGains((g) => ({ ...g, mic: 1 }));
      setSources((s) => ({ ...s, mic: cap.label }));
    } catch (error) {
      const e = error as CaptureError;
      notify('error', e.message ?? String(error), e.raw);
    }
  }, [ensureMixer, notify]);

  const removeSource = useCallback(
    (id: string) => {
      const s = streamsRef.current[id];
      if (s) stopStream(s);
      delete streamsRef.current[id];
      compositorRef.current?.setSource(id, null);
      mixerRef.current?.remove(id);
      setSources((prev) => {
        const n = { ...prev };
        delete n[id];
        return n;
      });
      void record('source_removed', { source: id, reason: 'operator' });
    },
    [record],
  );

  // ---- pointer interaction ----
  const normPoint = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return toNormalised(e.clientX - r.left, e.clientY - r.top, r.width, r.height);
  };
  const handleSize = (c: HTMLCanvasElement) => {
    const r = c.getBoundingClientRect();
    return { hw: 10 / r.width, hh: 10 / r.height };
  };
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = normPoint(e);
    const { hw, hh } = handleSize(e.currentTarget);
    const capture = () => {
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch (error) {
        console.warn('[studio] setPointerCapture failed (synthetic event?)', error);
      }
    };
    if (selected) {
      const l = scene.layers.find((x) => x.id === selected);
      if (l?.visible) {
        const h = hitHandle(l.rect, p.x, p.y, hw, hh);
        if (h) {
          dragRef.current = { mode: 'resize', id: l.id, handle: h, lastX: p.x, lastY: p.y };
          capture();
          return;
        }
      }
    }
    const hit = hitTest(scene, p.x, p.y);
    if (hit) {
      setSelected(hit.id);
      if (hit.kind !== 'screen') {
        dragRef.current = { mode: 'move', id: hit.id, lastX: p.x, lastY: p.y };
        capture();
      }
    } else {
      setSelected(null);
    }
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const p = normPoint(e);
    const dx = p.x - d.lastX;
    const dy = p.y - d.lastY;
    d.lastX = p.x;
    d.lastY = p.y;
    setScene((s) => {
      const l = s.layers.find((x) => x.id === d.id);
      if (!l) return s;
      const rect = d.mode === 'move' ? moveRect(l.rect, dx, dy) : resizeRect(l.rect, d.handle, dx, dy, l.kind === 'camera' || l.shape === 'circle');
      return updateLayer(s, d.id, { rect });
    });
  };
  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (dragRef.current) {
      const id = dragRef.current.id;
      setScene((s) => bringToFront(s, id));
    }
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };

  const selectedLayer = useMemo(() => scene.layers.find((l) => l.id === selected) ?? null, [scene, selected]);
  const setLayer = (patch: Partial<Layer>) => {
    if (!selected) return;
    setScene((s) => updateLayer(s, selected, patch));
  };
  const setGain = (id: string, v: number) => {
    setGains((g) => ({ ...g, [id]: v }));
    try {
      mixerRef.current?.setGain(id, v);
    } catch (error) {
      notify('error', (error as Error).message);
    }
  };

  const channels = mixerRef.current?.list() ?? [];

  return (
    <SectionShell
      title="Studio"
      description={
        shellPicker
          ? `Screen or game, your camera in the corner, a mixer — one canvas, which is the preview now and the broadcast next. Captured through the shell's own picker in the ${workspace.name} workspace.`
          : 'Screen or game, your camera in the corner, a mixer — one canvas. On the web surface the browser’s own share picker is used; inside the shell you get a proper source picker with thumbnails.'
      }
      actions={
        <>
          <Badge variant="outline" className="font-mono text-[10px]" data-testid="badge-studio-stats">
            {scene.width}×{scene.height} · {fps} fps
          </Badge>
          {whip.kind === 'live' ? (
            <Button size="sm" variant="destructive" onClick={() => void endLive()} data-testid="button-end-live">
              <Square className="mr-1.5 h-3.5 w-3.5" />
              End stream
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="border-destructive/60 text-destructive"
              disabled={whip.kind === 'connecting' || !sources.screen && !sources.camera}
              onClick={() => void goLive()}
              data-testid="button-go-live"
            >
              <Radio className={cn('mr-1.5 h-3.5 w-3.5', whip.kind === 'connecting' && 'animate-pulse')} />
              {whip.kind === 'connecting' ? 'Connecting…' : 'Go live'}
            </Button>
          )}
          <Button size="sm" onClick={openPicker} data-testid="button-share-screen">
            <MonitorUp className="mr-1.5 h-3.5 w-3.5" />
            {sources.screen ? 'Change screen' : 'Share screen / game'}
          </Button>
          <Button size="sm" variant="outline" onClick={addCamera} data-testid="button-add-camera">
            <Camera className="mr-1.5 h-3.5 w-3.5" />
            {sources.camera ? 'Change camera' : 'Camera'}
          </Button>
          <Button size="sm" variant="outline" onClick={addMic} data-testid="button-add-mic">
            <Mic className="mr-1.5 h-3.5 w-3.5" />
            {sources.mic ? 'Change mic' : 'Microphone'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        {/* Preview */}
        <Card className="overflow-hidden">
          <CardContent className="p-3">
            <div className="relative overflow-hidden rounded-md" style={{ boxShadow: `inset 0 2px 0 0 ${workspace.accent}` }}>
              <canvas
                ref={canvasRef}
                className="block aspect-video w-full touch-none bg-black"
                style={{ cursor: 'crosshair' }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                data-testid="studio-canvas"
              />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Drag the camera to move it. Grab a corner to resize (keeps 16:9). Click empty space to deselect.
            </p>
          </CardContent>
        </Card>

        {/* Right rail */}
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Sources</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {Object.keys(sources).length === 0 ? (
                <p className="rounded-md border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
                  Nothing captured yet. Share your screen and add your camera.
                </p>
              ) : (
                Object.entries(sources).map(([id, label]) => (
                  <div key={id} className="flex items-center gap-2 rounded-md border border-card-border bg-background/40 px-2.5 py-2 text-xs">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-chart-2" />
                    <span className="font-mono">{id}</span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">{label}</span>
                    <button type="button" aria-label={`Remove ${id}`} className="rounded p-0.5 hover-elevate" onClick={() => removeSource(id)}>
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))
              )}
              <div className="mt-1 flex items-center justify-between gap-2 text-xs">
                <Label htmlFor="sysaudio" className="text-muted-foreground">
                  Request system audio with screen
                </Label>
                <Switch id="sysaudio" checked={withSystemAudio} onCheckedChange={setWithSystemAudio} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Layers</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-1.5">
              {[...scene.layers].reverse().map((l) => (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => setSelected(l.id)}
                  className={cn(
                    'flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs',
                    l.id === selected ? 'border-border bg-sidebar-accent' : 'border-transparent hover-elevate',
                  )}
                  style={l.id === selected ? { boxShadow: `inset 2px 0 0 0 ${workspace.accent}` } : undefined}
                >
                  <input
                    type="checkbox"
                    checked={l.visible}
                    onChange={(e) => setScene((s) => updateLayer(s, l.id, { visible: e.target.checked }))}
                    onClick={(e) => e.stopPropagation()}
                    className="accent-[hsl(var(--primary))]"
                  />
                  <span>{l.name}</span>
                  <span className="ml-auto font-mono text-muted-foreground">{l.kind}</span>
                </button>
              ))}

              {selectedLayer && selectedLayer.kind !== 'screen' ? (
                <div className="mt-2 flex flex-col gap-2 border-t border-border/60 pt-3">
                  <div className="flex items-center gap-2">
                    <Label className="w-14 text-xs text-muted-foreground">Shape</Label>
                    <Select value={selectedLayer.shape} onValueChange={(v) => setLayer({ shape: v as Layer['shape'] })}>
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="rect">Rectangle</SelectItem>
                        <SelectItem value="rounded">Rounded</SelectItem>
                        <SelectItem value="circle">Circle</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <Label htmlFor="mirror" className="text-xs text-muted-foreground">
                      Mirror
                    </Label>
                    <Switch id="mirror" checked={selectedLayer.mirror} onCheckedChange={(v) => setLayer({ mirror: v })} />
                  </div>
                  <div className="flex gap-1.5">
                    {CORNERS.map((c) => (
                      <Button key={c.label} size="sm" variant="outline" className="flex-1 px-0" onClick={() => setLayer({ rect: c.rect })}>
                        {c.label}
                      </Button>
                    ))}
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Volume2 className="h-3.5 w-3.5" /> Audio
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {channels.length === 0 ? (
                <p className="text-xs text-muted-foreground">Add a microphone, or share with audio, to see channels.</p>
              ) : (
                channels.map((ch) => (
                  <div key={ch.id} className="flex flex-col gap-1.5">
                    <div className="flex justify-between text-xs">
                      <span>{ch.label}</span>
                      <span className="font-mono text-muted-foreground">{Math.round((levels[ch.id] ?? 0) * 100)}</span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full transition-[width] duration-100"
                        style={{
                          width: `${Math.min(100, (levels[ch.id] ?? 0) * 300)}%`,
                          background: 'linear-gradient(90deg, rgb(64 217 160), rgb(124 92 255) 60%, rgb(255 141 105))',
                        }}
                      />
                    </div>
                    <Slider min={0} max={2} step={0.01} value={[gains[ch.id] ?? 1]} onValueChange={([v]) => setGain(ch.id, v ?? 1)} />
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <Card className={cn(whip.kind === 'live' && 'border-destructive/50')}>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Radio className={cn('h-3.5 w-3.5', whip.kind === 'live' && 'text-destructive')} /> Go Live
                {whip.kind === 'live' ? (
                  <Badge variant="destructive" className="ml-auto font-mono text-[10px]">
                    LIVE · {whip.ice}
                  </Badge>
                ) : whip.kind === 'connecting' ? (
                  <Badge variant="outline" className="ml-auto font-mono text-[10px]">connecting</Badge>
                ) : null}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <p className="text-xs text-muted-foreground">
                One WHIP upstream to your own mediamtx (<code>deploy/mediamtx/mediamtx.yml</code>). It fans out to HLS/WebRTC viewers and, next, RTMP to Twitch/YouTube/Kick.
              </p>
              <Label className="text-xs text-muted-foreground">Ingest host</Label>
              <Input
                placeholder="https://live.example.com"
                value={live.base}
                disabled={whip.kind === 'live' || whip.kind === 'connecting'}
                onChange={(e) => saveLive({ ...live, base: e.target.value.trim() })}
                className="h-8 font-mono text-xs"
                data-testid="input-live-base"
              />
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-xs text-muted-foreground">Path</Label>
                  <Input value={live.path} disabled={whip.kind !== 'idle' && whip.kind !== 'ended' && whip.kind !== 'error'} onChange={(e) => saveLive({ ...live, path: e.target.value.trim() })} className="h-8 font-mono text-xs" />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Publisher user</Label>
                  <Input value={live.user} disabled={whip.kind === 'live'} onChange={(e) => saveLive({ ...live, user: e.target.value.trim() })} className="h-8 font-mono text-xs" />
                </div>
              </div>
              <Label className="text-xs text-muted-foreground">Publisher password (kept for this session only)</Label>
              <Input type="password" value={live.pass} disabled={whip.kind === 'live'} onChange={(e) => saveLive({ ...live, pass: e.target.value })} className="h-8 font-mono text-xs" data-testid="input-live-pass" />
              {whipEndpoint ? (
                <p className="break-all font-mono text-[10px] text-muted-foreground">POST {whipEndpoint}</p>
              ) : null}
              {whip.kind === 'connecting' ? <p className="font-mono text-[10px] text-muted-foreground">{whip.detail}</p> : null}
              {whip.kind === 'error' ? <p className="rounded-md border-l-2 border-destructive bg-background/40 px-2.5 py-1.5 text-xs">{whip.message}</p> : null}
              {whip.kind === 'ended' ? <p className="text-xs text-muted-foreground">Stream ended — {whip.reason}.</p> : null}
              {viewer ? (
                <div className="mt-1 flex flex-col gap-1 text-[10px]">
                  <span className="text-muted-foreground">Viewers</span>
                  <a href={viewer.hls} target="_blank" rel="noopener noreferrer" className="break-all font-mono text-primary underline-offset-2 hover:underline">
                    {viewer.hls}
                  </a>
                  <a href={viewer.webrtc} target="_blank" rel="noopener noreferrer" className="break-all font-mono text-primary underline-offset-2 hover:underline">
                    {viewer.webrtc}
                  </a>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <ReceiptsCard events={eventsQuery.data?.events ?? []} receipt={eventsQuery.data?.receipt ?? null} error={eventsQuery.error ? String(eventsQuery.error.message) : null} />

          {notices.length > 0 ? (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Notices</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-1.5">
                {notices.map((n) => (
                  <p
                    key={n.at}
                    title={n.raw}
                    className={cn(
                      'rounded-md border-l-2 bg-background/40 px-2.5 py-1.5 text-xs',
                      n.level === 'error' && 'border-destructive',
                      n.level === 'warn' && 'border-chart-3',
                      n.level === 'info' && 'border-chart-1',
                    )}
                  >
                    {n.text}
                  </p>
                ))}
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>

      {/* The shell's source picker — thumbnails of what the OS reports right now. */}
      <Dialog open={picker.open} onOpenChange={(open) => setPicker((p) => ({ ...p, open }))}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Clapperboard className="h-4 w-4" /> Choose what to share
            </DialogTitle>
            <DialogDescription>
              Screens and windows as the OS reports them right now. The shell hands the Studio exactly the one you pick, once.
              {withSystemAudio ? ' System audio is requested with it — Chromium honours that on Windows only.' : ''}
            </DialogDescription>
          </DialogHeader>
          {picker.loading ? (
            <div className="grid grid-cols-3 gap-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="ua-ghost aspect-video rounded-md border border-border" />
              ))}
            </div>
          ) : picker.error ? (
            <p className="rounded-md border border-destructive/50 p-3 font-mono text-xs text-destructive">{picker.error}</p>
          ) : picker.sources.length === 0 ? (
            <p className="text-sm text-muted-foreground">The OS reported no capturable screens or windows. On macOS, grant Screen Recording permission to the app and try again.</p>
          ) : (
            <div className="grid max-h-[60vh] grid-cols-3 gap-3 overflow-y-auto pr-1">
              {[...picker.sources]
                .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'screen' ? -1 : 1))
                .map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => void pickSource(s)}
                    className="group flex flex-col gap-1.5 rounded-md border border-card-border bg-card p-2 text-left hover-elevate"
                    data-testid={`capture-source-${s.id}`}
                  >
                    <div className="relative aspect-video w-full overflow-hidden rounded bg-black">
                      {s.thumbnail ? (
                        <img src={s.thumbnail} alt="" className="h-full w-full object-contain" />
                      ) : (
                        <div className="flex h-full items-center justify-center text-muted-foreground">
                          {s.kind === 'screen' ? <Monitor className="h-6 w-6" /> : <AppWindow className="h-6 w-6" />}
                        </div>
                      )}
                      <span className="absolute left-1.5 top-1.5 rounded bg-background/80 px-1.5 py-0.5 text-[10px] uppercase tracking-wide">{s.kind}</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-xs">
                      {s.appIcon ? <img src={s.appIcon} alt="" className="h-3.5 w-3.5" /> : null}
                      <span className="truncate">{s.name}</span>
                    </div>
                  </button>
                ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </SectionShell>
  );
}

const KIND_LABEL: Record<StudioEventKind, string> = {
  go_live: 'went live',
  stream_ended: 'stream ended',
  stream_error: 'stream error',
  scene_saved: 'scene saved',
  source_added: 'source added',
  source_removed: 'source removed',
};

/**
 * The receipts. Every row is an append-only document in the local NEDB store,
 * chained to what caused it; the head is the store's Merkle root after the
 * last write and `verified` is the whole chain checking out. This is the
 * part a hosted overlay service cannot offer: proof, not a log.
 */
function ReceiptsCard({
  events,
  receipt,
  error,
}: {
  events: StudioEvent[];
  receipt: { head: string; seq: number; verified: boolean } | null;
  error: string | null;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Receipt className="h-3.5 w-3.5" /> Receipts
          {receipt ? (
            <Badge variant="outline" className="ml-auto gap-1 font-mono text-[10px]" title={receipt.head} data-testid="badge-receipt-head">
              {receipt.verified ? <ShieldCheck className="h-3 w-3 text-chart-2" /> : <ShieldAlert className="h-3 w-3 text-destructive" />}
              seq {receipt.seq} · {receipt.head.slice(0, 10)}
            </Badge>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-1.5">
        {error ? (
          <p className="font-mono text-[11px] text-destructive">Receipts unavailable: {error}</p>
        ) : events.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing recorded yet. Adding a source, saving the scene, or going live writes a receipt.</p>
        ) : (
          events.map((e) => (
            <div key={e.id} className="flex items-center gap-2 rounded-md border border-card-border bg-background/40 px-2.5 py-1.5 text-xs" data-testid={`receipt-${e.id}`}>
              <span
                className={cn(
                  'h-1.5 w-1.5 shrink-0 rounded-full',
                  e.kind === 'go_live' && 'bg-destructive',
                  e.kind === 'stream_ended' && 'bg-muted-foreground',
                  e.kind === 'stream_error' && 'bg-chart-3',
                  e.kind === 'scene_saved' && 'bg-chart-1',
                  (e.kind === 'source_added' || e.kind === 'source_removed') && 'bg-chart-2',
                )}
              />
              <span>{KIND_LABEL[e.kind] ?? e.kind}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">
                {typeof e.payload.label === 'string' ? e.payload.label : typeof e.payload.path === 'string' ? e.payload.path : typeof e.payload.version === 'number' ? `v${e.payload.version}` : ''}
              </span>
              <span className="font-mono text-[10px] text-muted-foreground" title={`${e.causedBy.length} cause(s) · ${e.at}`}>
                #{e.seq}
                {e.causedBy.length > 0 ? ` ← ${e.causedBy.length}` : ''}
              </span>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
