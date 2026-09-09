/**
 * The loopback publisher endpoint.
 *
 * This is the server half of the contract consumed by
 * `artifacts/api-server/src/lib/session-bridge.ts` and documented in
 * DEPLOY.md section 5:
 *
 *   GET  /session/:workspaceId  200 { authenticated, accountHandle?, detail? }
 *   POST /publish               200 { postUrl?, postId? }
 *                               401 { detail }  -> "session not signed in"
 *                               4xx/5xx { detail } -> "the platform rejected it"
 *
 * It binds to 127.0.0.1 only. The API server is handed its address through
 * MARQUEE_SESSION_BRIDGE_URL; with no address, the API server reports publishing as
 * unavailable rather than pretending to post.
 *
 * ## Why loopback is not enough
 *
 * This endpoint reaches the operator's own signed-in sessions, and the human
 * approval that gates publishing is enforced in the API server — a caller that
 * could reach the bridge directly would be posting with no approval at all.
 * Every other local process, and every browser page the operator visits, can
 * also talk to 127.0.0.1. So the bridge requires a capability token that the
 * shell generates at startup and gives only to the API server it trusts;
 * requests without it are refused before the publisher is ever consulted.
 *
 * The token travels in a custom header, which also means a browser cannot send
 * it: any cross-origin attempt is either blocked by CORS preflight (which this
 * server never approves) or arrives without the header and is refused.
 *
 * Deliberately free of Electron imports so the contract can be tested with a
 * stub publisher under plain Node.
 */

import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";

/** Header carrying the shell's capability token. */
export const BRIDGE_TOKEN_HEADER = "x-marquee-shell-token";

export type SessionSnapshot = {
  authenticated: boolean;
  /**
   * The signed-in handle, read from the network's own signed-in page.
   *
   * Present only when it was actually read. It is never the workspace's
   * configured label — a stored string presented as the signed-in account is a
   * claim about someone's account that nothing checked.
   */
  accountHandle?: string;
  /** Stable account id from the partition's cookies. Proof, but not a name. */
  accountId?: string;
  /** Always `"session"` when a handle is present, so a caller cannot assume. */
  handleSource?: "session";
  /** Why the handle is absent, in words meant for the operator. */
  handleUnknown?: string;
  detail: string;
};

export type PublishMediaInput = {
  /** Absolute path inside the shared data directory. Verified before upload. */
  path: string;
  sha256: string;
  filename: string;
  mimeType: string;
  altText?: string;
};

export type PublishRequestInput = {
  workspaceId: string;
  draftId: string;
  platform: string;
  body: string;
  media: PublishMediaInput[];
  idempotencyKey: string;
};

export type PublishOutcome =
  | { kind: "published"; postUrl?: string; postId?: string; detail?: string }
  | { kind: "unauthenticated"; detail: string }
  | { kind: "rejected"; detail: string; status?: number };

/**
 * The result of asking for a live sign-in.
 *
 * Opening the window is all this reports. Whether the operator actually signed
 * in is answered later by `GET /session/:workspaceId` reading the cookie jar —
 * a window that was opened proves nothing about an account, and saying
 * otherwise would put a "signed in" badge on an empty session.
 */
export type SignInInvitation = {
  /** A sign-in window is now in front of the operator. */
  opened: boolean;
  /** The workspace was already signed in, so no window was needed. */
  alreadySignedIn: boolean;
  detail: string;
};

export type PublisherPort = {
  /**
   * `platform` names which network's session to read. It is optional because a
   * workspace has a primary network; it is *offered* because the same identity
   * may hold accounts on several, and each of those is a separate session that
   * must be read on its own rather than inferred from a sibling.
   */
  sessionStatus(workspaceId: string, platform?: string): Promise<SessionSnapshot>;
  publish(input: PublishRequestInput): Promise<PublishOutcome>;
  /**
   * Opens the network's own login page inside the workspace's masked session.
   * Returns as soon as the window is up: a human sign-in takes minutes and may
   * involve a second factor, so nothing here waits on it.
   */
  beginSignIn(workspaceId: string, platform?: string): Promise<SignInInvitation>;
  /**
   * Destroys one network's session inside the workspace, and verifies it.
   *
   * `signedOut` is the answer of a fresh session read, not of the removal
   * loop. A sign-out that reports success without checking is the same class
   * of claim as a post reported without confirmation.
   */
  signOut(
    workspaceId: string,
    platform?: string,
  ): Promise<{ signedOut: boolean; detail: string }>;
};

export type BridgeLogger = {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
};

export type SessionBridgeHandle = {
  url: string;
  port: number;
  close(): Promise<void>;
};

const MAX_BODY_BYTES = 512 * 1024;

/**
 * Compares tokens without leaking their contents through timing. Both sides are
 * hashed first so the comparison is fixed-length whatever was sent.
 */
export function tokenMatches(expected: string, provided: unknown): boolean {
  if (typeof provided !== "string" || provided === "") return false;
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(provided).digest();
  return timingSafeEqual(a, b);
}

function sendJson(
  response: http.ServerResponse,
  status: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];

    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body is too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function parsePublishInput(raw: unknown): PublishRequestInput | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;

  const fields = [
    "workspaceId",
    "draftId",
    "platform",
    "body",
    "idempotencyKey",
  ] as const;

  for (const field of fields) {
    if (typeof value[field] !== "string" || (value[field] as string).trim() === "") {
      return null;
    }
  }

  // A malformed attachment is a refused request, not a dropped attachment.
  // Posting the text without the picture would be publishing something nobody
  // approved, and doing it quietly is worse than doing it loudly.
  const media = parsePublishMedia(value.media);
  if (media === null) return null;

  return {
    workspaceId: value.workspaceId as string,
    draftId: value.draftId as string,
    platform: value.platform as string,
    body: value.body as string,
    media,
    idempotencyKey: value.idempotencyKey as string,
  };
}

/** `null` means the field was present but unusable; `[]` means none were sent. */
function parsePublishMedia(raw: unknown): PublishMediaInput[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;

  const media: PublishMediaInput[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const item = entry as Record<string, unknown>;
    const required = ["path", "sha256", "filename", "mimeType"] as const;
    for (const field of required) {
      if (typeof item[field] !== "string" || (item[field] as string).trim() === "") {
        return null;
      }
    }
    media.push({
      path: item.path as string,
      sha256: item.sha256 as string,
      filename: item.filename as string,
      mimeType: item.mimeType as string,
      ...(typeof item.altText === "string" ? { altText: item.altText } : {}),
    });
  }
  return media;
}

/** Maps a publish outcome onto the HTTP shape the API server expects. */
export function statusForOutcome(outcome: PublishOutcome): number {
  switch (outcome.kind) {
    case "published":
      return 200;
    case "unauthenticated":
      return 401;
    case "rejected":
      return outcome.status ?? 502;
  }
}

export async function startSessionBridge(options: {
  publisher: PublisherPort;
  /** Capability token the caller must present. Generated by the shell. */
  token: string;
  port?: number;
  host?: string;
  logger?: BridgeLogger;
}): Promise<SessionBridgeHandle> {
  const { publisher, token } = options;
  const host = options.host ?? "127.0.0.1";
  const logger = options.logger;

  if (!token || token.length < 32) {
    // A weak or missing token would make the endpoint effectively open, which
    // is exactly the failure this guard exists to prevent.
    throw new Error("The session bridge needs a capability token of at least 32 characters.");
  }

  const server = http.createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      logger?.error("Session bridge request failed", { detail });
      if (!response.headersSent) sendJson(response, 500, { detail });
      else response.end();
    });
  });

  async function handle(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // Authorization first, before parsing, routing, or touching the publisher.
    if (!tokenMatches(token, request.headers[BRIDGE_TOKEN_HEADER])) {
      logger?.warn("Refused an unauthorized session bridge request", {
        method: request.method,
        path,
        // Neither the expected nor the presented token is ever logged.
        presentedToken: request.headers[BRIDGE_TOKEN_HEADER] ? "invalid" : "absent",
      });
      sendJson(response, 401, {
        detail:
          "This endpoint publishes through the operator's own sessions and requires the shell's capability token.",
      });
      return;
    }

    if (request.method === "GET" && path === "/health") {
      sendJson(response, 200, { status: "ok" });
      return;
    }

    const sessionMatch = /^\/session\/(.+)$/.exec(path);
    if (request.method === "GET" && sessionMatch) {
      const workspaceId = decodeURIComponent(sessionMatch[1] as string);
      const snapshot = await publisher.sessionStatus(
        workspaceId,
        url.searchParams.get("platform") ?? undefined,
      );
      sendJson(response, 200, {
        authenticated: snapshot.authenticated,
        accountHandle: snapshot.accountHandle,
        detail: snapshot.detail,
      });
      return;
    }

    const signOutMatch = /^\/signout\/(.+)$/.exec(path);
    if (request.method === "POST" && signOutMatch) {
      const workspaceId = decodeURIComponent(signOutMatch[1] as string);

      // Same rule as sign-in: an unreadable body is refused rather than
      // treated as "no platform". Signing the wrong network out of a
      // workspace destroys a session the operator did not ask to lose.
      let platform: string | undefined;
      try {
        const text = await readBody(request);
        if (text.trim() !== "") {
          const parsed: unknown = JSON.parse(text);
          const raw = (parsed as { platform?: unknown } | null)?.platform;
          platform = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined;
        }
      } catch (error) {
        sendJson(response, 400, {
          detail:
            error instanceof Error
              ? `Unreadable sign-out request: ${error.message}`
              : "Unreadable sign-out request",
        });
        return;
      }

      const outcome = await publisher.signOut(workspaceId, platform);

      logger?.info("Sign-out requested", {
        workspaceId,
        platform: platform ?? "(workspace default)",
        signedOut: outcome.signedOut,
      });

      // 200 either way: the shell did the work and is reporting what it found.
      // A failed sign-out is an answer, not a transport error.
      sendJson(response, 200, outcome);
      return;
    }

    const signInMatch = /^\/signin\/(.+)$/.exec(path);
    if (request.method === "POST" && signInMatch) {
      const workspaceId = decodeURIComponent(signInMatch[1] as string);

      // The body is optional — a sign-in with no platform means the
      // workspace's own network — but an unreadable one is refused rather
      // than quietly treated as "no platform", which would open the wrong
      // network's login page and look like the app ignored the request.
      let platform: string | undefined;
      try {
        const text = await readBody(request);
        if (text.trim() !== "") {
          const parsed: unknown = JSON.parse(text);
          const raw = (parsed as { platform?: unknown } | null)?.platform;
          platform = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined;
        }
      } catch (error) {
        sendJson(response, 400, {
          detail:
            error instanceof Error
              ? `Unreadable sign-in request: ${error.message}`
              : "Unreadable sign-in request",
        });
        return;
      }

      const invitation = await publisher.beginSignIn(workspaceId, platform);

      logger?.info("Live sign-in requested", {
        workspaceId,
        platform,
        opened: invitation.opened,
        alreadySignedIn: invitation.alreadySignedIn,
      });

      sendJson(response, 200, invitation);
      return;
    }

    if (request.method === "POST" && path === "/publish") {
      let parsed: unknown;
      try {
        const text = await readBody(request);
        parsed = text ? JSON.parse(text) : null;
      } catch (error) {
        sendJson(response, 400, {
          detail:
            error instanceof Error
              ? `Unreadable publish request: ${error.message}`
              : "Unreadable publish request",
        });
        return;
      }

      const input = parsePublishInput(parsed);
      if (!input) {
        sendJson(response, 400, {
          detail:
            "A publish request needs workspaceId, draftId, platform, body and idempotencyKey.",
        });
        return;
      }

      const outcome = await publisher.publish(input);
      const status = statusForOutcome(outcome);

      logger?.info("Publish attempt finished", {
        workspaceId: input.workspaceId,
        draftId: input.draftId,
        platform: input.platform,
        outcome: outcome.kind,
        status,
      });

      if (outcome.kind === "published") {
        sendJson(response, 200, {
          postUrl: outcome.postUrl,
          postId: outcome.postId,
          detail: outcome.detail,
        });
        return;
      }

      sendJson(response, status, { detail: outcome.detail });
      return;
    }

    sendJson(response, 404, { detail: `No bridge route for ${request.method} ${path}` });
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const url = `http://${host}:${address.port}`;
  logger?.info("Session bridge listening", { url });

  return {
    url,
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Shutdown can be reached from both a quit and an error path.
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
