/**
 * The shell's bundled Python, supervised by Jenny's orchestrator.
 *
 * Jenny (`../vendor/jenny`, verbatim) already knows how to spawn a Python
 * backend, poll its /health, restart it with backoff, and rotate its logs.
 * Mark went through every stage of getting that stable, so this file does not
 * re-implement any of it. What it adds is the part Jenny does not have and
 * this shell requires:
 *
 *   - a per-launch capability token, because loopback is not an authorization
 *     boundary. The runtime refuses every route but /health without it;
 *   - the user's real PATH (KeyStone-Lite's shell-path, also verbatim), so a
 *     GUI-launched shell can find `python3` installed via pyenv/Homebrew
 *     instead of dying with exit 127 on the first spawn;
 *   - the interpreter choice: a dev venv when present, the PyInstaller bundle
 *     when packaged — Jenny's own `isDev` switch does the rest.
 *
 * The token reaches the child through the environment. Jenny spawns with
 * `{ ...process.env, ... }` and takes no env option, so the variable is set on
 * this process immediately before `start()` and removed immediately after —
 * `spawn` happens synchronously inside `start()`, so nothing else observes it,
 * and no other child (the API server, a workspace surface) inherits it.
 */

import path from "node:path";
import { existsSync } from "node:fs";
import Orchestrator, { type OrchestratorStatus } from "../vendor/jenny/orchestrator/index.js";
import { fixSpawnPath } from "../vendor/keystone-lite/shell-path";
import { createLogger, errorFields } from "./logger";

const log = createLogger("python-runtime");

export const RUNTIME_TOKEN_ENV = "MARQUEE_PY_RUNTIME_TOKEN";

export type PythonRuntimeHandle = {
  /** http://127.0.0.1:<port> — reached only through the ui-server proxy. */
  baseUrl: string;
  port: number;
  /** The token this launch minted; the proxy is its only other holder. */
  token: string;
  status(): OrchestratorStatus;
  restart(): Promise<boolean>;
  stop(): Promise<void>;
};

export type PythonRuntimeOptions = {
  port: number;
  token: string;
  /** Directory holding app.py (dev) — desktop/py-runtime in the checkout. */
  backendDir: string;
  /** Where the PTY and run_code start; the operator's data dir, never `/`. */
  workspaceDir: string;
  packaged: boolean;
  /** Where Jenny's LogAggregator writes `.jenny/logs`; it uses process.cwd(). */
  logCwd?: string;
};

/**
 * The interpreter for dev mode. Prefers the runtime's own venv (the README's
 * setup step), then whatever `python3` the real PATH offers. Packaged builds
 * ignore this — Jenny locates the PyInstaller bundle itself.
 */
export function resolveDevPython(backendDir: string): string {
  const candidates =
    process.platform === "win32"
      ? [path.join(backendDir, ".venv", "Scripts", "python.exe")]
      : [path.join(backendDir, ".venv", "bin", "python")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return process.platform === "win32" ? "python" : "python3";
}

/**
 * Sets the token in this process's environment only for the duration of
 * `fn` — the synchronous window in which Jenny's `spawn` reads process.env.
 */
export function withRuntimeToken<T>(token: string, fn: () => T): T {
  const previous = process.env[RUNTIME_TOKEN_ENV];
  process.env[RUNTIME_TOKEN_ENV] = token;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[RUNTIME_TOKEN_ENV];
    else process.env[RUNTIME_TOKEN_ENV] = previous;
  }
}

export async function startPythonRuntime(options: PythonRuntimeOptions): Promise<PythonRuntimeHandle> {
  if (!options.token) {
    throw new Error("startPythonRuntime: a capability token is required; refusing to spawn an ungated runtime.");
  }

  // Layer 1 is synchronous and instant; layer 2 asks the login shell. Both
  // never throw. Without this, a Finder/Dock-launched shell sees a skeleton
  // PATH and `python3` is exit 127.
  await fixSpawnPath();

  const pythonPath = resolveDevPython(options.backendDir);

  const orchestrator = new Orchestrator({
    pythonPort: options.port,
    // Jenny's runtime used a second port for WebSockets; ours serves WS on the
    // same port. The option is still passed so the vendored code's env is complete.
    wsPort: options.port,
    isDev: !options.packaged,
    workspaceDir: options.workspaceDir,
    backendDir: options.backendDir,
    pythonPath,
  });

  orchestrator.on("python:started", () => log.info("Python runtime process started", { port: options.port, pythonPath: options.packaged ? "(bundled)" : pythonPath }));
  orchestrator.on("python:healthy", () => log.info("Python runtime healthy"));
  orchestrator.on("python:unhealthy", () => log.warn("Python runtime unhealthy"));
  orchestrator.on("python:recovering", () => log.warn("Python runtime restarting after failed health checks"));
  orchestrator.on("python:crashed", (code) => log.error("Python runtime crashed", { code }));
  orchestrator.on("python:stopped", (code) => log.info("Python runtime stopped", { code }));
  orchestrator.on("log", (entry) => {
    // uvicorn writes its access/startup lines to stderr; that is not an error.
    const line = `[py] ${entry.message}`;
    if (entry.level === "error" && /error|traceback|exception/i.test(entry.message)) log.error(line);
    else log.info(line);
  });

  // The window in which Jenny reads process.env is the synchronous part of
  // processManager.start(); orchestrator.start() calls it first thing.
  let readyPromise: Promise<boolean>;
  withRuntimeToken(options.token, () => {
    readyPromise = orchestrator.start();
  });
  const ready = await readyPromise!;
  if (!ready) {
    await orchestrator.stop();
    throw new Error(
      `The Python runtime did not answer /health on 127.0.0.1:${options.port}. ` +
        (options.packaged
          ? "The bundled interpreter under resources/python is missing or failed to start — rebuild with the Jenny PyInstaller recipe."
          : `Dev interpreter: ${pythonPath}. Create the venv: cd ${options.backendDir} && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`),
    );
  }

  const baseUrl = `http://127.0.0.1:${options.port}`;
  return {
    baseUrl,
    port: options.port,
    token: options.token,
    status: () => orchestrator.getStatus(),
    restart: () => {
      // A restart re-spawns, so the token must be in the env again for it.
      let p: Promise<boolean>;
      withRuntimeToken(options.token, () => {
        p = orchestrator.restart();
      });
      return p!;
    },
    stop: async () => {
      try {
        await orchestrator.stop();
      } catch (error) {
        log.warn("Python runtime stop raised; continuing shutdown", errorFields(error));
      }
    },
  };
}
