/**
 * The shell's view of the workspaces and UA profiles.
 *
 * The workspace list, the UA profile table and the active workspace all live in
 * the API server's ledger; the shell reads them rather than keeping a second
 * copy that could drift. Two things need them:
 *
 *  - the toolbar, which must always name the identity that is live;
 *  - the publisher, which needs a workspace's UA profile even when no surface
 *    is attached (a scheduled post can fire with the sidebar on another tab).
 *
 * Pure over `fetch`, so the parsing is testable without Electron.
 */

export type WorkspaceProfile = {
  id: string;
  name: string;
  userAgent: string;
  acceptLanguage: string;
  timezone: string;
  clientHints: boolean;
};

export type WorkspaceEntry = {
  id: string;
  name: string;
  platform: string;
  accountHandle: string | null;
  profile: WorkspaceProfile | null;
};

export type Directory = {
  activeWorkspaceId: string | null;
  workspaces: WorkspaceEntry[];
};

export const EMPTY_DIRECTORY: Directory = {
  activeWorkspaceId: null,
  workspaces: [],
};

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Reads `GET /api/browser/state` into the shape the shell needs. */
export function parseDirectory(payload: unknown): Directory {
  if (!payload || typeof payload !== "object") return EMPTY_DIRECTORY;
  const state = (payload as { state?: unknown }).state;
  if (!state || typeof state !== "object") return EMPTY_DIRECTORY;

  const record = state as Record<string, unknown>;
  const rawProfiles = Array.isArray(record.uaProfiles) ? record.uaProfiles : [];
  const rawWorkspaces = Array.isArray(record.workspaces) ? record.workspaces : [];

  const profiles = new Map<string, WorkspaceProfile>();
  for (const entry of rawProfiles) {
    if (!entry || typeof entry !== "object") continue;
    const profile = entry as Record<string, unknown>;
    const id = str(profile.id);
    const userAgent = str(profile.userAgent);
    if (!id || !userAgent) continue;
    profiles.set(id, {
      id,
      name: str(profile.name) ?? id,
      userAgent,
      acceptLanguage: str(profile.locale) ?? "en-US",
      timezone: str(profile.timezone) ?? "UTC",
      clientHints: profile.clientHints !== false,
    });
  }

  const workspaces: WorkspaceEntry[] = [];
  for (const entry of rawWorkspaces) {
    if (!entry || typeof entry !== "object") continue;
    const workspace = entry as Record<string, unknown>;
    const id = str(workspace.id);
    if (!id) continue;
    const profileId = str(workspace.profileId);
    workspaces.push({
      id,
      name: str(workspace.name) ?? id,
      platform: str(workspace.platform) ?? "unknown",
      accountHandle: str(workspace.accountHandle),
      profile: profileId ? (profiles.get(profileId) ?? null) : null,
    });
  }

  return {
    activeWorkspaceId: str(record.activeWorkspaceId),
    workspaces,
  };
}

export class WorkspaceDirectory {
  private snapshot: Directory = EMPTY_DIRECTORY;
  private lastError: string | null = null;

  /**
   * @param accessToken Supplies the API server's access token. The shell's own
   *   API server is gated, so without this the directory reads nothing and the
   *   publisher cannot resolve a single workspace.
   */
  constructor(
    private readonly baseUrl: () => string | null,
    private readonly accessToken: () => string | null = () => null,
    private readonly timeoutMs = 5_000,
  ) {}

  get current(): Directory {
    return this.snapshot;
  }

  get error(): string | null {
    return this.lastError;
  }

  lookup(workspaceId: string): WorkspaceEntry | null {
    return this.snapshot.workspaces.find((entry) => entry.id === workspaceId) ?? null;
  }

  /** Refreshes, then looks up — for callers that cannot tolerate a stale miss. */
  async resolve(workspaceId: string): Promise<WorkspaceEntry | null> {
    const known = this.lookup(workspaceId);
    if (known) return known;
    await this.refresh();
    return this.lookup(workspaceId);
  }

  async refresh(): Promise<Directory> {
    const base = this.baseUrl();
    if (!base) {
      this.lastError = "No API server address yet";
      return this.snapshot;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const token = this.accessToken();
      const response = await fetch(`${base.replace(/\/+$/, "")}/api/browser/state`, {
        signal: controller.signal,
        headers: token ? { "X-Marquee-Api-Token": token } : undefined,
      });
      if (!response.ok) {
        this.lastError =
          response.status === 401
            ? "HTTP 401: the API server refused the shell's access token"
            : `HTTP ${response.status}`;
        return this.snapshot;
      }
      this.snapshot = parseDirectory(await response.json());
      this.lastError = null;
      return this.snapshot;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return this.snapshot;
    } finally {
      clearTimeout(timer);
    }
  }
}
