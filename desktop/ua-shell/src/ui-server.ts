/**
 * Serves the workspace UI to the privileged view, and proxies its `/api` calls
 * to the API server the shell manages.
 *
 * One origin for both halves keeps the UI's relative `/api/...` requests
 * working exactly as they do on the web surface, so nothing in the shared UI
 * needs a desktop-specific code path.
 *
 * Everything is bound to loopback and gated on a cookie the shell writes into
 * the privileged partition before the first navigation. Another local process
 * knows neither the port nor the token, and a social network loaded in a
 * workspace surface lives in a different partition, so it has no such cookie —
 * requests without it get a flat 403.
 */

import http from "node:http";
import net from "node:net";
import path from "node:path";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { AddressInfo } from "node:net";

export const SHELL_COOKIE_NAME = "ua_shell_token";

export type UiServerHandle = {
  origin: string;
  port: number;
  close(): Promise<void>;
};

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}

/** Resolves a request path inside `rootDir`, or null if it escapes it. */
export function resolveStaticPath(rootDir: string, requestPath: string): string | null {
  const decoded = decodeURIComponent(requestPath.split("?")[0] ?? "/");
  const candidate = path.resolve(rootDir, `.${path.posix.normalize(decoded)}`);
  const root = path.resolve(rootDir);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) return null;
  return candidate;
}

/**
 * The bundled Python runtime, when the shell started one. Reached by the UI
 * as `/runtime/*` on this origin; the prefix is stripped and the runtime's
 * capability token is added here, so the page never holds it.
 */
export type RuntimeUpstream = {
  baseUrl: string;
  token: string;
};

export const RUNTIME_PREFIX = "/runtime";
export const RUNTIME_TOKEN_HEADER = "X-UA-Runtime-Token";

/** `/runtime/ws/pty?x=1` → `/ws/pty?x=1&token=…`; null when not a runtime path. */
export function rewriteRuntimeUrl(url: string, token: string): string | null {
  if (url !== RUNTIME_PREFIX && !url.startsWith(`${RUNTIME_PREFIX}/`)) return null;
  const stripped = url.slice(RUNTIME_PREFIX.length) || "/";
  // The runtime authenticates WebSocket handshakes by query string because a
  // browser cannot set headers on an upgrade. Any inbound `token` is dropped:
  // only this proxy may supply it.
  const [pathname, query = ""] = stripped.split("?", 2);
  const params = new URLSearchParams(query);
  params.delete("token");
  if (pathname.startsWith("/ws/")) params.set("token", token);
  const search = params.toString();
  return search ? `${pathname}?${search}` : pathname;
}

export async function startWorkspaceUiServer(options: {
  rootDir: string;
  apiBaseUrl: string;
  token: string;
  /**
   * Token the API server requires. This proxy is the only holder: it is added
   * on the way out and any inbound copy is dropped, so a caller cannot smuggle
   * its own value through.
   */
  apiAccessToken: string;
  /** Present only when the shell has a Python runtime up. */
  runtime?: RuntimeUpstream | null;
  port?: number;
}): Promise<UiServerHandle> {
  const { rootDir, apiBaseUrl, token, apiAccessToken } = options;
  const runtime = options.runtime ?? null;

  const server = http.createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      if (!response.headersSent) {
        response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      }
      response.end(detail);
    });
  });

  /**
   * Upgraded sockets leave the HTTP server's own connection tracking, so
   * `server.close()` would wait on them forever. They are tracked here and
   * torn down explicitly in `close()`.
   */
  const spliced = new Set<{ destroy(): void }>();

  /**
   * WebSocket upgrades for the runtime (`/runtime/ws/*`). The same cookie gate
   * as every other request, then a raw TCP splice to the runtime with the
   * request head rewritten: prefix stripped, token added, cookie dropped.
   * Nothing else on this origin upgrades, so anything else is closed.
   */
  server.on("upgrade", (request, socket, head) => {
    const url = request.url ?? "/";
    const refuse = (status: number, reason: string) => {
      socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${reason}`);
      socket.destroy();
    };
    if (readCookie(request.headers.cookie, SHELL_COOKIE_NAME) !== token) {
      refuse(403, "This surface is only reachable from the shell's privileged view.");
      return;
    }
    if (!runtime) {
      refuse(503, "The shell has no Python runtime running, so there is nothing to upgrade to.");
      return;
    }
    const target = rewriteRuntimeUrl(url, runtime.token);
    if (!target || !target.startsWith("/ws/")) {
      refuse(404, `No WebSocket endpoint at ${url}; runtime sockets live under ${RUNTIME_PREFIX}/ws/.`);
      return;
    }
    const upstreamUrl = new URL(runtime.baseUrl);
    const upstream = net.connect(Number(upstreamUrl.port), upstreamUrl.hostname);
    spliced.add(socket);
    spliced.add(upstream);
    const forget = () => {
      spliced.delete(socket);
      spliced.delete(upstream);
    };
    socket.once("close", forget);
    upstream.once("close", forget);
    upstream.once("connect", () => {
      const lines = [`${request.method ?? "GET"} ${target} HTTP/1.1`];
      for (const [key, value] of Object.entries(request.headers)) {
        if (value === undefined) continue;
        const lower = key.toLowerCase();
        if (lower === "cookie" || lower === RUNTIME_TOKEN_HEADER.toLowerCase()) continue;
        if (lower === "host") {
          lines.push(`Host: ${upstreamUrl.host}`);
          continue;
        }
        lines.push(`${key}: ${Array.isArray(value) ? value.join(", ") : value}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.once("error", (error) => {
      refuse(502, `The Python runtime refused the socket: ${error.message}`);
    });
    socket.once("error", () => upstream.destroy());
    socket.once("close", () => upstream.destroy());
    upstream.once("close", () => socket.destroy());
  });

  async function handle(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    if (readCookie(request.headers.cookie, SHELL_COOKIE_NAME) !== token) {
      response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("This surface is only reachable from the shell's privileged view.");
      return;
    }

    const url = request.url ?? "/";

    if (url === "/api" || url.startsWith("/api/")) {
      await proxyToApi(request, response, url);
      return;
    }

    if (url === RUNTIME_PREFIX || url.startsWith(`${RUNTIME_PREFIX}/`)) {
      await proxyToRuntime(request, response, url);
      return;
    }

    await serveStatic(request, response, url);
  }

  async function proxyToRuntime(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    url: string,
  ): Promise<void> {
    if (!runtime) {
      response.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
      response.end(
        JSON.stringify({
          error: "runtime_unavailable",
          detail: "The shell has no Python runtime running. It failed to start, or this is the web development surface, which has no shell.",
        }),
      );
      return;
    }
    const target = rewriteRuntimeUrl(url, runtime.token);
    if (!target) {
      response.writeHead(404);
      response.end();
      return;
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (value === undefined) continue;
      const lower = key.toLowerCase();
      if (["host", "connection", "cookie", "content-length", RUNTIME_TOKEN_HEADER.toLowerCase()].includes(lower)) continue;
      headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
    headers.set(RUNTIME_TOKEN_HEADER, runtime.token);

    const method = request.method ?? "GET";
    const hasBody = method !== "GET" && method !== "HEAD";
    const body = hasBody ? Uint8Array.from(await readRequestBody(request)) : undefined;

    let upstream: Response;
    try {
      upstream = await fetch(`${runtime.baseUrl.replace(/\/+$/, "")}${target}`, { method, headers, body });
    } catch (error) {
      response.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
      response.end(
        JSON.stringify({
          error: "runtime_unreachable",
          detail: `The Python runtime at ${runtime.baseUrl} did not answer: ${error instanceof Error ? error.message : String(error)}. It may be restarting after a failed health check.`,
        }),
      );
      return;
    }

    const outHeaders: Record<string, string> = {};
    upstream.headers.forEach((value, key) => {
      if (["content-encoding", "content-length", "transfer-encoding"].includes(key)) return;
      outHeaders[key] = value;
    });
    const payload = Buffer.from(await upstream.arrayBuffer());
    outHeaders["content-length"] = String(payload.byteLength);
    response.writeHead(upstream.status, outHeaders);
    response.end(payload);
  }

  async function proxyToApi(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    url: string,
  ): Promise<void> {
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (value === undefined) continue;
      const lower = key.toLowerCase();
      // Hop-by-hop headers, the shell cookie which is ours rather than the
      // API's, and any inbound API token: only this proxy may set that one.
      if (
        ["host", "connection", "cookie", "content-length", "x-ua-api-token"].includes(lower)
      ) {
        continue;
      }
      headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
    headers.set("X-UA-Api-Token", apiAccessToken);

    const method = request.method ?? "GET";
    const hasBody = method !== "GET" && method !== "HEAD";
    const body = hasBody ? Uint8Array.from(await readRequestBody(request)) : undefined;

    const upstream = await fetch(`${apiBaseUrl.replace(/\/+$/, "")}${url}`, {
      method,
      headers,
      body,
    });

    const outHeaders: Record<string, string> = {};
    upstream.headers.forEach((value, key) => {
      if (["content-encoding", "content-length", "transfer-encoding"].includes(key)) return;
      outHeaders[key] = value;
    });

    const payload = Buffer.from(await upstream.arrayBuffer());
    outHeaders["content-length"] = String(payload.byteLength);
    response.writeHead(upstream.status, outHeaders);
    response.end(payload);
  }

  async function serveStatic(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    url: string,
  ): Promise<void> {
    const requested = resolveStaticPath(rootDir, url);
    if (!requested) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Bad path");
      return;
    }

    const candidates = [requested, path.join(rootDir, "index.html")];
    for (const candidate of candidates) {
      try {
        const info = await stat(candidate);
        if (info.isDirectory()) continue;
        response.writeHead(200, {
          "Content-Type": CONTENT_TYPES[path.extname(candidate)] ?? "application/octet-stream",
          "Content-Length": info.size,
          // The shell ships the UI it was built with; nothing here should be
          // cached across launches of a freshly built bundle.
          "Cache-Control": "no-store",
        });
        createReadStream(candidate).pipe(response);
        return;
      } catch {
        continue;
      }
    }

    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${address.port}`,
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
        for (const s of spliced) s.destroy();
        spliced.clear();
      }),
  };
}

function readRequestBody(request: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}
