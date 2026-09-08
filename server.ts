/**
 * marquee — Express server.
 *
 * Step 1 serves the built studio and a health route. Later steps add the
 * event log (nedbd puts with caused_by), webhook receivers, and the WHIP
 * handoff to mediamtx. Every failure path names itself.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";

function loadEnv(): void {
  const path = resolve(process.cwd(), ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnv();

const port = Number(process.env.MARQUEE_API_PORT || process.env.PORT || 3401);
const nedbUrl = process.env.NEDB_URL || "http://127.0.0.1:7070";
const nedbDb = process.env.NEDB_DB || "marquee";
const dist = resolve(process.cwd(), "dist");

export function createApp(): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));

  app.get("/api/health", async (_req, res) => {
    let nedb: { ok: boolean; detail?: string; version?: string } = { ok: false };
    try {
      const r = await fetch(`${nedbUrl}/health`, { signal: AbortSignal.timeout(2000) });
      const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      nedb = r.ok ? { ok: true, version: String(body.version ?? "?") } : { ok: false, detail: `HTTP ${r.status}` };
    } catch (err) {
      nedb = { ok: false, detail: `unreachable: ${(err as Error).message}` };
    }
    res.json({ marquee: "ok", version: "0.1.0", nedb: { url: nedbUrl, db: nedbDb, ...nedb } });
  });

  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get("*", (_req, res) => res.sendFile(resolve(dist, "index.html")));
  } else {
    app.get("*", (_req, res) =>
      res.status(503).type("text").send("marquee: no dist/ build found. Run `npm run build` first (or `npm run dev` for the Vite client)."),
    );
  }
  return app;
}

if (process.argv[1] && /server\.ts$/.test(process.argv[1])) {
  const server = createApp().listen(port, () => {
    console.log(`\x1b[36m◧ marquee\x1b[0m listening on :${port}`);
    console.log(`  nedbd → ${nedbUrl} (db: ${nedbDb})`);
    if (!existsSync(dist)) console.warn("  \x1b[33mno dist/ — serving a 503 hint until you build\x1b[0m");
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`\x1b[31m[marquee] port ${port} is already in use.\x1b[0m Set MARQUEE_API_PORT to a free port.`);
    } else {
      console.error("[marquee] server error:", err);
    }
    process.exit(1);
  });
}
