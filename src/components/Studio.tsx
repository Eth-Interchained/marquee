import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
} from "../lib/scene";
import { Compositor } from "../lib/compositor";
import { captureCamera, captureMic, captureScreen, stopStream, videoFor, type CaptureError } from "../lib/capture";
import { Mixer } from "../lib/audio";

type Drag =
  | { mode: "move"; id: string; lastX: number; lastY: number }
  | { mode: "resize"; id: string; handle: Handle; lastX: number; lastY: number };

interface Notice {
  level: "info" | "warn" | "error";
  text: string;
  raw?: string;
}

/**
 * The studio: one canvas, layers you can grab, a source rail, an audio rail.
 * Everything the broadcast will show is exactly what this canvas shows —
 * preview and output are the same pixels.
 */
export function Studio(): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const compositorRef = useRef<Compositor | null>(null);
  const mixerRef = useRef<Mixer | null>(null);
  const streamsRef = useRef<Record<string, MediaStream>>({});
  const dragRef = useRef<Drag | null>(null);

  const [scene, setScene] = useState<Scene>(() => defaultScene());
  const [selected, setSelected] = useState<string | null>("camera");
  const [notices, setNotices] = useState<Notice[]>([]);
  const [fps, setFps] = useState(0);
  const [sources, setSources] = useState<Record<string, string>>({});
  const [levels, setLevels] = useState<Record<string, number>>({});
  const [gains, setGains] = useState<Record<string, number>>({});

  const notify = useCallback((n: Notice) => {
    setNotices((prev) => [n, ...prev].slice(0, 6));
    if (n.level === "error") console.error(`[studio] ${n.text}${n.raw ? ` — ${n.raw}` : ""}`);
  }, []);

  // Boot the compositor once the canvas exists.
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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    compositorRef.current?.setScene(scene);
  }, [scene]);

  useEffect(() => {
    if (compositorRef.current) compositorRef.current.selected = selected;
  }, [selected]);

  // Tear down every track on unmount — leaving a camera light on is a bug.
  useEffect(() => {
    return () => {
      for (const s of Object.values(streamsRef.current)) stopStream(s);
      mixerRef.current?.close().catch((err: unknown) => console.error("[studio] mixer close failed", err));
    };
  }, []);

  const ensureMixer = useCallback(async (): Promise<Mixer> => {
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
      // When the user hits the browser's own "Stop sharing" bar, reflect it.
      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        compositorRef.current?.setSource(layerId, null);
        delete streamsRef.current[layerId];
        setSources((s) => {
          const n = { ...s };
          delete n[layerId];
          return n;
        });
        notify({ level: "info", text: `${label} stopped (source ended).` });
      });
    },
    [notify],
  );

  const addScreen = useCallback(async () => {
    try {
      const cap = await captureScreen(true);
      attachStream("screen", cap.stream, `Screen (${cap.surface})`);
      if (cap.hasAudio) {
        const m = await ensureMixer();
        m.add("screen", "Screen audio", cap.stream, 1);
        setGains((g) => ({ ...g, screen: 1 }));
      } else {
        notify({
          level: "warn",
          text:
            "Screen shared without audio. On macOS, Chrome only captures audio for a browser TAB (not a window or the whole screen). Pick a tab, or route game audio through the mic input.",
        });
      }
    } catch (err) {
      const e = err as CaptureError;
      notify({ level: "error", text: e.message ?? String(err), raw: e.raw });
    }
  }, [attachStream, ensureMixer, notify]);

  const addCamera = useCallback(async () => {
    try {
      const cap = await captureCamera();
      attachStream("camera", cap.stream, cap.label);
    } catch (err) {
      const e = err as CaptureError;
      notify({ level: "error", text: e.message ?? String(err), raw: e.raw });
    }
  }, [attachStream, notify]);

  const addMic = useCallback(async () => {
    try {
      const cap = await captureMic();
      const m = await ensureMixer();
      const prev = streamsRef.current["mic"];
      if (prev) stopStream(prev);
      streamsRef.current["mic"] = cap.stream;
      m.add("mic", cap.label, cap.stream, 1);
      setGains((g) => ({ ...g, mic: 1 }));
      setSources((s) => ({ ...s, mic: cap.label }));
    } catch (err) {
      const e = err as CaptureError;
      notify({ level: "error", text: e.message ?? String(err), raw: e.raw });
    }
  }, [ensureMixer, notify]);

  const removeSource = useCallback((id: string) => {
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
  }, []);

  // ---- pointer interaction on the preview canvas ----
  const normPoint = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = e.currentTarget;
    const r = c.getBoundingClientRect();
    return toNormalised(e.clientX - r.left, e.clientY - r.top, r.width, r.height);
  };
  // Handle hit size: 10 CSS px expressed in normalised units.
  const handleSize = (c: HTMLCanvasElement) => {
    const r = c.getBoundingClientRect();
    return { hw: 10 / r.width, hh: 10 / r.height };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = normPoint(e);
    const { hw, hh } = handleSize(e.currentTarget);
    if (selected) {
      const l = scene.layers.find((x) => x.id === selected);
      if (l && l.visible) {
        const h = hitHandle(l.rect, p.x, p.y, hw, hh);
        if (h) {
          dragRef.current = { mode: "resize", id: l.id, handle: h, lastX: p.x, lastY: p.y };
          e.currentTarget.setPointerCapture(e.pointerId);
          return;
        }
      }
    }
    const hit = hitTest(scene, p.x, p.y);
    if (hit) {
      setSelected(hit.id);
      // Screen is the backdrop — you can select it but not drag it around.
      if (hit.kind !== "screen") {
        dragRef.current = { mode: "move", id: hit.id, lastX: p.x, lastY: p.y };
        e.currentTarget.setPointerCapture(e.pointerId);
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
      const rect =
        d.mode === "move" ? moveRect(l.rect, dx, dy) : resizeRect(l.rect, d.handle, dx, dy, l.kind === "camera" || l.shape === "circle");
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
      /* pointer capture may already be released by the browser; nothing to undo */
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
    } catch (err) {
      notify({ level: "error", text: String((err as Error).message) });
    }
  };

  return (
    <div className="studio">
      <header className="bar">
        <div className="brand">
          <span className="mark">◧</span> marquee <span className="ver">v0.1.0 · step 1: compositor</span>
        </div>
        <div className="stats">
          <span>{scene.width}×{scene.height}</span>
          <span>{fps} fps</span>
        </div>
      </header>

      <main className="stage">
        <aside className="rail">
          <h3>Sources</h3>
          <button onClick={addScreen}>{sources.screen ? "Re-pick screen" : "Share screen / game"}</button>
          <button onClick={addCamera}>{sources.camera ? "Re-pick camera" : "Add camera"}</button>
          <button onClick={addMic}>{sources.mic ? "Re-pick mic" : "Add microphone"}</button>
          <ul className="sources">
            {Object.entries(sources).map(([id, label]) => (
              <li key={id}>
                <span className="dot on" /> <b>{id}</b> <span className="muted">{label}</span>
                <button className="x" title="remove" onClick={() => removeSource(id)}>
                  ×
                </button>
              </li>
            ))}
            {Object.keys(sources).length === 0 && <li className="muted">No sources yet. Share your screen and add your camera.</li>}
          </ul>

          <h3>Audio</h3>
          {mixerRef.current?.list().length ? (
            mixerRef.current.list().map((s) => (
              <div key={s.id} className="ch">
                <div className="chhead">
                  <span>{s.label}</span>
                  <span className="muted">{Math.round((levels[s.id] ?? 0) * 100)}</span>
                </div>
                <div className="meter">
                  <div className="lvl" style={{ width: `${Math.min(100, (levels[s.id] ?? 0) * 300)}%` }} />
                </div>
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.01}
                  value={gains[s.id] ?? 1}
                  onChange={(e) => setGain(s.id, Number(e.target.value))}
                />
              </div>
            ))
          ) : (
            <p className="muted">Add a mic or share a tab with audio to see channels.</p>
          )}
        </aside>

        <section className="preview">
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
          <p className="hint">Drag the camera to move it. Grab a corner to resize. Click empty space to deselect.</p>
        </section>

        <aside className="rail">
          <h3>Layers</h3>
          <ul className="layers">
            {[...scene.layers].reverse().map((l) => (
              <li key={l.id} className={l.id === selected ? "sel" : ""} onClick={() => setSelected(l.id)}>
                <input
                  type="checkbox"
                  checked={l.visible}
                  onChange={(e) => setScene((s) => updateLayer(s, l.id, { visible: e.target.checked }))}
                  onClick={(e) => e.stopPropagation()}
                />
                <span>{l.name}</span>
                <span className="muted">{l.kind}</span>
              </li>
            ))}
          </ul>

          {selectedLayer && (
            <>
              <h3>{selectedLayer.name}</h3>
              <label>
                Shape
                <select value={selectedLayer.shape} onChange={(e) => setLayer({ shape: e.target.value as Layer["shape"] })} disabled={selectedLayer.kind === "screen"}>
                  <option value="rect">Rectangle</option>
                  <option value="rounded">Rounded</option>
                  <option value="circle">Circle</option>
                </select>
              </label>
              <label className="row">
                <input type="checkbox" checked={selectedLayer.mirror} onChange={(e) => setLayer({ mirror: e.target.checked })} />
                Mirror
              </label>
              <div className="rect">
                {(["x", "y", "w", "h"] as const).map((k) => (
                  <label key={k}>
                    {k}
                    <input
                      type="number"
                      step={0.01}
                      min={0}
                      max={1}
                      value={Number(selectedLayer.rect[k].toFixed(3))}
                      onChange={(e) => setLayer({ rect: { ...selectedLayer.rect, [k]: Number(e.target.value) } })}
                    />
                  </label>
                ))}
              </div>
              <div className="presets">
                <button onClick={() => setLayer({ rect: { x: 0.735, y: 0.69, w: 0.24, h: 0.24 * (16 / 9) * (1080 / 1920) } })}>Corner ↘</button>
                <button onClick={() => setLayer({ rect: { x: 0.025, y: 0.69, w: 0.24, h: 0.24 * (16 / 9) * (1080 / 1920) } })}>Corner ↙</button>
                <button onClick={() => setLayer({ rect: { x: 0.735, y: 0.04, w: 0.24, h: 0.24 * (16 / 9) * (1080 / 1920) } })}>Corner ↗</button>
              </div>
            </>
          )}

          <h3>Notices</h3>
          <ul className="notices">
            {notices.map((n, i) => (
              <li key={i} className={n.level} title={n.raw}>
                {n.text}
              </li>
            ))}
            {notices.length === 0 && <li className="muted">Failures show up here with the browser's own error name — never silently.</li>}
          </ul>
        </aside>
      </main>
    </div>
  );
}
