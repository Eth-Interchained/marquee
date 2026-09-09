/**
 * Destroying a network's session inside a workspace.
 *
 * Until now nothing in this codebase could remove a cookie. "Removing" an
 * account on the Accounts page filtered a row out of the browser state
 * document and touched nothing else, which meant:
 *
 *  - the cookie jar still held the previous account's session;
 *  - registering a different handle in that workspace reused the same jar, and
 *    the session check answered "authenticated" — truthfully about the jar,
 *    misleadingly about the name beside it;
 *  - and because a draft carries a workspace and a platform but no account,
 *    publishing goes through that jar. An approved post could leave from an
 *    account nobody intended.
 *
 * That is the failure this whole area of the code exists to prevent, arriving
 * through the one door that had no lock on it.
 *
 * Two rules shape what is here.
 *
 * **Scoped to one network.** A workspace is one identity that may hold
 * accounts on several networks, and each is its own session (invariant 7).
 * Signing out of X must not sign the operator out of Instagram, so this
 * removes the cookies of one origin rather than emptying the partition.
 *
 * **Verified, not asserted.** A sign-out that reports success without checking
 * is the same class of lie as a post reported without confirmation. The caller
 * re-reads the session afterwards and only claims the account is gone when the
 * check agrees.
 */

/** The parts of an Electron cookie this needs. */
export type CookieLike = {
  name: string;
  domain?: string;
  path?: string;
  secure?: boolean;
};

/**
 * The URL a cookie must be removed with.
 *
 * `cookies.remove(url, name)` matches on the URL's host and path, so removing
 * by the network's origin alone silently misses two common cases: a cookie set
 * on a parent domain (`.instagram.com`) and one set on a path other than `/`.
 * Both would survive the "sign-out" and keep the session alive, which is
 * exactly the bug being fixed — so the URL is rebuilt from each cookie's own
 * domain and path rather than from the origin.
 *
 * A leading dot means "this domain and its subdomains"; it is not part of the
 * host and has to come off.
 */
export function removalUrlFor(cookie: CookieLike): string | null {
  const host = (cookie.domain ?? "").replace(/^\./, "").trim();
  if (host === "") return null;

  const path = cookie.path && cookie.path.startsWith("/") ? cookie.path : "/";
  // A `Secure` cookie is only addressable over https; a plain one is reachable
  // either way, and http is the safer assumption for a host that may not
  // answer TLS on this exact path.
  const scheme = cookie.secure ? "https" : "http";
  return `${scheme}://${host}${path}`;
}

/** What clearing needs from Electron, kept as a port so it is testable. */
export type SignOutSources = {
  /** Cookies the partition would send to this origin. */
  cookiesFor(url: string): Promise<CookieLike[]>;
  /** Removes one cookie. Rejecting is reported, never swallowed. */
  remove(url: string, name: string): Promise<void>;
};

export type SignOutReport = {
  /** How many cookies the jar held for this network before anything was done. */
  found: number;
  removed: number;
  /** Names that could not be removed, with why. Never silently dropped. */
  failed: Array<{ name: string; reason: string }>;
};

/**
 * Removes every cookie this partition holds for one network's origin.
 *
 * Reports what happened rather than throwing on a partial result: the caller
 * verifies by re-reading the session, and a count of what was attempted is
 * what makes a failed verification diagnosable.
 */
export async function clearNetworkCookies(
  origin: string,
  sources: SignOutSources,
): Promise<SignOutReport> {
  const cookies = await sources.cookiesFor(origin);
  const report: SignOutReport = { found: cookies.length, removed: 0, failed: [] };

  for (const cookie of cookies) {
    const url = removalUrlFor(cookie);
    if (!url) {
      report.failed.push({
        name: cookie.name,
        reason: "the cookie reported no domain, so there is no URL to remove it with",
      });
      continue;
    }

    try {
      await sources.remove(url, cookie.name);
      report.removed += 1;
    } catch (error) {
      report.failed.push({
        name: cookie.name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return report;
}

/**
 * What to tell the operator, given what was cleared and what the session says
 * afterwards.
 *
 * `stillAuthenticated` is the only thing that decides success. The counts are
 * for diagnosis: a jar that reported nothing to remove and still reads signed
 * in means the session lives somewhere cookies cannot reach, which is a
 * different problem and should not be described as a completed sign-out.
 */
export function describeSignOut(
  label: string,
  report: SignOutReport,
  stillAuthenticated: boolean,
): { signedOut: boolean; detail: string } {
  if (!stillAuthenticated) {
    if (report.found === 0) {
      return {
        signedOut: true,
        detail: `This workspace held no ${label} session to sign out of.`,
      };
    }
    return {
      signedOut: true,
      detail: `Signed out of ${label} in this workspace: ${report.removed} cookie${
        report.removed === 1 ? "" : "s"
      } removed, and the session now reads signed out.`,
    };
  }

  if (report.found === 0) {
    return {
      signedOut: false,
      detail: `${label} still reads signed in, but this workspace's cookie jar held nothing for it — the session is being kept somewhere cookies cannot reach. Open the workspace tab and sign out there.`,
    };
  }

  const failures = report.failed.length
    ? ` ${report.failed.length} could not be removed: ${report.failed
        .map((f) => `${f.name} (${f.reason})`)
        .join("; ")}.`
    : "";

  return {
    signedOut: false,
    detail: `Tried to sign out of ${label} — ${report.removed} of ${report.found} cookies removed — but the session still reads signed in.${failures} Do not treat this account as signed out: a post approved here would still go out from it.`,
  };
}
