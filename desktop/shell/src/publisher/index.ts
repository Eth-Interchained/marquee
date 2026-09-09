/**
 * The publisher.
 *
 * A post leaves through the workspace's own signed-in Chromium session: the
 * shell opens the network's composer inside that workspace's BrowserContext,
 * under that workspace's UA profile, and drives it. There is no API token and
 * no headless impersonation anywhere in this path.
 *
 * The window is hidden because publishing runs unattended (an approved draft
 * can fire while the operator is on another workspace), not because anything is
 * being concealed: it is the same session, same cookies, same profile the
 * operator sees when they open the tab themselves.
 */

import { BrowserWindow } from "electron";
import type {
  PublishOutcome,
  PublishRequestInput,
  PublisherPort,
  SessionSnapshot,
  SignInInvitation,
} from "../session-bridge-server";
import type { IdempotencyLedger } from "../idempotency";
import { unconfirmedOutcome } from "../idempotency";
import type { WorkspaceDirectory, WorkspaceEntry } from "../workspace-directory";
import { applyEmulation, contextFor, detachEmulation, identityFrom } from "../workspace-contexts";
import { adapterFor, type PlatformAdapter } from "./adapters";
import { resolveApprovedMedia } from "./approved-media";
import { parseAccountId, resolveIdentity } from "./identity";
import { deviceClassFor } from "./device";
import { clearNetworkCookies, describeSignOut } from "./sign-out";
import {
  createIdentityCache,
  identityCacheKey,
  type CachedHandle,
} from "./identity-cache";
import { runInPage } from "./page";
import { createLogger, errorFields } from "../logger";

const log = createLogger("publisher");

/**
 * How long the composer flow gets, measured from the moment the page is up.
 *
 * This used to be struck before `applyEmulation` and `loadURL` ran, and
 * neither of those is bounded by it — so on a cold start the flow inherited
 * whatever was left rather than the budget it was supposed to have. Measured
 * on a real machine: the first publish after launch took 20.7s and reported
 * unconfirmed, while every warm attempt afterwards finished in about 6s. The
 * post had gone out; confirmation had been squeezed to nothing.
 *
 * Setup is now charged to `SETUP_BUDGET_MS` and the clock for the flow starts
 * afterwards, so a slow page load costs time but never costs certainty.
 */
const COMPOSE_BUDGET_MS = 18_000;

/**
 * How long the window gets to apply its UA profile and load the composer.
 *
 * Exceeding this is not a failure: the page may still be arriving, and the
 * flow's own probe loop waits for the composer anyway. All this does is stop
 * the wait being charged to the flow's budget.
 */
const SETUP_BUDGET_MS = 12_000;

/**
 * The worst case the API server's bridge call has to tolerate: setup, then the
 * flow, plus room to tear the window down. `session-bridge.ts` must allow more
 * than this or it will abandon an attempt that is still deciding — which is
 * exactly the ambiguity the whole design exists to avoid.
 */
export const PUBLISH_WORST_CASE_MS = SETUP_BUDGET_MS + COMPOSE_BUDGET_MS + 3_000;

/**
 * How long the handle read gets before the answer is "unknown".
 *
 * Reading the handle means asking a live page a question, and a busy
 * single-page app can take its time answering: this cost **6080 ms** in the
 * field, on an endpoint the UI polls. Nothing about a session badge is worth
 * six seconds of a polled request, and the operator is better served by a fast
 * "couldn't read it" than a slow name.
 *
 * A timed-out read is abandoned, not cancelled — the page keeps evaluating and
 * simply has nobody waiting. That is harmless: the read takes no locks and
 * writes nothing.
 */
const IDENTITY_READ_BUDGET_MS = 1_200;

/** How long a handle that *was* read may be reused. */
const IDENTITY_CACHE_TTL_MS = 30_000;

/**
 * How long an unreadable handle may be reused.
 *
 * Deliberately short. The usual reason a handle cannot be read is that the
 * page has not finished arriving, which fixes itself — caching that answer for
 * as long as a real one would turn a passing miss into a lasting "unknown".
 */
const IDENTITY_CACHE_FAILURE_TTL_MS = 4_000;

/** Resolves when `work` settles or `ms` elapses, whichever comes first. */
async function atMost<T>(work: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function identityForEntry(entry: WorkspaceEntry) {
  const profile = entry.profile;
  return identityFrom({
    workspaceId: entry.id,
    // A workspace with no UA profile still gets its own isolated context; it
    // simply runs under the shell's own Chromium identity.
    userAgent: profile?.userAgent ?? "",
    acceptLanguage: profile?.acceptLanguage ?? "en-US",
    timezone: profile?.timezone ?? "UTC",
    clientHints: profile?.clientHints ?? false,
  });
}

/**
 * How the publisher reaches the shell's tab strip.
 *
 * Kept as a port rather than a direct reference because the publisher is built
 * before the window exists, and because a signing-in operator should land in
 * the same tab they already use for that network.
 */
export type WorkspaceTabs = {
  openOrFocus(workspaceId: string, url: string): Promise<void>;
  /**
   * A live signed-in page for this workspace, when one is loaded.
   *
   * Used to read *which* account is signed in. Returning `null` is a normal
   * answer — the operator may not have the network view open — and produces an
   * honest "unknown" rather than a fallback to anything stored.
   */
  liveContents?(workspaceId: string): WebContentsLike | null;
};

/** The slice of Electron's `WebContents` this needs, kept narrow for testing. */
export type WebContentsLike = {
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
};

export function createPublisher(deps: {
  directory: WorkspaceDirectory;
  ledger: IdempotencyLedger;
  tabs: WorkspaceTabs;
  /**
   * The data directory this shell chose and handed to the API server. Uploads
   * live under it, and a path outside it is refused rather than read.
   */
  dataDir: string;
}): PublisherPort {
  const { directory, ledger, tabs, dataDir } = deps;

  // Only the handle is remembered, and only bound to the account the cookies
  // report. See `identity-cache.ts` for why that binding is the safety rule.
  const handles = createIdentityCache({
    ttlMs: IDENTITY_CACHE_TTL_MS,
    failureTtlMs: IDENTITY_CACHE_FAILURE_TTL_MS,
  });

  async function signedIn(
    entry: WorkspaceEntry,
    adapter: PlatformAdapter,
  ): Promise<{ authenticated: boolean; detail: string }> {
    if (adapter.detection.kind === "unsupported") {
      return {
        authenticated: false,
        detail: `${adapter.label}: ${adapter.detection.reason} Open the workspace tab to check the session.`,
      };
    }

    const context = contextFor(identityForEntry(entry));
    const cookies = await context.cookies.get({ url: adapter.origin });
    const names = new Set(cookies.map((cookie) => cookie.name));
    const found = adapter.detection.names.filter((name) => names.has(name));

    if (found.length === 0) {
      return {
        authenticated: false,
        detail: `No ${adapter.label} session in this workspace's cookie jar. Open the workspace tab and sign in.`,
      };
    }

    return {
      authenticated: true,
      detail: `Signed in to ${adapter.label} in this workspace's own cookie jar.`,
    };
  }

  /**
   * Reads the account behind a workspace's session.
   *
   * Cookies come from the partition itself; the handle comes from whatever
   * signed-in page of that network is already open, so nothing extra is
   * fetched and no private API is called. A failure anywhere here is reported
   * as unknown — never as a name.
   */
  async function whoIsSignedIn(entry: WorkspaceEntry, adapter: PlatformAdapter) {
    const context = contextFor(identityForEntry(entry));

    const readCookie = async (name: string) => {
      const cookies = await context.cookies.get({ url: adapter.origin, name });
      return cookies[0]?.value;
    };

    // The account id comes from the cookie jar: local, immediate, and never
    // cached. It is read first because it is what a remembered handle is bound
    // to — a handle may only be reused while the account behind it is the same.
    const idCookie = adapter.identity?.idCookie;
    const accountId = idCookie
      ? parseAccountId(await readCookie(idCookie.name), idCookie.pattern)
      : undefined;

    const key = identityCacheKey(entry.id, adapter.platform);
    const remembered = handles.get(key, accountId);
    if (remembered) {
      return { ...(accountId ? { accountId } : {}), ...remembered };
    }

    /** Set when the page read ran out of time, so the reason can say so. */
    let readTimedOut = false;

    const identity = await resolveIdentity(adapter.identity, {
      cookie: readCookie,

      async pageText(selectors: string[]) {
        const contents = tabs.liveContents?.(entry.id) ?? null;
        if (!contents) return null;

        try {
          // Text plus the attributes that carry a name in practice. Read-only,
          // and scoped to the first element any selector matches — a page is
          // full of other people's handles.
          const read = runInPage<string | null>(
            contents as never,
            (input: { selectors: string[] }) => {
              for (const selector of input.selectors) {
                let element: Element | null = null;
                try {
                  element = document.querySelector(selector);
                } catch {
                  // An unsupported selector (`:has()` on an old engine) is
                  // skipped rather than aborting the whole read.
                  continue;
                }
                if (!element) continue;
                const parts = [
                  element.textContent ?? "",
                  element.getAttribute("aria-label") ?? "",
                  element.getAttribute("alt") ?? "",
                  element.getAttribute("title") ?? "",
                  element.getAttribute("href") ?? "",
                ];
                const nested = element.querySelector("img");
                if (nested) parts.push(nested.getAttribute("alt") ?? "");
                return parts.join(" ").trim();
              }
              return "";
            },
            { selectors },
          );

          const settled = await atMost(read, IDENTITY_READ_BUDGET_MS);
          if (settled === "timeout") {
            readTimedOut = true;
            log.warn("Gave up reading the signed-in account from the page", {
              workspaceId: entry.id,
              platform: adapter.platform,
              budgetMs: IDENTITY_READ_BUDGET_MS,
            });
            return "";
          }
          return settled;
        } catch (error) {
          log.warn("Could not read the signed-in account from the page", {
            workspaceId: entry.id,
            ...errorFields(error),
          });
          // A page that cannot be read is not a page that named an account.
          return "";
        }
      },
    });

    // A read that ran out of time is not a network that moved its markup, and
    // saying so would send the next person hunting for a selector that is
    // fine. The operator sees this text verbatim, so it has to be true.
    if (readTimedOut && !identity.accountHandle) {
      identity.handleUnknown =
        "The page was too busy to say which account is signed in. It will be read again shortly.";
    }

    // Remember the handle only. `authenticated` and the account id stay live.
    const remember: CachedHandle = {
      accountHandle: identity.accountHandle,
      handleSource: identity.handleSource,
      handleUnknown: identity.handleUnknown,
    };
    handles.set(key, accountId, remember);

    return identity;
  }

  async function sessionStatus(
    workspaceId: string,
    platform?: string,
  ): Promise<SessionSnapshot> {
    const entry = await directory.resolve(workspaceId);
    if (!entry) {
      return {
        authenticated: false,
        detail: `The shell does not know a workspace called "${workspaceId}".`,
      };
    }

    // A workspace has a primary network, but one identity can hold accounts on
    // several. Each network is read on its own: a session on one is no
    // evidence at all about another.
    const wanted = platform ?? entry.platform;
    const adapter = adapterFor(wanted);
    if (!adapter) {
      return {
        authenticated: false,
        detail: `No adapter for ${wanted}; this shell cannot read that network's session.`,
      };
    }

    try {
      const result = await signedIn(entry, adapter);

      // Who is signed in is derived from the session or not reported at all.
      // `entry.accountHandle` is a label the operator typed once and is
      // deliberately not consulted: presenting it as the signed-in account is
      // how this shell came to tell its owner he was posting from an account
      // that had never existed.
      const identity = result.authenticated
        ? await whoIsSignedIn(entry, adapter)
        : {};

      return {
        authenticated: result.authenticated,
        ...identity,
        detail: result.detail,
      };
    } catch (error) {
      log.error("Session check failed", { workspaceId, ...errorFields(error) });
      return {
        authenticated: false,
        detail: `Could not read this workspace's session: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  async function attempt(
    input: PublishRequestInput,
    entry: WorkspaceEntry,
    adapter: PlatformAdapter,
  ): Promise<PublishOutcome> {
    // Checked before a window is opened, because a failure here means nothing
    // was posted and should cost nothing.
    const media = resolveApprovedMedia({ dataDir, media: input.media });
    if (!media.ok) {
      return { kind: "rejected", detail: media.detail, status: 409 };
    }

    const identity = identityForEntry(entry);
    const context = contextFor(identity);

    const window = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        session: context,
        // No preload: a network page must never see window.marqueeShell.
        preload: undefined,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        // An invisible window is still doing real work; Chromium must not
        // throttle its timers mid-post.
        backgroundThrottling: false,
      },
    });

    try {
      // Setup on its own clock. A slow cold start delays the post; it must not
      // eat the window in which the post is confirmed.
      const setupStarted = Date.now();
      await atMost(
        applyEmulation(window.webContents, identity),
        SETUP_BUDGET_MS,
      );
      const loaded = await atMost(
        window.loadURL(adapter.composeUrl).then(() => "loaded" as const),
        Math.max(1_000, SETUP_BUDGET_MS - (Date.now() - setupStarted)),
      );
      const setupMs = Date.now() - setupStarted;

      if (loaded === "timeout") {
        // Not fatal, and deliberately not treated as one: the page is probably
        // still arriving and the flow polls for the composer regardless.
        log.warn("Composer page still loading; starting the flow anyway", {
          workspaceId: input.workspaceId,
          draftId: input.draftId,
          setupMs,
        });
      }

      // Struck here, after the page is up, rather than before setup ran.
      const deadline = Date.now() + COMPOSE_BUDGET_MS;

      // Which composer the network will serve, decided by the profile this
      // workspace runs under rather than by preference.
      const device = deviceClassFor(entry.profile?.userAgent);

      return await adapter.submit({
        device,
        ...(entry.profile?.name ? { profileName: entry.profile.name } : {}),
        contents: window.webContents,
        body: input.body,
        media: media.paths,
        deadline,
        onPhase: (phaseName, ms, detail) => {
          log.info("Publish phase", {
            workspaceId: input.workspaceId,
            draftId: input.draftId,
            platform: input.platform,
            phase: phaseName,
            ms,
            setupMs,
            ...detail,
          });
        },
      });
    } catch (error) {
      log.error("Publish attempt threw", {
        workspaceId: input.workspaceId,
        draftId: input.draftId,
        ...errorFields(error),
      });
      // The composer may or may not have accepted the post before this threw,
      // so this attempt is not retried automatically.
      return unconfirmedOutcome(
        `The publish attempt failed part-way: ${
          error instanceof Error ? error.message : String(error)
        }. Check the account before approving a resend.`,
      );
    } finally {
      detachEmulation(window.webContents);
      if (!window.isDestroyed()) window.destroy();
    }
  }

  /**
   * Live sign-in.
   *
   * Every account this app can post from is signed in here, by hand, in the
   * network's own page — inside the workspace's isolated jar and behind its UA
   * profile. That is the whole authentication story: no password is typed into
   * this app, no OAuth token is minted for a server to hold, and nothing is
   * stored anywhere but the session Chromium keeps for that workspace.
   *
   * Consequences worth stating plainly, because they are load-bearing:
   *
   *  - It happens in the workspace's own tab, in front of the operator.
   *    Publishing uses a hidden window because no human is there; a sign-in
   *    exists precisely so a human can act, and it belongs on the tab strip
   *    beside the network it signs into.
   *  - No preload runs in it, so the login page cannot see this app.
   *  - The shell never reads, fills, or intercepts the form. It has no reason
   *    to know the password, and code that could learn it is code that could
   *    leak it.
   *  - Success is not declared here. It is read back from the cookie jar by
   *    `sessionStatus`, so a closed window never turns into a false badge.
   */
  async function beginSignIn(
    workspaceId: string,
    platform?: string,
  ): Promise<SignInInvitation> {
    const entry = await directory.resolve(workspaceId);
    if (!entry) {
      return {
        opened: false,
        alreadySignedIn: false,
        detail: `The shell does not know a workspace called "${workspaceId}".`,
      };
    }

    // Signing in to a second network inside the same workspace is a normal
    // thing to want: the identity is the workspace, and the accounts hang off
    // it. The tab is the workspace's either way, so the session stays isolated.
    const wanted = platform ?? entry.platform;
    const adapter = adapterFor(wanted);
    if (!adapter) {
      return {
        opened: false,
        alreadySignedIn: false,
        detail: `No adapter for ${wanted}; this shell does not know where that network's sign-in lives.`,
      };
    }

    // Cookie-detectable networks can answer this without opening anything.
    if (adapter.detection.kind === "cookie") {
      const existing = await signedIn(entry, adapter);
      if (existing.authenticated) {
        return {
          opened: false,
          alreadySignedIn: true,
          detail: `This workspace is already signed in to ${adapter.label}.`,
        };
      }
    }

    try {
      // The tab carries this workspace's session and UA profile because it is
      // opened under the same identity every other view of this workspace uses.
      await tabs.openOrFocus(workspaceId, adapter.signInUrl);

      // Whoever was signed in here may not be in a moment. Drop the
      // remembered handle so the next status read goes back to the session
      // rather than repeating a name that is about to be replaced.
      handles.invalidate(identityCacheKey(workspaceId, adapter.platform));
    } catch (error) {
      log.error("Sign-in tab failed to open", { workspaceId, ...errorFields(error) });
      return {
        opened: false,
        alreadySignedIn: false,
        detail: `Could not open ${adapter.label}'s sign-in page: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }

    log.info("Opened a live sign-in tab", { workspaceId, platform: wanted });

    return {
      opened: true,
      alreadySignedIn: false,
      detail:
        `Sign in to ${adapter.label} in this workspace's tab. It runs in the workspace's own session ` +
        `and UA profile, so the account stays separate from every other workspace.`,
    };
  }

  async function publish(input: PublishRequestInput): Promise<PublishOutcome> {
    return ledger.run(
      input.idempotencyKey,
      { draftId: input.draftId, platform: input.platform },
      async () => {
        const entry = await directory.resolve(input.workspaceId);
        if (!entry) {
          return {
            kind: "rejected" as const,
            detail: `The shell does not know a workspace called "${input.workspaceId}".`,
            status: 404,
          };
        }

        const adapter = adapterFor(input.platform);
        if (!adapter) {
          return {
            kind: "rejected" as const,
            detail: `No publisher adapter for ${input.platform}.`,
            status: 501,
          };
        }

        const session = await signedIn(entry, adapter);
        if (!session.authenticated) {
          return { kind: "unauthenticated" as const, detail: session.detail };
        }

        log.info("Publishing through the workspace session", {
          workspaceId: input.workspaceId,
          draftId: input.draftId,
          platform: input.platform,
        });

        return attempt(input, entry, adapter);
      },
    );
  }

  /**
   * Destroys one network's session inside a workspace.
   *
   * The counterpart to `beginSignIn`, and the thing whose absence meant
   * "removing" an account only removed a label while the cookie jar — and
   * therefore the account a post would go out from — stayed exactly as it was.
   *
   * Scoped to the network's own origin so a workspace holding several accounts
   * does not lose all of them at once, and **verified**: the session is read
   * back afterwards, and success is whatever that read says rather than
   * whatever the removal loop hoped.
   */
  async function signOut(
    workspaceId: string,
    platform?: string,
  ): Promise<{ signedOut: boolean; detail: string }> {
    const entry = await directory.resolve(workspaceId);
    if (!entry) {
      return {
        signedOut: false,
        detail: `The shell does not know a workspace called "${workspaceId}".`,
      };
    }

    const wanted = platform ?? entry.platform;
    const adapter = adapterFor(wanted);
    if (!adapter) {
      return {
        signedOut: false,
        detail: `No adapter for ${wanted}; this shell does not know where that network keeps its session.`,
      };
    }

    const context = contextFor(identityForEntry(entry));

    try {
      const report = await clearNetworkCookies(adapter.origin, {
        cookiesFor: (url) => context.cookies.get({ url }),
        remove: (url, name) => context.cookies.remove(url, name),
      });

      // The remembered handle belongs to an account that may no longer be
      // here. Drop it before the check, so the check cannot read a cached one.
      handles.invalidate(identityCacheKey(entry.id, adapter.platform));

      // The only thing that decides success.
      const after = await signedIn(entry, adapter);
      const outcome = describeSignOut(adapter.label, report, after.authenticated);

      log.info("Sign-out attempted", {
        workspaceId,
        platform: adapter.platform,
        found: report.found,
        removed: report.removed,
        failed: report.failed.length,
        signedOut: outcome.signedOut,
      });

      return outcome;
    } catch (error) {
      log.error("Sign-out failed", { workspaceId, ...errorFields(error) });
      return {
        signedOut: false,
        detail: `Could not sign this workspace out of ${adapter.label}: ${
          error instanceof Error ? error.message : String(error)
        }. Treat the account as still signed in.`,
      };
    }
  }

  return { sessionStatus, publish, beginSignIn, signOut };
}
