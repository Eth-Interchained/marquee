# AGENTS.md — how to work on marquee without reading prose

## What this is
The whole broadcast studio in a browser tab: screen capture + camera corner + social widgets + go-live, with NEDB as the provenance spine (every on-air event is a hash-chained document; `TRACE` is the receipt, `AS OF` is VOD time-travel).

## Deterministic commands
```
npm install
npm run typecheck     # tsc --noEmit
npm test              # node:test via tsx — pure scene/audio math, no browser needed
npm run build         # portal build → dist/
npm run gate          # all three, in order — run before every push
npm run dev           # Vite client :3400 (+ API proxy → :3401)
npm start             # production Express on :3401 serving dist/
```

## Layout
```
src/lib/scene.ts        pure scene graph: layers, normalised rects, hit-test, move/resize math (tested)
src/lib/compositor.ts   canvas renderer: scene + live sources → one canvas; captureStream() = broadcast video
src/lib/capture.ts      getDisplayMedia / getUserMedia wrappers; every failure names itself
src/lib/audio.ts        WebAudio mixer: N sources → one output track, per-source gain + meters (tested math)
src/components/Studio.tsx  the UI: source rail, preview canvas (drag/resize), layer rail, notices
routes/index.page.tsx   Portal route → Studio
server.ts               Express: /api/health (+ nedbd reachability), serves dist/
app.contract.ts         Portal contract (brand, goals, success events)
```

## Rules
- Scenes are DATA. A `Scene` object is what gets versioned into NEDB; never put DOM handles in it.
- Coordinates are normalised 0..1; convert at the edges (`toPixels` / `toNormalised`).
- Preview and broadcast are the same canvas. Never fork the render path.
- No silent failures: every catch logs the browser error name and shows a notice.
- Build order lives in the master spec (Build order section). Do not skip ahead to tips/payments.
- `caused_by` goes at the TOP LEVEL of an nedbd put body, never inside `doc`. Identity field is `_id`.
