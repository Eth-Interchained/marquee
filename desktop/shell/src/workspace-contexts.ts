/**
 * One BrowserContext per workspace.
 *
 * Electron's `session.fromPartition('persist:ua-<workspaceId>')` is a distinct
 * Chromium BrowserContext with its own on-disk profile directory under
 * `<userData>/Partitions/ua-<workspaceId>`: cookies, storage, IndexedDB,
 * service workers and cache are all separate. Two workspaces signed into the
 * same network never see each other's session.
 *
 * The UA profile is applied twice on purpose:
 *
 *  - on the session, so subresource and service-worker requests carry the same
 *    User-Agent and Accept-Language as the top-level document;
 *  - on each webContents through CDP `Emulation.setUserAgentOverride`, which is
 *    the only way to make `navigator.userAgentData` agree with the headers, and
 *    `Emulation.setTimezoneOverride`, which moves `Date` and `Intl` too.
 */

import path from "node:path";
import { app, session, type Session, type WebContents } from "electron";
import { partitionFor, profileDirectoryName } from "./partition";
import { clientHintsFor, lowEntropyHintHeaders, type UserAgentMetadata } from "./ua-metadata";
import { createLogger, errorFields } from "./logger";

const log = createLogger("contexts");

export type WorkspaceIdentity = {
  workspaceId: string;
  partition: string;
  userAgent: string;
  acceptLanguage: string;
  timezone: string;
  /** When false, no `Sec-CH-UA*` headers and no userAgentData at all. */
  clientHints: boolean;
};

type ConfiguredContext = {
  session: Session;
  identity: WorkspaceIdentity;
  hints: UserAgentMetadata | null;
};

const contexts = new Map<string, ConfiguredContext>();

export { partitionFor } from "./partition";

export function profileDirectoryFor(partition: string): string {
  return path.join(app.getPath("userData"), "Partitions", profileDirectoryName(partition));
}

function permissionsFor(context: Session): void {
  // A workspace surface is a logged-in social network, not a trusted app. None
  // of these permissions are needed to read a feed or post text.
  const allowed = new Set(["clipboard-sanitized-write", "fullscreen"]);
  context.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(allowed.has(permission));
  });
  context.setPermissionCheckHandler((_contents, permission) => allowed.has(permission));
}

function applyHeaderOverrides(context: Session, get: () => ConfiguredContext | undefined): void {
  context.webRequest.onBeforeSendHeaders((details, callback) => {
    const current = get();
    if (!current) {
      callback({ requestHeaders: details.requestHeaders });
      return;
    }

    const headers: Record<string, string> = { ...details.requestHeaders };

    // Strip whatever Chromium produced for itself before writing ours, so a
    // real build's brands can never leak alongside the profile's.
    for (const key of Object.keys(headers)) {
      if (/^sec-ch-ua/i.test(key)) delete headers[key];
    }

    headers["Accept-Language"] = current.identity.acceptLanguage;
    Object.assign(headers, lowEntropyHintHeaders(current.hints));

    callback({ requestHeaders: headers });
  });
}

/**
 * Returns the workspace's context, creating and configuring it on first use
 * and updating it when the UA profile changed.
 */
export function contextFor(identity: WorkspaceIdentity): Session {
  const expected = partitionFor(identity.workspaceId);
  if (identity.partition !== expected) {
    throw new Error(
      `Refusing partition "${identity.partition}" for workspace ${identity.workspaceId}: it must be "${expected}".`,
    );
  }

  const hints = identity.clientHints ? clientHintsFor(identity.userAgent) : null;
  const existing = contexts.get(identity.partition);

  if (existing) {
    existing.identity = identity;
    existing.hints = hints;
    existing.session.setUserAgent(identity.userAgent, identity.acceptLanguage);
    return existing.session;
  }

  const context = session.fromPartition(identity.partition, { cache: true });
  const entry: ConfiguredContext = { session: context, identity, hints };
  contexts.set(identity.partition, entry);

  context.setUserAgent(identity.userAgent, identity.acceptLanguage);
  context.setSpellCheckerEnabled(false);
  permissionsFor(context);
  applyHeaderOverrides(context, () => contexts.get(identity.partition));

  log.info("Workspace context ready", {
    workspaceId: identity.workspaceId,
    partition: identity.partition,
    profileDir: profileDirectoryFor(identity.partition),
    clientHints: hints !== null,
  });

  return context;
}

export function identityFrom(input: {
  workspaceId: string;
  userAgent: string;
  acceptLanguage: string;
  timezone: string;
  clientHints: boolean;
}): WorkspaceIdentity {
  return { ...input, partition: partitionFor(input.workspaceId) };
}

/**
 * How long to wait for the CDP overrides before getting on with the
 * navigation. A view that has never loaded anything has no renderer yet, and
 * these commands are answered by the renderer — so on a fresh view they can
 * sit unanswered until something loads. Waiting on them before loading is a
 * deadlock, and its symptom is the worst one this app has: a tab that shows a
 * black rectangle forever and explains nothing.
 */
const EMULATION_DEADLINE_MS = 1_500;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function sendOverrides(
  contents: WebContents,
  identity: WorkspaceIdentity,
  hints: UserAgentMetadata | null,
): Promise<void> {
  await contents.debugger.sendCommand("Emulation.setUserAgentOverride", {
    userAgent: identity.userAgent,
    acceptLanguage: identity.acceptLanguage,
    platform: hints?.platform ?? "",
    // Omitted entirely for non-Chromium UA strings: a Safari UA that also
    // answers getHighEntropyValues() would be a giveaway.
    ...(hints ? { userAgentMetadata: hints } : {}),
  });

  await contents.debugger.sendCommand("Emulation.setTimezoneOverride", {
    timezoneId: identity.timezone,
  });
}

/**
 * Applies the UA profile to a single view. Runs before the first navigation so
 * the override is what the initial request carries — but never blocks it: the
 * headers on that request come from the session anyway, and the parts that
 * need a renderer (`navigator.userAgentData`, the timezone) are re-applied as
 * soon as one exists.
 */
export async function applyEmulation(
  contents: WebContents,
  identity: WorkspaceIdentity,
): Promise<void> {
  contents.setUserAgent(identity.userAgent);

  const hints = identity.clientHints ? clientHintsFor(identity.userAgent) : null;

  try {
    if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
  } catch (error) {
    log.error("Could not attach the debugger for UA emulation", {
      workspaceId: identity.workspaceId,
      ...errorFields(error),
    });
    return;
  }

  const sent = sendOverrides(contents, identity, hints).then(
    () => "sent" as const,
    (error: unknown) => {
      log.error("UA emulation failed", {
        workspaceId: identity.workspaceId,
        ...errorFields(error),
      });
      return "failed" as const;
    },
  );

  const outcome = await Promise.race([sent, sleep(EMULATION_DEADLINE_MS).then(() => "slow" as const)]);
  if (outcome !== "slow") return;

  log.warn("UA emulation is still pending; loading anyway and re-applying once the page is up", {
    workspaceId: identity.workspaceId,
  });

  contents.once("dom-ready", () => {
    void sendOverrides(contents, identity, hints).catch((error: unknown) => {
      log.error("UA emulation failed on retry", {
        workspaceId: identity.workspaceId,
        ...errorFields(error),
      });
    });
  });
}

export function detachEmulation(contents: WebContents): void {
  try {
    if (contents.debugger.isAttached()) contents.debugger.detach();
  } catch {
    // The view is already gone; nothing to detach from.
  }
}
