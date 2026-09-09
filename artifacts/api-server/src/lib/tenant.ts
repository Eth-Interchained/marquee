import type { Request, Response } from "express";

/**
 * Tenancy seam.
 *
 * The product ships single-tenant: one person, one machine, one local store.
 * Every persisted document is still written under a tenant scope key so that
 * turning on multi-tenancy is a change of resolver, not a change of schema.
 *
 * To go multi-tenant: set MARQUEE_TENANCY_MODE=multi and populate
 * `res.locals.tenantId` from whatever authentication layer is adopted. This
 * module deliberately throws instead of falling back to the personal scope —
 * a silent fallback in multi-tenant mode would leak one account's workspaces
 * into another's.
 */

export type TenancyMode = "single" | "multi";

export const SINGLE_TENANT_ID = "personal";

export class TenantResolutionError extends Error {
  readonly status = 401;
}

export function tenancyMode(): TenancyMode {
  return process.env.MARQUEE_TENANCY_MODE === "multi" ? "multi" : "single";
}

export function resolveTenantId(req: Request): string {
  if (tenancyMode() === "single") {
    return SINGLE_TENANT_ID;
  }

  const fromAuth = (req.res?.locals as { tenantId?: unknown } | undefined)
    ?.tenantId;

  if (typeof fromAuth === "string" && fromAuth.trim() !== "") {
    return fromAuth.trim();
  }

  throw new TenantResolutionError(
    "Multi-tenant mode is enabled but no authenticated tenant is attached to the request",
  );
}

/** Resolves the tenant, or writes the 401 and returns null. */
export function tenantOrUnauthorized(
  req: Request,
  res: Response,
): string | null {
  try {
    return resolveTenantId(req);
  } catch (error) {
    if (error instanceof TenantResolutionError) {
      res.status(error.status).json({ error: error.message });
      return null;
    }
    throw error;
  }
}

export function tenantLabel(tenantId: string): string {
  return tenancyMode() === "single" ? "Personal workspace" : tenantId;
}
