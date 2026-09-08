/**
 * Where the shell finds the two halves it hosts.
 *
 * Defaults assume a development checkout (this package sitting in the
 * monorepo). A packaged build carries the built UI and the built API server in
 * its resources directory. Every default is overridable by environment
 * variable — see DEPLOY.md section 5.
 */

import path from "node:path";
import { existsSync } from "node:fs";

export type WorkspaceUiSource =
  | { kind: "external"; url: string }
  | { kind: "bundled"; dir: string };

export type ApiServerSource =
  | { kind: "spawn"; entry: string }
  /**
   * An API server the operator runs. If it is gated (as the shell's own is),
   * `accessToken` must be its UA_API_ACCESS_TOKEN, or nothing in the shell can
   * read the workspace list, let alone publish.
   */
  | { kind: "external"; baseUrl: string; accessToken: string | null };

export type ShellConfig = {
  workspaceUi: WorkspaceUiSource;
  apiServer: ApiServerSource;
  /** 0 asks the OS for a port; set a fixed one when an external API server
   *  needs a stable UA_SESSION_BRIDGE_URL. */
  bridgePort: number;
  /** Ledger location handed to the API server child. */
  dataDir: string;
  /** Where the per-workspace Chromium profiles live. */
  userDataDir: string;
  /**
   * The bundled Python runtime (desktop/py-runtime, supervised by Jenny's
   * orchestrator). `backendDir` holds app.py in a checkout; a packaged build
   * carries the PyInstaller bundle under resources/python and Jenny finds it
   * there itself. `enabled: false` (UA_PY_RUNTIME=0) starts the shell without
   * a terminal rather than failing.
   */
  pythonRuntime: { enabled: boolean; backendDir: string };
};

function env(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

export function resolveConfig(input: {
  appPath: string;
  userDataDir: string;
  resourcesPath: string;
  packaged: boolean;
}): ShellConfig {
  const repoRoot = path.resolve(input.appPath, "..", "..");

  const bundledUiDir = input.packaged
    ? path.join(input.resourcesPath, "workspace-ui")
    : path.join(repoRoot, "artifacts", "ua-social-browser", "dist", "public");

  const apiEntry = input.packaged
    ? path.join(input.resourcesPath, "api-server", "index.mjs")
    : path.join(repoRoot, "artifacts", "api-server", "dist", "index.mjs");

  const externalUi = env("UA_WORKSPACE_UI_URL");
  const externalApi = env("UA_API_SERVER_URL");
  const configuredEntry = env("UA_API_SERVER_ENTRY") ?? apiEntry;

  const workspaceUi: WorkspaceUiSource = externalUi
    ? { kind: "external", url: externalUi }
    : { kind: "bundled", dir: env("UA_WORKSPACE_UI_DIR") ?? bundledUiDir };

  const apiServer: ApiServerSource = externalApi
    ? {
        kind: "external",
        baseUrl: externalApi,
        accessToken: env("UA_API_ACCESS_TOKEN"),
      }
    : { kind: "spawn", entry: configuredEntry };

  const rawBridgePort = Number(env("UA_SHELL_BRIDGE_PORT") ?? "0");

  return {
    workspaceUi,
    apiServer,
    bridgePort: Number.isFinite(rawBridgePort) && rawBridgePort >= 0 ? rawBridgePort : 0,
    dataDir: env("NEDB_DATA_DIR") ?? path.join(input.userDataDir, "ledger"),
    userDataDir: input.userDataDir,
    pythonRuntime: {
      enabled: env("UA_PY_RUNTIME") !== "0",
      backendDir:
        env("UA_PY_RUNTIME_DIR") ??
        (input.packaged
          ? path.join(input.resourcesPath, "python")
          : path.join(repoRoot, "desktop", "py-runtime")),
    },
  };
}

/** Human-readable reason the config cannot work, or null when it can. */
export function describeConfigProblem(config: ShellConfig): string | null {
  if (config.workspaceUi.kind === "bundled" && !existsSync(config.workspaceUi.dir)) {
    return [
      `The workspace UI build is missing at ${config.workspaceUi.dir}.`,
      "Build it with:",
      "  PORT=5173 BASE_PATH=/ pnpm --filter @workspace/ua-social-browser run build",
      "or point UA_WORKSPACE_UI_URL at a running dev server.",
    ].join("\n");
  }

  // Fail closed: the shell hands its publishing capability to whatever API
  // server it is pointed at. An ungated one is an open door to the operator's
  // live sessions from anywhere that can reach it, so the shell does not start.
  if (config.apiServer.kind === "external" && !config.apiServer.accessToken) {
    return [
      `UA_API_SERVER_URL is set to ${config.apiServer.baseUrl}, but UA_API_ACCESS_TOKEN is not.`,
      "That API server receives this shell's bridge capability, so it must be gated:",
      "  - run it bound to 127.0.0.1 (HOST=127.0.0.1) with UA_API_ACCESS_TOKEN set,",
      "  - and start the shell with the same UA_API_ACCESS_TOKEN.",
      "Without it, anything that can reach that server can publish through your signed-in sessions.",
    ].join("\n");
  }

  if (config.apiServer.kind === "spawn" && !existsSync(config.apiServer.entry)) {
    return [
      `The API server build is missing at ${config.apiServer.entry}.`,
      "Build it with:",
      "  pnpm --filter @workspace/api-server run build",
      "or point UA_API_SERVER_URL at a running instance.",
    ].join("\n");
  }

  return null;
}
