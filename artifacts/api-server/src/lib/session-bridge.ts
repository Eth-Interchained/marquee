/**
 * Session bridge.
 *
 * Posting always travels through the user's own authenticated browser session
 * inside the native shell — never through a server-side API token and never
 * through a headless impersonation of the user. This module is the thin,
 * typed boundary between the workspace API server and the native shell's
 * privileged IPC endpoint.
 *
 * The native shell exposes the endpoint on loopback and hands its address to
 * the API server through MARQUEE_SESSION_BRIDGE_URL, together with a capability
 * token in MARQUEE_SESSION_BRIDGE_TOKEN. Both are required: loopback is not a
 * privilege boundary, so the shell refuses any bridge call that does not carry
 * the token it minted at startup. When either variable is absent (for example,
 * when the web development surface runs on its own), publishing reports
 * "unavailable" instead of pretending to post.
 */

export type BridgeStatus = {
  workspaceId: string;
  bridgeAvailable: boolean;
  authenticated: boolean;
  /** Read from the network's signed-in page by the shell. Never a stored label. */
  accountHandle?: string;
  /** Stable account id from the partition's cookies: proof, but not a name. */
  accountId?: string;
  handleSource?: "session";
  /** Why the handle is absent, phrased for the operator. */
  handleUnknown?: string;
  detail: string;
};

export type BridgePublishInput = {
  workspaceId: string;
  draftId: string;
  platform: string;
  body: string;
  /**
   * References, not bytes. The shell resolves each one against the same data
   * directory this process writes to — the shell set `NEDB_DATA_DIR` and
   * spawned this server, so both see one filesystem — and re-hashes the file
   * before uploading it.
   */
  media?: Array<{
    /** Absolute path in the shared data directory; the shell re-hashes it. */
    path: string;
    sha256: string;
    filename: string;
    mimeType: string;
    altText?: string;
  }>;
  idempotencyKey: string;
};

export type BridgePublishOutcome =
  | { kind: "published"; postUrl?: string; postId?: string }
  | { kind: "unauthenticated"; detail: string }
  | { kind: "rejected"; detail: string }
  | { kind: "unavailable"; detail: string };

/**
 * How long a bridge call may take.
 *
 * Coupled to the shell's publish budget and deliberately larger than it. The
 * shell charges setup and the composer flow separately (12s + 18s + teardown,
 * see `PUBLISH_WORST_CASE_MS` in its publisher), and abandoning a call that is
 * still deciding would manufacture the exact ambiguity the design exists to
 * avoid: a post already submitted, with nobody left listening for the answer.
 *
 * Raise this whenever that budget grows. It was 20s against a 17s budget, and
 * the 17s was itself being eaten by an unbounded page load.
 */
const REQUEST_TIMEOUT_MS = 40_000;

/** Header the shell requires on every bridge call. */
const BRIDGE_TOKEN_HEADER = "X-Marquee-Shell-Token";

function bridgeUrl(): string | null {
  const raw = process.env.MARQUEE_SESSION_BRIDGE_URL?.trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

function bridgeToken(): string | null {
  const raw = process.env.MARQUEE_SESSION_BRIDGE_TOKEN?.trim();
  return raw ? raw : null;
}

export function isBridgeConfigured(): boolean {
  return bridgeUrl() !== null && bridgeToken() !== null;
}

/** Says which half of the pairing is missing, so nobody debugs this blind. */
function unavailableDetail(): string {
  if (bridgeUrl() === null) {
    return "Publishing requires the desktop shell. The web surface has no access to your authenticated platform session.";
  }
  return "A session bridge address is set but its capability token is missing, so the shell will refuse every call. Start the API server from the shell, or pair it with MARQUEE_SESSION_BRIDGE_TOKEN.";
}

async function callBridge(
  path: string,
  init: RequestInit,
): Promise<{ ok: boolean; status: number; payload: unknown }> {
  const base = bridgeUrl();
  const token = bridgeToken();
  if (!base || !token) {
    throw new Error("Session bridge is not configured");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${base}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        [BRIDGE_TOKEN_HEADER]: token,
        ...(init.headers ?? {}),
      },
    });
    const text = await response.text();
    const payload: unknown = text ? JSON.parse(text) : null;
    return { ok: response.ok, status: response.status, payload };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads one network's session inside a workspace.
 *
 * `platform` is optional because a workspace has a primary network, but the
 * operator may hold accounts on several inside the same identity. Each is its
 * own session, so a badge for one account may never be drawn from another's.
 */
export async function readSessionStatus(
  workspaceId: string,
  platform?: string,
): Promise<BridgeStatus> {
  if (!isBridgeConfigured()) {
    return {
      workspaceId,
      bridgeAvailable: false,
      authenticated: false,
      detail:
        bridgeUrl() === null
          ? "No native session bridge attached. Posting is only possible from the desktop shell, where your own signed-in session lives."
          : unavailableDetail(),
    };
  }

  try {
    const query = platform ? `?platform=${encodeURIComponent(platform)}` : "";
    const { ok, payload } = await callBridge(
      `/session/${encodeURIComponent(workspaceId)}${query}`,
      { method: "GET" },
    );

    if (!ok) {
      return {
        workspaceId,
        bridgeAvailable: true,
        authenticated: false,
        detail: "The shell could not report this workspace's session state.",
      };
    }

    const data = (payload ?? {}) as {
      authenticated?: boolean;
      accountHandle?: string;
      accountId?: string;
      handleSource?: "session";
      handleUnknown?: string;
      detail?: string;
    };

    return {
      workspaceId,
      bridgeAvailable: true,
      authenticated: Boolean(data.authenticated),
      // Passed through exactly as the shell reported it. This layer must not
      // invent an identity, and has nothing to invent one from.
      accountHandle: data.accountHandle,
      accountId: data.accountId,
      handleSource: data.handleSource,
      handleUnknown: data.handleUnknown,
      detail:
        data.detail ??
        (data.authenticated
          ? "Workspace session is signed in and ready to post."
          : "Sign in to the platform inside this workspace before publishing."),
    };
  } catch (error) {
    return {
      workspaceId,
      bridgeAvailable: false,
      authenticated: false,
      detail:
        error instanceof Error
          ? `Session bridge unreachable: ${error.message}`
          : "Session bridge unreachable.",
    };
  }
}

export type BridgeSignIn = {
  workspaceId: string;
  bridgeAvailable: boolean;
  opened: boolean;
  alreadySignedIn: boolean;
  detail: string;
};

/**
 * Asks the shell to open a live sign-in.
 *
 * This reports only what the shell did with the tab. Whether an account is now
 * usable is a separate question, answered by reading the session back — so
 * `opened: true` must never be rendered as "signed in".
 */
export async function beginSignIn(
  workspaceId: string,
  platform?: string,
): Promise<BridgeSignIn> {
  if (!isBridgeConfigured()) {
    return {
      workspaceId,
      bridgeAvailable: false,
      opened: false,
      alreadySignedIn: false,
      detail:
        bridgeUrl() === null
          ? "Signing in happens inside the desktop shell, where your own browser session lives. The web surface has no session to sign in to."
          : unavailableDetail(),
    };
  }

  try {
    const { ok, payload } = await callBridge(
      `/signin/${encodeURIComponent(workspaceId)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ platform }),
      },
    );

    const data = (payload ?? {}) as {
      opened?: boolean;
      alreadySignedIn?: boolean;
      detail?: string;
    };

    if (!ok) {
      return {
        workspaceId,
        bridgeAvailable: true,
        opened: false,
        alreadySignedIn: false,
        detail: data.detail ?? "The shell could not open a sign-in for this workspace.",
      };
    }

    return {
      workspaceId,
      bridgeAvailable: true,
      opened: Boolean(data.opened),
      alreadySignedIn: Boolean(data.alreadySignedIn),
      detail: data.detail ?? "The shell opened a sign-in tab for this workspace.",
    };
  } catch (error) {
    return {
      workspaceId,
      bridgeAvailable: false,
      opened: false,
      alreadySignedIn: false,
      detail:
        error instanceof Error
          ? `Session bridge unreachable: ${error.message}`
          : "Session bridge unreachable.",
    };
  }
}

export type BridgeSignOut = { signedOut: boolean; detail: string };

/**
 * Asks the shell to destroy one network's session inside a workspace.
 *
 * The shell removes the cookies and then reads the session back; `signedOut`
 * is the answer of that read. This layer adds nothing to it — inventing a
 * success here would be the same lie the shell is careful not to tell.
 */
export async function signOutOfSession(
  workspaceId: string,
  platform?: string,
): Promise<BridgeSignOut> {
  if (!isBridgeConfigured()) {
    return { signedOut: false, detail: unavailableDetail() };
  }

  try {
    const { ok, payload } = await callBridge(
      `/signout/${encodeURIComponent(workspaceId)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ platform }),
      },
    );

    const data = (payload ?? {}) as { signedOut?: boolean; detail?: string };

    if (!ok) {
      return {
        signedOut: false,
        detail: data.detail ?? "The shell could not sign this workspace out.",
      };
    }

    return {
      signedOut: Boolean(data.signedOut),
      detail: data.detail ?? "The shell reported no detail for this sign-out.",
    };
  } catch (error) {
    return {
      signedOut: false,
      detail:
        error instanceof Error
          ? `Session bridge unreachable: ${error.message}. The account is still signed in.`
          : "Session bridge unreachable. The account is still signed in.",
    };
  }
}

export async function publishThroughSession(
  input: BridgePublishInput,
): Promise<BridgePublishOutcome> {
  if (!isBridgeConfigured()) {
    return { kind: "unavailable", detail: unavailableDetail() };
  }

  try {
    const { ok, status, payload } = await callBridge("/publish", {
      method: "POST",
      body: JSON.stringify(input),
    });

    const data = (payload ?? {}) as {
      postUrl?: string;
      postId?: string;
      detail?: string;
      error?: string;
    };

    if (ok) {
      return { kind: "published", postUrl: data.postUrl, postId: data.postId };
    }

    if (status === 401 || status === 403) {
      return {
        kind: "unauthenticated",
        detail:
          data.detail ??
          "The workspace session is not signed in to this platform.",
      };
    }

    return {
      kind: "rejected",
      detail:
        data.detail ?? data.error ?? `The platform rejected the post (${status}).`,
    };
  } catch (error) {
    return {
      kind: "unavailable",
      detail:
        error instanceof Error
          ? `Session bridge unreachable: ${error.message}`
          : "Session bridge unreachable.",
    };
  }
}
