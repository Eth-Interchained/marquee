import { db, getStoreHealth } from "./store";

export { getStoreHealth };

const COLLECTION = "browser_state";

/**
 * Documents are keyed by tenant scope even though the product ships
 * single-tenant. Flipping MARQUEE_TENANCY_MODE to "multi" then partitions state
 * without a migration.
 */
function documentId(tenantId: string): string {
  return `state:${tenantId}`;
}

export type BrowserStateDocument = {
  version: number;
  activeWorkspaceId: string;
  workspaces: unknown[];
  uaProfiles: unknown[];
  drafts: unknown[];
  accounts: unknown[];
  activity: unknown[];
  settings: Record<string, unknown>;
  usage: Record<string, unknown>;
  updatedAt: string;
};

export function readBrowserState(
  tenantId: string,
): BrowserStateDocument | null {
  const document = db.get(COLLECTION, documentId(tenantId));
  return document ? (JSON.parse(document) as BrowserStateDocument) : null;
}

export function writeBrowserState(
  tenantId: string,
  state: BrowserStateDocument,
): BrowserStateDocument {
  const stored = JSON.parse(
    db.put(
      COLLECTION,
      documentId(tenantId),
      JSON.stringify({ ...state, updatedAt: new Date().toISOString() }),
    ),
  ) as BrowserStateDocument;
  db.flush();
  return stored;
}

export function exportStoreHistory(tenantId: string) {
  const tip = db.tipCollection(COLLECTION);
  return {
    tenantId,
    state: readBrowserState(tenantId),
    integrity: getStoreHealth(),
    tip: tip ? JSON.parse(tip) : null,
  };
}
