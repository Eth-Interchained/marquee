/**
 * Access control for the API server when it runs inside the desktop shell.
 *
 * Inside the shell this process holds the bridge capability, so anything that
 * can call `/api/publish` can post through the operator's live sessions. The
 * shell therefore starts it bound to loopback *and* with MARQUEE_API_ACCESS_TOKEN
 * set; every request must then carry that token in `X-Marquee-Api-Token`. The
 * shell's own UI proxy is the only thing that knows it.
 *
 * On the web development surface the variable is unset and this middleware
 * does nothing — that deployment holds no capability to abuse, because it has
 * no bridge.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export const API_TOKEN_HEADER = "x-marquee-api-token";

function configuredToken(): string | null {
  const raw = process.env["MARQUEE_API_ACCESS_TOKEN"]?.trim();
  return raw ? raw : null;
}

/** True when this process is gated, i.e. it is running under the shell. */
export function isAccessGated(): boolean {
  return configuredToken() !== null;
}

function matches(expected: string, provided: unknown): boolean {
  if (typeof provided !== "string" || provided === "") return false;
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(provided).digest();
  return timingSafeEqual(a, b);
}

export function requireLocalAccess(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const expected = configuredToken();
  if (expected === null) {
    next();
    return;
  }

  if (!matches(expected, req.headers[API_TOKEN_HEADER])) {
    res.status(401).json({
      error:
        "This API belongs to the desktop shell and only answers the shell's own workspace UI.",
    });
    return;
  }

  next();
}
