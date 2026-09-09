import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppWindow, Camera, Circle, Clapperboard, Crosshair, FileVideo, FolderOpen, Mic, Monitor, MonitorUp, Radio, Receipt, ShieldCheck, ShieldAlert, Square, Volume2, X } from 'lucide-react';
import {
  getGetStudioSceneQueryKey,
  getListStudioEventsQueryKey,
  useGetStudioScene,
  useListStudioEvents,
  useRecordStudioEvent,
  useSaveStudioScene,
  type StudioEvent,
  type StudioEventKind,
} from '@marquee/api-client-react';

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
import { PermissionDialog, usePermissions } from '@/components/app/permission-gate';
import { Mixer } from '@/lib/studio/audio.ts';
import { captureCamera, captureMic, captureScreen, stopStream, videoFor, type CaptureError } from '@/lib/studio/capture.ts';
import { Compositor } from '@/lib/studio/compositor.ts';
import {
  countZooms,
  fetchZoomPlan,
  finaliseToMp4,
  formatBytes,
  formatElapsed,
  pickRecordingFormat,
  RecordingSession,
  renderZoomedEdit,
  type FinaliseResult,
  type RecorderState,
  type RecordingFormat,
  type ZoomPlanResult,
  type ZoomRenderResult,
} from '@/lib/studio/recorder.ts';
import { viewerUrls, WhipPublisher, type WhipState } from '@/lib/studio/whip.ts';
import { Input } from '@/components/ui/input';
import {
  box16x9,
  bringToFront,
  canvasForSource,
  defaultScene,
  hitHandle,
  hitTest,
  moveRect,
  resizeRect,
  resizeScene,
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

/**
 * Corner presets for the camera, computed for the CURRENT canvas.
 *
 * These cannot be a module constant any more: the canvas now takes the shape
 * of whatever display is being captured, and a normalised box only stays 16:9
 * if its height is derived from the canvas aspect. Hardcoding the 1080p ratio
 * would squash the camera on any display that is not 16:9.
 */
function cornersFor(width: number, height: number): Array<{ label: string; rect: Layer['rect'] }> {
  const box = box16x9(0.24, width, height);
  const bottom = 1 - box.h - 0.035;
  return [
    { label: '↘', rect: { x: 0.735, y: bottom, ...box } },
    { label: '↙', rect: { x: 0.025, y: bottom, ...box } },
    { label: '↗', rect: { x: 0.735, y: 0.04, ...box } },
    { label: '↖', rect: { x: 0.025, y: 0.04, ...box } },
  ];
}

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
  /**
   * The DISPLAY behind the screen layer, as Electron reports it.
   *
   * The shell needs this to know which display to sample the cursor against.
   * It has to be the source's `displayId`, not its `id`: the number inside
   * `screen:400:0` is Chromium's media device id, and on a real machine whose
   * only display was id 60 it resolved to nothing. A window capture has no
   * display at all, and such a take honestly gets no cursor track.
   */
  const screenDisplayIdRef = useRef<string | null>(null);

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

  /**
   * The stream that leaves the Studio — the composited canvas plus the mixed
   * audio. Shared by recording and by going live so the two can never diverge
   * about what the viewer or the file actually gets.
   */
  const outgoingStream = useCallback((): { stream: MediaStream; hasAudio: boolean } | null => {
    const comp = compositorRef.current;
    if (!comp) return null;
    const stream = comp.captureStream(30);
    const mixed = mixerRef.current?.output.getAudioTracks()[0];
    if (mixed) stream.addTrack(mixed);
    return { stream, hasAudio: Boolean(mixed) };
  }, []);

  // Go Live — one WHIP upstream to mediamtx. Settings persist per browser so
  // the operator does not retype the ingest host every session. The password
  // is kept in sessionStorage only: it leaves with the tab.
  const LIVE_KEY = 'marquee-studio-live';
  const [live, setLive] = useState<{ base: string; path: string; user: string; pass: string }>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(LIVE_KEY) ?? '{}') as Partial<{ base: string; path: string; user: string }>;
      return {
        base: saved.base ?? 'https://live.ne-db.com',
        path: saved.path ?? `marquee/${workspace.accountHandle || 'me'}`.replace(/^@/, ''),
        user: saved.user ?? 'marquee',
        pass: sessionStorage.getItem(`${LIVE_KEY}:pass`) ?? '',
      };
    } catch {
      return { base: 'https://live.ne-db.com', path: 'marquee/me', user: 'marquee', pass: '' };
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
    if (!live.base) {
      notify('error', 'Set the ingest host first (e.g. https://live.example.com — mediamtx on your VPS).');
      return;
    }
    const out = outgoingStream();
    if (!out) return;
    const stream = out.stream;
    if (!out.hasAudio) notify('warn', 'Going live with video only — add a microphone or share with audio for sound.');
    const publisher = new WhipPublisher({
      endpoint: whipEndpoint,
      auth: live.pass ? { kind: 'basic', user: live.user, pass: live.pass } : { kind: 'none' },
      maxVideoBitrate: 4_500_000,
      // The canvas is the display's native size now, which can be well past
      // what a viewer wants. The sender scales for the wire; the recording
      // keeps every pixel.
      maxWireWidth: 1920,
      maxWireHeight: 1080,
      onState: setWhip,
    });
    publisherRef.current = publisher;
    try {
      await publisher.start(stream);
      notify('info', `Live. Viewers: ${viewer?.hls}`);
      if (publisher.wireScale > 1) {
        notify(
          'info',
          `Streaming at ${Math.round(scene.width / publisher.wireScale)}x${Math.round(scene.height / publisher.wireScale)} while recording stays ${scene.width}x${scene.height} — the sender scales for the wire, the file keeps its pixels.`,
        );
      }
      liveEventIdRef.current = await record('go_live', {
        host: live.base,
        path: live.path,
        canvas: `${scene.width}x${scene.height}`,
        wireScale: publisher.wireScale,
        endpoint: whipEndpoint,
        viewer: viewer?.hls ?? null,
        sources: Object.keys(streamsRef.current),
        audio: out.hasAudio,
      });
    } catch (error) {
      publisherRef.current = null;
      notify('error', error instanceof Error ? error.message : String(error));
    }
  }, [live, notify, outgoingStream, record, scene.height, scene.width, viewer, whipEndpoint]);

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

  // OS permissions. Not a wall on load — raised only when the OS actually
  // gets in the way, because that is the moment it explains something.
  const perms = usePermissions();
  const [permDialog, setPermDialog] = useState<{ open: boolean; reason: string | null }>({ open: false, reason: null });
  const raisePermissions = useCallback(
    (reason: string) => {
      if (!perms.supported) return false;
      if (perms.blocking.length === 0) return false;
      setPermDialog({ open: true, reason });
      return true;
    },
    [perms],
  );

  // A stream that drops while live is an event too — chained to its go_live.
  useEffect(() => {
    if (whip.kind === 'error' && liveEventIdRef.current) {
      const cause = liveEventIdRef.current;
      liveEventIdRef.current = null;
      void record('stream_error', { message: whip.message }, [cause]);
    }
  }, [record, whip]);

  // ---- Recording: the primary act ----------------------------------------
  //
  // Going live is an option; recording is what the app is for. A take is
  // written straight to disk by the shell, one chunk per second, and finalised
  // to a real MP4 by the bundled Python. The reason it is a two-step is
  // measured, not stylistic: Chromium's MediaRecorder will give you H.264 or
  // an MP4 container, never both (see lib/studio/recorder.ts).
  const recording = shell?.studio?.recording ?? null;
  /** What this machine can actually record. Probed once — it cannot change. */
  const recFormat = useMemo<RecordingFormat | null>(() => {
    if (typeof MediaRecorder === 'undefined') return null;
    return pickRecordingFormat((type) => MediaRecorder.isTypeSupported(type));
  }, []);
  const [recState, setRecState] = useState<RecorderState>({ kind: 'idle' });
  const [take, setTake] = useState<{
    path: string;
    bytes: number;
    durationMs: number;
    mp4: FinaliseResult | null;
    /** The cursor track beside it, when there was one. Null means no zoom pass. */
    cursorTrack: string | null;
    zoom: ZoomRenderResult | null;
  } | null>(null);
  const [zoomPlan, setZoomPlan] = useState<ZoomPlanResult | null>(null);
  const [zooming, setZooming] = useState(false);
  const [finalising, setFinalising] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const sessionRef = useRef<RecordingSession | null>(null);
  const recEventIdRef = useRef<string | null>(null);
  const isRecording = recState.kind === 'recording' || recState.kind === 'paused';

  // The clock the operator watches. Driven off the state's own start time, so
  // a re-render cannot make it jump.
  useEffect(() => {
    if (!isRecording) return;
    const since = recState.kind === 'recording' || recState.kind === 'paused' ? recState.since : Date.now();
    const tick = () => setElapsed(Date.now() - since);
    tick();
    const timer = window.setInterval(tick, 500);
    return () => window.clearInterval(timer);
  }, [isRecording, recState]);

  const startRecording = useCallback(async () => {
    if (!recording) {
      notify('error', 'Recording needs the desktop shell — the web surface cannot write to your disk.');
      return;
    }
    if (!recFormat) {
      notify('error', 'This build has no MediaRecorder format it can use, so it cannot record. Please report this.');
      return;
    }
    if (!sources.screen && !sources.camera) {
      notify('error', 'Add a screen, window, or camera first — there is nothing to record yet.');
      return;
    }
    if (raisePermissions('recording')) return;

    const out = outgoingStream();
    if (!out) return;
    if (!out.hasAudio) notify('warn', 'Recording video only — add a microphone, or share with audio, for sound.');
    if (!recFormat.canStreamCopyToMp4) notify('warn', recFormat.note);

    const session = new RecordingSession({
      stream: out.stream,
      recording,
      format: recFormat,
      label: workspace.name,
      timesliceMs: 1000,
      displayId: screenDisplayIdRef.current ?? undefined,
      onState: setRecState,
    });
    sessionRef.current = session;
    setTake(null);
    try {
      const begun = await session.start();
      notify('info', `Recording to ${begun.path}`);
      // Say when there is NO cursor track, and why. A missing track is the
      // difference between a take that can be auto-zoomed later and one that
      // never can, so it is not something to discover months from now.
      if (!begun.cursorTrackPath) {
        notify(
          'warn',
          screenDisplayIdRef.current
            ? 'No cursor track for this take — the shell could not resolve the captured display, so there is no coordinate space to record the cursor in.'
            : 'No cursor track for this take — a window capture has no display to track against, and the browser picker does not report which display was shared. Share a whole screen from the picker inside the app to get one.',
        );
      }
      recEventIdRef.current = await record('recording_started', {
        path: begun.path,
        cursorTrackPath: begun.cursorTrackPath ?? null,
        displayId: screenDisplayIdRef.current,
        mimeType: recFormat.mimeType,
        videoCodec: recFormat.videoCodec,
        canStreamCopyToMp4: recFormat.canStreamCopyToMp4,
        audio: out.hasAudio,
        sources: Object.keys(streamsRef.current),
        width: scene.width,
        height: scene.height,
      });
    } catch (error) {
      sessionRef.current = null;
      const message = error instanceof Error ? error.message : String(error);
      notify('error', message);
      // A take that never started is still worth a receipt: it is the record
      // of a machine that could not record, which is exactly what you want
      // when someone reports "it did nothing".
      await record('recording_error', { phase: 'start', message, mimeType: recFormat.mimeType });
    }
  }, [notify, outgoingStream, raisePermissions, recFormat, record, recording, scene.height, scene.width, sources.camera, sources.screen, workspace.name]);

  /**
   * Finalise a take to MP4 through the bundled Python. Separate from stopping
   * so a finalise that fails never looks like a recording that failed — the
   * Matroska on disk is already a complete, playable recording.
   */
  const finalise = useCallback(
    async (source: string, cause: string | null) => {
      setFinalising(true);
      try {
        const result = await finaliseToMp4(source);
        setTake((t) => (t ? { ...t, mp4: result } : t));
        notify(
          'info',
          `MP4 ready: ${result.output} (${result.videoCodec}/${result.audioCodec}, ${result.videoWasCopied ? 'video copied' : 'video re-encoded'}, ${result.tookSeconds}s)`,
        );
        await record(
          'recording_finalised',
          {
            source: result.source,
            output: result.output,
            outputBytes: result.outputBytes,
            durationSeconds: result.durationSeconds,
            videoCodec: result.videoCodec,
            audioCodec: result.audioCodec,
            videoWasCopied: result.videoWasCopied,
            tookSeconds: result.tookSeconds,
            notes: result.notes,
          },
          cause ? [cause] : [],
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Say plainly what survived. The recording is not lost; only the MP4
        // conversion failed, and conflating the two would send the operator
        // looking for a file that is right there.
        notify('error', `${message} The recording itself is intact at ${source}.`);
        await record('recording_error', { phase: 'finalise', source, message }, cause ? [cause] : []);
      } finally {
        setFinalising(false);
      }
    },
    [notify, record],
  );

  /**
   * Render the zoomed edit. Separate from finalising, and slower by orders of
   * magnitude: the MP4 pass copies the video stream, this one re-encodes every
   * frame. The operator is told the cost before it starts rather than left
   * watching a spinner.
   */
  const renderZoom = useCallback(
    async (source: string, cursorTrack: string, cause: string | null) => {
      setZooming(true);
      const startedAt = Date.now();
      try {
        const result = await renderZoomedEdit(source, cursorTrack, {
          // The DELIVERY size. Cropping 1920x1080 out of a native capture is a
          // zoom at full sharpness; encoding the source size back out would
          // cost far more for pixels no viewer asked for.
          outWidth: 1920,
          outHeight: 1080,
        });
        setTake((t) => (t ? { ...t, zoom: result } : t));
        notify(
          'info',
          `Zoomed edit ready: ${result.output} (${result.frames} frames, ${result.keyframes} keyframes, ${result.tookSeconds}s)`,
        );
        await record(
          'recording_zoomed',
          {
            source: result.source,
            output: result.output,
            cursorTrack: result.cursorTrack,
            outputBytes: result.outputBytes,
            width: result.width,
            height: result.height,
            frames: result.frames,
            keyframes: result.keyframes,
            durationSeconds: result.durationSeconds,
            tookSeconds: result.tookSeconds,
            notes: result.notes,
          },
          cause ? [cause] : [],
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Be precise about what survived. The take and its MP4 are untouched;
        // only the extra pass failed, and conflating them would send someone
        // looking for a recording that is sitting right there.
        notify('error', `${message} The recording and its MP4 are untouched at ${source}.`);
        await record(
          'recording_error',
          { phase: 'zoom', source, cursorTrack, message, afterSeconds: Math.round((Date.now() - startedAt) / 1000) },
          cause ? [cause] : [],
        );
      } finally {
        setZooming(false);
      }
    },
    [notify, record],
  );

  const stopRecording = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;
    sessionRef.current = null;
    const cause = recEventIdRef.current;
    recEventIdRef.current = null;
    try {
      const closed = await session.stop();
      setTake({
        path: closed.path,
        bytes: closed.bytes,
        durationMs: closed.durationMs,
        mp4: null,
        cursorTrack: closed.cursor?.path ?? null,
        zoom: null,
      });
      setZoomPlan(null);
      // Fetch the PLAN immediately — it is instant and says how many zooms the
      // cursor actually justifies, so nobody commits minutes to an encode
      // before knowing whether there is anything to see.
      if (closed.cursor?.path) {
        void fetchZoomPlan(closed.path, closed.cursor.path)
          .then(setZoomPlan)
          .catch((error: unknown) =>
            notify('warn', `The zoom plan could not be read: ${error instanceof Error ? error.message : String(error)}`),
          );
      }
      notify('info', `Recording saved: ${closed.path} (${formatBytes(closed.bytes)})`);
      const stopped = await record(
        'recording_stopped',
        {
          path: closed.path,
          bytes: closed.bytes,
          durationMs: closed.durationMs,
          chunks: closed.chunks,
          clean: closed.clean,
          cursor: closed.cursor ?? null,
        },
        cause ? [cause] : [],
      );
      // Only H.264 can become an MP4 by copying. Anything else would mean a
      // slow, lossy re-encode, so it stays a WebM and the panel says why.
      if (recFormat?.canStreamCopyToMp4) await finalise(closed.path, stopped ?? cause);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notify('error', message);
      await record('recording_error', { phase: 'stop', message }, cause ? [cause] : []);
    }
  }, [finalise, notify, recFormat, record]);

  // Leaving the section must not leave a file half-written. Abort keeps it.
  useEffect(() => {
    return () => {
      const session = sessionRef.current;
      sessionRef.current = null;
      if (session) {
        void session.stop().catch((error: unknown) => {
          console.error('[studio] a recording was still open when the section closed; the partial file was kept', error);
        });
      }
    };
  }, []);

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

  /**
   * Release the capture devices when the page goes away, not only when React
   * unmounts.
   *
   * On app quit the renderer is torn down without React ever unmounting the
   * Studio, so the effect cleanup above never runs and the OS capture device
   * keeps producing frames nobody drains. On macOS that shows up as a flood of
   *
   *   pixel_buffer_pool.mm] Cannot exceed the pool's maximum buffer count
   *   sample_buffer_transformer.cc] Failed to create a destination buffer
   *
   * at camera frame cadence, all the way through shutdown. Cosmetic — the app
   * exits and no recording is lost, because the shell flushes and closes any
   * open take before this point — but it buries the real shutdown log.
   *
   * `pagehide` rather than `beforeunload`: it fires for the page being
   * discarded as well as navigated away from, and it must not be cancellable
   * or a stuck handler could block the quit. Best effort by nature — a hard
   * renderer kill runs nothing, and the OS reclaims the device anyway.
   */
  useEffect(() => {
    const release = () => {
      for (const stream of Object.values(streamsRef.current)) stopStream(stream);
      streamsRef.current = {};
      mixerRef.current?.close().catch((error: unknown) => {
        // Say why, even on the way out: a mixer that will not close is worth
        // seeing, and swallowing it here is indistinguishable from success.
        console.error('[studio] the mixer could not be closed while releasing devices', error);
      });
      mixerRef.current = null;
    };
    window.addEventListener('pagehide', release);
    return () => window.removeEventListener('pagehide', release);
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

      // The SCREEN decides the canvas. Recording a 5K display onto a 1080p
      // canvas throws away three quarters of its pixels before the encoder
      // ever sees them, and those are exactly the pixels a zoom would need.
      // The camera does not get this vote: it is a corner box, not the frame.
      let captured: { width: number; height: number } | null = null;
      if (layerId === 'screen') {
        const settings = stream.getVideoTracks()[0]?.getSettings?.() ?? {};
        if (settings.width && settings.height) {
          captured = canvasForSource(settings.width, settings.height);
          setScene((current) => resizeScene(current, captured!.width, captured!.height));
          if (captured.width !== settings.width || captured.height !== settings.height) {
            notify(
              'info',
              `Recording at ${captured.width}x${captured.height} — scaled from this display's ${settings.width}x${settings.height} to stay inside the 4K compositing budget.`,
            );
          }
        }
      }

      void record('source_added', {
        source: layerId,
        label,
        audio: stream.getAudioTracks().length > 0,
        sourceWidth: stream.getVideoTracks()[0]?.getSettings?.().width ?? null,
        sourceHeight: stream.getVideoTracks()[0]?.getSettings?.().height ?? null,
        canvas: captured ? `${captured.width}x${captured.height}` : null,
      });
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
      // No shell: the browser's own picker is the only one there is, and it
      // does not tell us WHICH display was shared — so no cursor track.
      screenDisplayIdRef.current = null;
      await runScreenCapture('Screen (browser picker)');
      return;
    }
    setPicker({ open: true, loading: true, sources: [], error: null });
    try {
      const list = await shell.studio.listCaptureSources();
      // An empty list on macOS is almost always Screen Recording being off —
      // the OS reports no sources rather than refusing. Say which, instead of
      // leaving the operator staring at an empty grid.
      if (list.length === 0) {
        await perms.refresh();
        const screen = perms.states?.find((s) => s.kind === 'screen');
        if (screen && screen.status !== 'granted' && screen.status !== 'not-applicable') {
          setPicker({ open: false, loading: false, sources: [], error: null });
          setPermDialog({ open: true, reason: 'The system reported no capturable screens, which is what it does when Screen Recording is switched off for marquee.' });
          return;
        }
      }
      setPicker({ open: true, loading: false, sources: list, error: null });
    } catch (error) {
      setPicker({ open: true, loading: false, sources: [], error: error instanceof Error ? error.message : String(error) });
    }
  }, [perms, runScreenCapture, shell]);

  const pickSource = useCallback(
    async (source: ShellCaptureSource) => {
      if (!shell?.studio) return;
      setPicker((p) => ({ ...p, open: false }));
      screenDisplayIdRef.current = source.displayId ?? null;
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
      // A `denied` from the browser inside the shell is usually the OS, not us.
      if (e.code === 'denied' && raisePermissions('The camera was refused. That refusal comes from the operating system, not from marquee.')) return;
      notify('error', e.message ?? String(error), e.raw);
    }
  }, [attachStream, notify, raisePermissions]);

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
      if (e.code === 'denied' && raisePermissions('The microphone was refused. That refusal comes from the operating system, not from marquee.')) return;
      notify('error', e.message ?? String(error), e.raw);
    }
  }, [ensureMixer, notify, raisePermissions]);

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
  const corners = useMemo(() => cornersFor(scene.width, scene.height), [scene.width, scene.height]);

  return (
    <SectionShell
      title="Studio"
      description={
        shellPicker
          ? `Screen or game, your camera in the corner, a mixer — one canvas. Record it to MP4, or go live. Captured through the shell's own picker in the ${workspace.name} workspace.`
          : 'Screen or game, your camera in the corner, a mixer — one canvas. Recording writes to disk, so it needs the desktop shell; on the web surface you get the preview, the browser’s own share picker, and Go Live.'
      }
      actions={
        <>
          <Badge variant="outline" className="font-mono text-[10px]" data-testid="badge-studio-stats">
            {scene.width}×{scene.height} · {fps} fps
          </Badge>
          {/* Record is the primary action: this is a recorder that can also
              broadcast, not a broadcaster that can also record. */}
          {isRecording ? (
            <Button size="sm" variant="destructive" onClick={() => void stopRecording()} data-testid="button-stop-recording">
              <Square className="mr-1.5 h-3.5 w-3.5" />
              Stop · {formatElapsed(elapsed)}
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={!recording || !recFormat || finalising || (!sources.screen && !sources.camera)}
              onClick={() => void startRecording()}
              data-testid="button-record"
              title={
                !recording
                  ? 'Recording needs the desktop shell.'
                  : !recFormat
                    ? 'No recordable format on this machine.'
                    : !sources.screen && !sources.camera
                      ? 'Add a screen, window, or camera first.'
                      : `Records ${recFormat.videoCodec.toUpperCase()} to your Videos folder.`
              }
            >
              <Circle className="mr-1.5 h-3.5 w-3.5 fill-current" />
              {finalising ? 'Finalising…' : 'Record'}
            </Button>
          )}
          {whip.kind === 'live' ? (
            <Button size="sm" variant="outline" className="border-destructive/60 text-destructive" onClick={() => void endLive()} data-testid="button-end-live">
              <Square className="mr-1.5 h-3.5 w-3.5" />
              End stream
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={whip.kind === 'connecting' || (!sources.screen && !sources.camera)}
              onClick={() => void goLive()}
              data-testid="button-go-live"
            >
              <Radio className={cn('mr-1.5 h-3.5 w-3.5', whip.kind === 'connecting' && 'animate-pulse')} />
              {whip.kind === 'connecting' ? 'Connecting…' : 'Go live'}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={openPicker} data-testid="button-share-screen">
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
                    {corners.map((c) => (
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

          <Card className={cn(isRecording && 'border-destructive/60')} data-testid="card-recording">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Circle className={cn('h-3.5 w-3.5', isRecording && 'animate-pulse fill-destructive text-destructive')} /> Recording
                {isRecording ? (
                  <Badge variant="destructive" className="ml-auto font-mono text-[10px]" data-testid="badge-recording">
                    REC · {formatElapsed(elapsed)}
                  </Badge>
                ) : recFormat ? (
                  <Badge variant="outline" className="ml-auto font-mono text-[10px]" data-testid="badge-rec-format">
                    {recFormat.videoCodec}
                  </Badge>
                ) : null}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {!recording ? (
                <p className="text-xs text-muted-foreground">
                  Recording writes to your disk, so it needs the desktop shell. On the web surface only the preview and Go Live are available.
                </p>
              ) : !recFormat ? (
                <p className="rounded-md border-l-2 border-destructive bg-background/40 px-2.5 py-1.5 text-xs">
                  This build has no MediaRecorder format it can use. Recording is unavailable — please report this.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">{recFormat.note}</p>
              )}

              {isRecording ? (
                <>
                  <div className="flex items-baseline justify-between font-mono text-xs">
                    <span className="text-2xl tabular-nums">{formatElapsed(elapsed)}</span>
                    <span className="text-muted-foreground" data-testid="text-recording-size">
                      {formatBytes(recState.kind === 'recording' || recState.kind === 'paused' ? recState.bytes : 0)}
                    </span>
                  </div>
                  <p className="break-all font-mono text-[10px] text-muted-foreground">
                    {recState.kind === 'recording' || recState.kind === 'paused' ? recState.path : ''}
                  </p>
                  <div className="flex gap-2">
                    {recState.kind === 'paused' ? (
                      <Button size="sm" variant="outline" className="flex-1" onClick={() => sessionRef.current?.resume()} data-testid="button-resume-recording">
                        Resume
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" className="flex-1" onClick={() => sessionRef.current?.pause()} data-testid="button-pause-recording">
                        Pause
                      </Button>
                    )}
                    <Button size="sm" variant="destructive" className="flex-1" onClick={() => void stopRecording()}>
                      <Square className="mr-1.5 h-3 w-3" /> Stop
                    </Button>
                  </div>
                </>
              ) : null}

              {recState.kind === 'error' ? (
                <p className="rounded-md border-l-2 border-destructive bg-background/40 px-2.5 py-1.5 text-xs" data-testid="text-recording-error">
                  {recState.message}
                </p>
              ) : null}

              {take && !isRecording ? (
                <div className="mt-1 flex flex-col gap-1.5 rounded-md border border-border/60 bg-background/40 p-2">
                  <div className="flex items-center gap-1.5 text-xs">
                    <FileVideo className="h-3.5 w-3.5 text-chart-1" />
                    <span className="font-medium">Last take</span>
                    <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                      {formatElapsed(take.durationMs)} · {formatBytes(take.bytes)}
                    </span>
                  </div>
                  {/* The MP4 is a second artifact, so both paths are shown: a
                      finalise that fails must never look like a lost take. */}
                  <p className="break-all font-mono text-[10px] text-muted-foreground" data-testid="text-take-path">{take.path}</p>
                  {take.mp4 ? (
                    <>
                      <p className="break-all font-mono text-[10px] text-chart-1" data-testid="text-take-mp4">{take.mp4.output}</p>
                      <p className="font-mono text-[10px] text-muted-foreground">
                        {take.mp4.videoCodec}/{take.mp4.audioCodec} · {take.mp4.videoWasCopied ? 'video copied' : 're-encoded'} · {take.mp4.tookSeconds}s
                      </p>
                    </>
                  ) : finalising ? (
                    <p className="font-mono text-[10px] text-muted-foreground">Finalising to MP4…</p>
                  ) : (
                    <Button size="sm" variant="outline" className="h-7" onClick={() => void finalise(take.path, null)} data-testid="button-finalise">
                      Finalise to MP4
                    </Button>
                  )}
                  {/* The zoom pass. Offered only when a cursor track exists,
                      and it says the cost out loud: this one re-encodes. */}
                  {take.cursorTrack ? (
                    take.zoom ? (
                      <>
                        <p className="break-all font-mono text-[10px] text-chart-4" data-testid="text-take-zoom">
                          {take.zoom.output}
                        </p>
                        <p className="font-mono text-[10px] text-muted-foreground">
                          {take.zoom.width}×{take.zoom.height} · {take.zoom.keyframes} keyframes · {take.zoom.frames} frames · {take.zoom.tookSeconds}s
                        </p>
                      </>
                    ) : zooming ? (
                      <p className="font-mono text-[10px] text-muted-foreground" data-testid="text-zooming">
                        Rendering the zoomed edit… this re-encodes every frame, so it takes longer than the take did.
                      </p>
                    ) : zoomPlan && countZooms(zoomPlan.keyframes) === 0 ? (
                      <p className="text-[10px] text-muted-foreground" data-testid="text-no-zooms">
                        {zoomPlan.notes[0] ?? 'The cursor never settled long enough to justify a zoom.'}
                      </p>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7"
                        onClick={() => void renderZoom(take.path, take.cursorTrack!, null)}
                        data-testid="button-zoom"
                      >
                        <Crosshair className="mr-1.5 h-3 w-3" />
                        {zoomPlan
                          ? `Zoomed edit · ${countZooms(zoomPlan.keyframes)} zoom${countZooms(zoomPlan.keyframes) === 1 ? '' : 's'}`
                          : 'Zoomed edit'}
                      </Button>
                    )
                  ) : (
                    <p className="text-[10px] text-muted-foreground">
                      No cursor track, so no zoomed edit for this take.
                    </p>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 justify-start px-1.5 text-[11px]"
                    onClick={() => void recording?.revealInFolder(take.zoom?.output ?? take.mp4?.output ?? take.path)}
                    data-testid="button-reveal"
                  >
                    <FolderOpen className="mr-1.5 h-3 w-3" /> Show in folder
                  </Button>
                </div>
              ) : null}
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

      <PermissionDialog
        open={permDialog.open}
        onOpenChange={(open) => setPermDialog((p) => ({ ...p, open }))}
        states={perms.blocking.length > 0 ? perms.blocking : (perms.states ?? [])}
        onChanged={() => void perms.refresh()}
        reason={permDialog.reason}
      />

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
                <div key={i} className="mq-ghost aspect-video rounded-md border border-border" />
              ))}
            </div>
          ) : picker.error ? (
            <div className="flex flex-col gap-2">
              <p className="rounded-md border border-destructive/50 p-3 font-mono text-xs text-destructive">{picker.error}</p>
              <Button size="sm" variant="outline" onClick={() => void openPicker()} data-testid="button-picker-refresh">
                Try again
              </Button>
            </div>
          ) : picker.sources.length === 0 ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-muted-foreground">
                The OS reported no capturable screens or windows just now. On macOS, grant Screen Recording permission to the app; otherwise the list can be briefly empty while displays settle — refresh it.
              </p>
              <Button size="sm" variant="outline" onClick={() => void openPicker()} data-testid="button-picker-refresh">
                Refresh sources
              </Button>
            </div>
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
  recording_started: 'recording started',
  recording_stopped: 'recording saved',
  recording_finalised: 'MP4 finalised',
  recording_zoomed: 'zoomed edit rendered',
  recording_error: 'recording error',
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
                  e.kind === 'recording_started' && 'bg-destructive',
                  e.kind === 'recording_stopped' && 'bg-chart-1',
                  e.kind === 'recording_finalised' && 'bg-chart-4',
                  e.kind === 'recording_zoomed' && 'bg-chart-5',
                  e.kind === 'recording_error' && 'bg-chart-3',
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
