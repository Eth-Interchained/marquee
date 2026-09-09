/**
 * Shell entry point.
 *
 * Start-up order matters and is the whole point of this process:
 *
 *   1. the loopback publisher endpoint comes up first, on 127.0.0.1;
 *   2. the workspace API server is started as a child with
 *      MARQUEE_SESSION_BRIDGE_URL pointing at it — that is the only way an API
 *      server ever gets a bridge, and without one it refuses to publish;
 *   3. the workspace UI is served from a loopback origin that proxies /api to
 *      that child, so the shared UI needs no desktop-specific code path;
 *   4. the window opens with the UI as its one privileged page.
 */

import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { app, dialog, ipcMain, session, type IpcMainInvokeEvent } from "electron";

import { describeConfigProblem, resolveConfig, type ShellConfig } from "./config";
import { createLogger, errorFields } from "./logger";
import { freeLoopbackPort } from "./net";
import { startSessionBridge, type SessionBridgeHandle } from "./session-bridge-server";
import { startWorkspaceUiServer, SHELL_COOKIE_NAME, type UiServerHandle } from "./ui-server";
import { startPythonRuntime, type PythonRuntimeHandle } from "./python-runtime";
import { CaptureBroker } from "./capture";
import { allPermissions, openPermissionSettings, requestPermission } from "./permissions";
import {
  reclaimOrphanedApiServer,
  startApiServer,
  type ApiServerHandle,
} from "./api-process";
import { IdempotencyLedger } from "./idempotency";
import { WorkspaceDirectory } from "./workspace-directory";
import { createPublisher } from "./publisher";
import { writePairingFileAt } from "./pairing-file";
import { ShellWindow } from "./shell-window";
import {
  CHANNELS,
  type CaptureSelection,
  type ChromeCommand,
  type PermissionKind,
  type Rect,
  type ShellSessionStatus,
  type SurfaceOptions,
} from "./ipc";

const log = createLogger("main");

const DIRECTORY_REFRESH_MS = 5_000;

type Running = {
  bridge: SessionBridgeHandle;
  api: ApiServerHandle | null;
  python: PythonRuntimeHandle | null;
  ui: UiServerHandle | null;
  window: ShellWindow;
  refreshTimer: NodeJS.Timeout;
};

let running: Running | null = null;

if (!app.requestSingleInstanceLock()) {
  // Two shells would fight over one ledger and one set of profile directories.
  app.quit();
} else {
  app.on("second-instance", () => {
    running?.window.window.focus();
  });

  app.whenReady().then(bootstrap).catch(fatal);

  app.on("window-all-closed", () => app.quit());

  // Quitting has to wait for the API server child: it holds an exclusive lock
  // on the data directory, and a shell that exits while it is still alive
  // leaves the next launch unable to open its own files.
  let quitting = false;
  app.on("before-quit", (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    void shutdown().finally(() => app.exit(0));
  });
}

async function bootstrap(): Promise<void> {
  const config = resolveConfig({
    appPath: app.getAppPath(),
    userDataDir: app.getPath("userData"),
    resourcesPath: process.resourcesPath,
    packaged: app.isPackaged,
  });

  const problem = describeConfigProblem(config);
  if (problem) throw new Error(problem);

  mkdirSync(config.dataDir, { recursive: true });

  let apiBaseUrl: string | null =
    config.apiServer.kind === "external" ? config.apiServer.baseUrl : null;

  // The API server inherits the bridge capability, so reaching it is as good as
  // reaching the bridge. The one the shell starts is bound to loopback and
  // gated on a token minted here; for an API server the operator runs, it is
  // the token they paired — `describeConfigProblem` has already refused to
  // start without one, so this is never empty.
  const apiAccessToken =
    config.apiServer.kind === "external"
      ? (config.apiServer.accessToken ?? "")
      : randomBytes(32).toString("hex");

  // Every shell-internal caller of the API needs it: the directory reads the
  // workspace list, and the publisher cannot resolve a workspace without it.
  const directory = new WorkspaceDirectory(
    () => apiBaseUrl,
    () => apiAccessToken,
  );
  const ledger = new IdempotencyLedger(path.join(config.userDataDir, "publish-ledger.json"));
  // The publisher is built before the window exists, but it only reaches for a
  // tab when an operator asks to sign in — long after startup.
  let shellWindow: ShellWindow | null = null;
  const publisher = createPublisher({
    directory,
    ledger,
    dataDir: config.dataDir,
    tabs: {
      async openOrFocus(workspaceId: string, url: string) {
        if (!shellWindow) {
          throw new Error("The shell window is not up yet, so there is no tab to sign in through.");
        }
        await shellWindow.openOrFocusTab(workspaceId, url);
      },
      // Reading who is signed in needs a page that already is. There may not
      // be one, and that is answered as unknown rather than guessed.
      liveContents(workspaceId: string) {
        return shellWindow?.liveContentsFor(workspaceId) ?? null;
      },
    },
  });

  // 1. The publisher endpoint, before anything that might want to call it.
  //    Its capability token is minted here and never leaves this process
  //    except through the environment of the API server it starts.
  const bridgeToken = randomBytes(32).toString("hex");
  const bridge = await startSessionBridge({
    publisher,
    token: bridgeToken,
    port: config.bridgePort,
    logger: createLogger("bridge"),
  });

  // 2. The API server, wired to it.
  let api: ApiServerHandle | null = null;
  if (config.apiServer.kind === "spawn") {
    // A shell that died badly can leave its API server running, and that child
    // holds the data directory open against everything that follows.
    const pidFile = path.join(config.userDataDir, "api-server.pid");
    await reclaimOrphanedApiServer(pidFile);

    const port = await freeLoopbackPort();
    api = await startApiServer({
      entry: config.apiServer.entry,
      port,
      bridgeUrl: bridge.url,
      bridgeToken,
      accessToken: apiAccessToken,
      dataDir: config.dataDir,
      pidFile,
    });
    apiBaseUrl = api.baseUrl;
  } else {
    log.warn(
      "Using an external API server. It can only publish if it was started with this shell's MARQUEE_SESSION_BRIDGE_URL and MARQUEE_SESSION_BRIDGE_TOKEN; see MARQUEE_SHELL_PAIRING_FILE in DEPLOY.md section 5. It must also be bound to loopback and running with the MARQUEE_API_ACCESS_TOKEN this shell was given.",
      { apiBaseUrl, bridgeUrl: bridge.url },
    );
  }

  writePairingFile(config, bridge.url, bridgeToken);

  await directory.refresh();

  // 2b. The bundled Python runtime — the terminal and, later, the studio's
  // Python-side tools. Supervised by Jenny's orchestrator (vendored verbatim);
  // gated by a token minted here that only the UI proxy ever presents. A
  // runtime that cannot start costs the operator the Terminal, not the app:
  // the UI reports the reason from /runtime/health instead of a blank panel.
  let python: PythonRuntimeHandle | null = null;
  if (config.pythonRuntime.enabled) {
    try {
      python = await startPythonRuntime({
        port: await freeLoopbackPort(),
        token: randomBytes(32).toString("hex"),
        backendDir: config.pythonRuntime.backendDir,
        workspaceDir: config.dataDir,
        packaged: app.isPackaged,
      });
    } catch (error) {
      log.error("Python runtime unavailable; the Terminal section will report this", errorFields(error));
    }
  } else {
    log.info("Python runtime disabled by MARQUEE_PY_RUNTIME=0");
  }

  // 3. The privileged origin.
  const token = randomUUID();
  let ui: UiServerHandle | null = null;
  let workspaceUiUrl: string;

  if (config.workspaceUi.kind === "bundled") {
    if (!apiBaseUrl) throw new Error("The bundled UI needs an API server to proxy to.");
    ui = await startWorkspaceUiServer({
      rootDir: config.workspaceUi.dir,
      apiBaseUrl,
      token,
      apiAccessToken,
      runtime: python ? { baseUrl: python.baseUrl, token: python.token } : null,
    });
    workspaceUiUrl = `${ui.origin}/`;
    // The privileged view runs in the default session, so that is where the
    // gate token has to live.
    await session.defaultSession.cookies.set({
      url: ui.origin,
      name: SHELL_COOKIE_NAME,
      value: token,
      httpOnly: true,
      sameSite: "strict",
    });
  } else {
    workspaceUiUrl = config.workspaceUi.url;
  }

  // 4. The window.
  const dist = __dirname;
  const appIconPath = path.join(dist, "icon.png");

  // An unpackaged macOS run shows Electron's own icon in the dock unless it is
  // set explicitly; a packaged build takes it from the bundle instead and this
  // is a no-op. Failing to load an icon is never worth refusing to start over,
  // so it is logged and shrugged off.
  if (process.platform === "darwin" && app.dock) {
    try {
      app.dock.setIcon(appIconPath);
    } catch (error) {
      log.warn("Could not set the dock icon", {
        icon: appIconPath,
        ...errorFields(error),
      });
    }
  }
  const window = new ShellWindow({
    workspaceUiUrl,
    privilegedPreload: path.join(dist, "preload-privileged.cjs"),
    toolbarPreload: path.join(dist, "preload-toolbar.cjs"),
    toolbarHtml: path.join(dist, "toolbar.html"),
    appIcon: appIconPath,
    directory,
  });

  shellWindow = window;

  // Studio screen capture: the privileged view runs in the default session,
  // so that is where getDisplayMedia() must be answered. Without this handler
  // the call simply fails; with it, only an explicitly picked source is ever
  // handed out, and only once.
  const capture = new CaptureBroker();
  capture.install(session.defaultSession);

  registerBridgeIpc(window, publisher.sessionStatus, capture);

  const refreshTimer = setInterval(() => {
    void directory.refresh().then(() => window.publishChromeState());
  }, DIRECTORY_REFRESH_MS);

  running = { bridge, api, python, ui, window, refreshTimer };

  log.info("Shell ready", {
    workspaceUiUrl,
    apiBaseUrl,
    pythonRuntime: python ? python.baseUrl : "unavailable",
    bridgeUrl: bridge.url,
    profiles: path.join(config.userDataDir, "Partitions"),
  });
}

/**
 * Pairing for an API server the operator starts themselves.
 *
 * The bridge's address and token are written out **only** when the operator
 * asks for it by setting MARQUEE_SHELL_PAIRING_FILE, and the file is created
 * readable by its owner alone. There is deliberately no default, discoverable
 * location: a file that always contained the capability would hand the
 * publisher to every process running as this user.
 */
function writePairingFile(config: ShellConfig, url: string, token: string): void {
  const file = process.env.MARQUEE_SHELL_PAIRING_FILE?.trim();
  if (!file) return;

  try {
    writePairingFileAt(file, { url, token, pid: process.pid });
    log.warn(
      "Wrote a bridge pairing file. It contains the capability that can publish through your sessions; delete it once the API server has read it.",
      { file, userDataDir: config.userDataDir },
    );
  } catch (error) {
    log.error("Could not write the pairing file", { file, ...errorFields(error) });
  }
}

function registerBridgeIpc(
  window: ShellWindow,
  sessionStatus: (workspaceId: string) => Promise<{
    authenticated: boolean;
    accountHandle?: string;
    accountId?: string;
    handleSource?: "session";
    handleUnknown?: string;
    detail: string;
  }>,
  capture: CaptureBroker,
): void {
  /**
   * Only the privileged view may call these. Page content has no preload and
   * therefore no ipcRenderer at all, but the check is explicit anyway: this is
   * the boundary that keeps a social network away from the publisher.
   */
  const privileged = (event: IpcMainInvokeEvent): void => {
    if (event.sender.id !== window.privilegedContentsId) {
      throw new Error("Refused: this channel is reserved for the workspace UI.");
    }
  };

  ipcMain.handle(
    CHANNELS.surfaceAttach,
    async (event, payload: { options: SurfaceOptions; bounds: Rect }) => {
      privileged(event);
      return window.attachSurface(payload.options, payload.bounds);
    },
  );

  ipcMain.handle(CHANNELS.surfaceBounds, (event, payload: { id: string; bounds: Rect }) => {
    privileged(event);
    window.setSurfaceBounds(payload.id, payload.bounds);
  });

  ipcMain.handle(CHANNELS.surfaceNavigate, (event, payload: { id: string; url: string }) => {
    privileged(event);
    window.navigateSurface(payload.id, payload.url);
  });

  ipcMain.handle(CHANNELS.surfaceReload, (event, payload: { id: string }) => {
    privileged(event);
    window.reloadSurface(payload.id);
  });

  ipcMain.handle(CHANNELS.surfaceClose, (event, payload: { id: string }) => {
    privileged(event);
    window.closeSurface(payload.id);
  });

  ipcMain.handle(
    CHANNELS.tabOpen,
    async (event, payload: { workspaceId: string; url: string }) => {
      privileged(event);
      await window.openOrFocusTab(payload.workspaceId, payload.url);
    },
  );

  ipcMain.handle(
    CHANNELS.sessionStatus,
    async (event, payload: { workspaceId: string }): Promise<ShellSessionStatus> => {
      privileged(event);
      const snapshot = await sessionStatus(payload.workspaceId);
      return { workspaceId: payload.workspaceId, ...snapshot };
    },
  );

  ipcMain.handle(CHANNELS.captureSources, async (event) => {
    privileged(event);
    return capture.listSources();
  });

  ipcMain.handle(CHANNELS.permissionsStatus, (event) => {
    privileged(event);
    return allPermissions();
  });

  ipcMain.handle(CHANNELS.permissionsRequest, async (event, payload: { kind: PermissionKind }) => {
    privileged(event);
    const kind = payload?.kind;
    if (kind !== "camera" && kind !== "microphone" && kind !== "screen") {
      throw new Error(`permissionsRequest: unknown kind ${String(kind)}`);
    }
    return requestPermission(kind);
  });

  ipcMain.handle(CHANNELS.permissionsOpenSettings, async (event, payload: { kind: PermissionKind }) => {
    privileged(event);
    const kind = payload?.kind;
    if (kind !== "camera" && kind !== "microphone" && kind !== "screen") {
      throw new Error(`permissionsOpenSettings: unknown kind ${String(kind)}`);
    }
    return openPermissionSettings(kind);
  });

  ipcMain.handle(CHANNELS.captureSelect, (event, payload: { selection: CaptureSelection | null }) => {
    privileged(event);
    const selection = payload?.selection ?? null;
    if (selection !== null && (typeof selection.sourceId !== "string" || typeof selection.withAudio !== "boolean")) {
      throw new Error("captureSelect: selection must be { sourceId: string, withAudio: boolean } or null.");
    }
    capture.select(selection);
  });

  ipcMain.on(CHANNELS.chromeCommand, (_event, command: ChromeCommand) => {
    window.handleChromeCommand(command);
  });
}

async function shutdown(): Promise<void> {
  const current = running;
  running = null;
  if (!current) return;

  clearInterval(current.refreshTimer);
  await current.ui?.close().catch(() => undefined);
  await current.bridge.close().catch(() => undefined);
  await current.api?.stop().catch(() => undefined);
  await current.python?.stop().catch((error: unknown) =>
    log.warn("Python runtime did not stop cleanly", errorFields(error)),
  );
}

function fatal(error: unknown): void {
  log.error("The shell could not start", errorFields(error));
  const message = error instanceof Error ? error.message : String(error);
  if (app.isReady()) {
    dialog.showErrorBox("marquee could not start", message);
  }
  app.exit(1);
}
