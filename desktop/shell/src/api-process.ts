/**
 * Runs the workspace API server as a child of the shell.
 *
 * This is where MARQUEE_SESSION_BRIDGE_URL is wired: the shell starts its loopback
 * publisher endpoint first, then hands the child that address. An API server
 * started any other way has no bridge and correctly refuses to publish.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { waitForHttpOk } from "./net";
import { createLogger } from "./logger";

const log = createLogger("api-server");

export type ApiServerHandle = {
  baseUrl: string;
  stop(): Promise<void>;
};

/** What the shell remembers about the API server it started. */
type ApiServerRecord = { pid: number; entry: string; startedAt: string };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function alive(pid: number): boolean {
  try {
    // Signal 0 checks for the process without touching it.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The command line of a running process, for confirming a recorded pid is
 * still the process we recorded. Pids are reused, and this is the difference
 * between reclaiming our own leftovers and killing a stranger's work.
 */
function commandOf(pid: number): string | null {
  try {
    if (process.platform === "win32") {
      return execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
        encoding: "utf8",
      });
    }
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  } catch {
    return null;
  }
}

function readRecord(pidFile: string): ApiServerRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(pidFile, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Partial<ApiServerRecord>;
    if (typeof record.pid !== "number" || !Number.isInteger(record.pid) || record.pid <= 1) {
      return null;
    }
    if (typeof record.entry !== "string" || record.entry === "") return null;
    return { pid: record.pid, entry: record.entry, startedAt: record.startedAt ?? "" };
  } catch {
    return null;
  }
}

function forget(pidFile: string): void {
  try {
    rmSync(pidFile, { force: true });
  } catch {
    // Losing the note is survivable; the next start just cannot reclaim.
  }
}

/**
 * Ends an API server left behind by a previous run.
 *
 * The data directory refuses a second opener — correctly, because two engines
 * on one set of files cannot see each other's writes. So an orphaned child
 * from a shell that died badly makes the *next* launch fail, with an error
 * about a pid the operator has no way to connect to this app.
 *
 * Only a process this shell recorded, and whose command line still matches
 * what was recorded, is ever signalled. A pid that has been reused by
 * something else is left alone.
 */
export async function reclaimOrphanedApiServer(pidFile: string): Promise<void> {
  const record = readRecord(pidFile);
  if (!record) {
    forget(pidFile);
    return;
  }

  if (record.pid === process.pid || !alive(record.pid)) {
    forget(pidFile);
    return;
  }

  const command = commandOf(record.pid);
  const ours =
    command !== null &&
    (process.platform === "win32"
      ? /node\.exe|electron\.exe/i.test(command)
      : command.includes(record.entry));

  if (!ours) {
    log.warn("A recorded API server pid now belongs to something else; leaving it alone", {
      pid: record.pid,
      startedAt: record.startedAt,
    });
    forget(pidFile);
    return;
  }

  log.warn("An API server from a previous run is still holding the data directory; stopping it", {
    pid: record.pid,
    startedAt: record.startedAt,
  });

  try {
    process.kill(record.pid, "SIGTERM");
  } catch {
    forget(pidFile);
    return;
  }

  for (let waited = 0; waited < 5_000 && alive(record.pid); waited += 100) {
    await sleep(100);
  }

  if (alive(record.pid)) {
    log.warn("It did not stop on request; ending it", { pid: record.pid });
    try {
      process.kill(record.pid, "SIGKILL");
    } catch {
      // It exited between the check and the signal.
    }
  }

  forget(pidFile);
}

export async function startApiServer(options: {
  entry: string;
  port: number;
  bridgeUrl: string;
  /** Capability token for the bridge. Handed to this child and nobody else. */
  bridgeToken: string;
  /**
   * Token every caller of this API server must present. It holds the bridge
   * capability, so only the shell's own UI proxy may talk to it.
   */
  accessToken: string;
  dataDir: string;
  /** Where this child's pid is written so a later run can reclaim it. */
  pidFile?: string;
  extraEnv?: Record<string, string | undefined>;
  startupTimeoutMs?: number;
}): Promise<ApiServerHandle> {
  const baseUrl = `http://127.0.0.1:${options.port}`;

  const child: ChildProcess = spawn(process.execPath, [options.entry], {
    env: {
      ...process.env,
      ...options.extraEnv,
      // In a packaged build `process.execPath` is Electron itself; this makes
      // it behave as a plain Node runtime for the child.
      ELECTRON_RUN_AS_NODE: "1",
      NODE_ENV: process.env.NODE_ENV ?? "production",
      PORT: String(options.port),
      // Loopback only: a process holding the publishing capability has no
      // business being reachable from the LAN.
      HOST: "127.0.0.1",
      MARQUEE_SESSION_BRIDGE_URL: options.bridgeUrl,
      MARQUEE_SESSION_BRIDGE_TOKEN: options.bridgeToken,
      MARQUEE_API_ACCESS_TOKEN: options.accessToken,
      NEDB_DATA_DIR: options.dataDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const tail: string[] = [];
  const remember = (chunk: Buffer) => {
    const text = chunk.toString("utf8").trimEnd();
    if (!text) return;
    tail.push(text);
    if (tail.length > 40) tail.shift();
    process.stdout.write(`${text}\n`);
  };

  child.stdout?.on("data", remember);
  child.stderr?.on("data", remember);

  if (options.pidFile && typeof child.pid === "number") {
    const record: ApiServerRecord = {
      pid: child.pid,
      entry: options.entry,
      startedAt: new Date().toISOString(),
    };
    try {
      writeFileSync(options.pidFile, JSON.stringify(record));
    } catch (error) {
      log.warn("Could not record the API server pid; a crash will need a manual cleanup", {
        pidFile: options.pidFile,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let exited = false;
  // Set the moment WE ask the child to stop. Without it every clean quit logs
  // a warning about the API server exiting, which is indistinguishable from
  // the child dying on its own — and a warning that fires on every normal
  // exit teaches you to ignore warnings.
  let stopRequested = false;
  child.on("exit", (code, signal) => {
    exited = true;
    if (options.pidFile) forget(options.pidFile);
    if (stopRequested) {
      log.info("API server stopped", { code, signal });
    } else {
      // Nobody asked for this. A SIGTERM here came from outside the shell.
      log.warn("API server exited on its own", { code, signal });
    }
  });

  // The child holds an exclusive lock on the data directory, and nothing in
  // the OS ends it when this process goes. Any exit that runs JavaScript at
  // all takes it down; the pid file covers the ones that do not.
  const killOnExit = () => {
    if (!exited) {
      stopRequested = true;
      child.kill("SIGTERM");
    }
  };
  process.once("exit", killOnExit);

  try {
    await waitForHttpOk(`${baseUrl}/api/healthz`, options.startupTimeoutMs ?? 30_000, 200, {
      "X-Marquee-Api-Token": options.accessToken,
    });
  } catch (error) {
    stopRequested = true;
    child.kill("SIGTERM");
    const reason = error instanceof Error ? error.message : String(error);
    const output = tail.join("\n");

    // The data directory's own refusal is precise but names a pid with no
    // hint of what it belongs to. Say what it is, in the shell's terms.
    const locked = /locked by another process \(pid (\d+)\)/.exec(output);
    if (locked) {
      throw new Error(
        `Another copy of the workspace API server (pid ${locked[1]}) is still holding this app's data directory, so this one refused to open the same files. It was not started by this shell, or it outlived a shell that could not clean up after itself. Quit that process and start again.\n\n${output}`,
      );
    }

    throw new Error(`The workspace API server did not come up.\n${reason}\n${output}`);
  }

  log.info("API server ready", { baseUrl, bridgeUrl: options.bridgeUrl });

  return {
    baseUrl,
    stop: () =>
      new Promise<void>((resolve) => {
        stopRequested = true;
        process.removeListener("exit", killOnExit);
        if (exited || child.killed) {
          if (options.pidFile) forget(options.pidFile);
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill("SIGTERM");
      }),
  };
}
