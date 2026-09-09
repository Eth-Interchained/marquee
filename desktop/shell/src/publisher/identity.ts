/**
 * Who is actually signed in.
 *
 * Until now the answer came from `workspace.accountHandle` — a string typed
 * once and stored, which the shell passed back and the UI printed as
 * "Signed in as @…". That is a claim about someone's account made from a label
 * nobody checked, and it was wrong on the owner's own machine: a workspace
 * still carrying a handle from an old seed reported an account that does not
 * exist while a different account was signed in. A wrong name next to a green
 * tick is worse than no name, because it answers the one question the operator
 * must never be unsure about.
 *
 * So identity is derived from the session, or not reported.
 *
 * Two independent sources, because they answer different questions:
 *
 *  - **The cookie jar** gives a stable account *id* on the networks that keep
 *    one there (X's `twid`, Instagram's `ds_user_id`, Facebook's `c_user`). It
 *    is proof that this partition belongs to one specific account, available
 *    without loading anything — but it is a number, not a name.
 *  - **A live page** gives the handle. The workspace's network view is already
 *    loaded and already signed in, so the name is read from the page the
 *    operator is looking at rather than by calling a private API or minting a
 *    token. No extra request, no bearer, nothing to keep in sync.
 *
 * Neither is guessed. When the handle cannot be read the answer is "unknown",
 * and the UI says so.
 */

/** How one network exposes who is signed in. */
export type IdentityConfig = {
  /**
   * A cookie carrying a stable account id, and how to get the id out of it.
   * X stores `u%3D<id>`; most others store the id bare.
   */
  idCookie?: { name: string; pattern?: string };
  /**
   * Where the handle appears on the network's own signed-in page.
   *
   * Several selectors, tried in order: products rename a class far more often
   * than they stop showing the operator their own name somewhere.
   *
   * SELECTORS ARE PRODUCT KNOWLEDGE AND UNVERIFIED, like the composer ones. A
   * miss must read as "unknown", never as a wrong name.
   */
  handle?: { selectors: string[]; pattern?: string };
};

export type ResolvedIdentity = {
  /** Verified from the partition's own cookies. A number, not a name. */
  accountId?: string;
  /** Verified by reading the network's signed-in page. */
  accountHandle?: string;
  /**
   * Where the handle came from. Only ever `"session"` — the field exists so a
   * caller cannot mistake an absent handle for a stored one, and so a future
   * source has to name itself rather than being silently trusted.
   */
  handleSource?: "session";
  /** Why the handle is missing, when it is. Shown to the operator verbatim. */
  handleUnknown?: string;
};

/** The default shape of a handle: `@` plus the usual conservative charset. */
const DEFAULT_HANDLE_PATTERN = "@([A-Za-z0-9._-]{1,64})";

/**
 * Pulls an account id out of a cookie value.
 *
 * Cookie values arrive percent-encoded and sometimes quoted, so both are
 * undone before matching. Anything that does not match is discarded rather
 * than passed along: a half-parsed id is not an id.
 */
export function parseAccountId(
  raw: string | undefined,
  pattern?: string,
): string | undefined {
  if (!raw) return undefined;

  let value = raw.trim().replace(/^"|"$/g, "");
  try {
    value = decodeURIComponent(value);
  } catch {
    // A malformed escape is not worth failing over; match the raw value.
  }

  if (!pattern) {
    return /^[0-9]{1,32}$/.test(value) ? value : undefined;
  }

  const match = value.match(new RegExp(pattern));
  const id = match?.[1] ?? undefined;
  return id && id.trim() !== "" ? id : undefined;
}

/**
 * Pulls a handle out of text taken from the signed-in page.
 *
 * Deliberately strict. The text handed in is whatever a selector matched, and
 * a page is full of other people's handles — so a value that does not look
 * like a handle produces nothing rather than a guess.
 */
export function extractHandle(
  text: string | undefined,
  pattern?: string,
): string | undefined {
  if (!text) return undefined;
  const match = text.match(new RegExp(pattern ?? DEFAULT_HANDLE_PATTERN));
  const handle = match?.[1];
  if (!handle) return undefined;
  // Strip a trailing separator picked up by a greedy charset (e.g. "@me.").
  const cleaned = handle.replace(/[._-]+$/, "");
  return cleaned === "" ? undefined : `@${cleaned}`;
}

/**
 * What `resolveIdentity` needs from the outside world.
 *
 * A port rather than a direct dependency so the resolution logic — which is
 * the part that decides what gets asserted about someone's account — is
 * testable without Electron, a display, or a real session.
 */
export type IdentitySources = {
  /** Cookie value from this workspace's partition, or undefined. */
  cookie(name: string): Promise<string | undefined>;
  /**
   * What the first match for any of `selectors` says about itself, read from a
   * live signed-in page in this workspace's partition.
   *
   * Text *and* the attributes that carry a name in practice — `aria-label`,
   * `alt`, `title`, `href` — because networks put the operator's own handle in
   * whichever of those suits their markup, and a text-only read would miss
   * Instagram entirely.
   *
   * `null` when no such page is loaded, which is different from a page that
   * has no match; the two are reported to the operator differently.
   */
  pageText(selectors: string[]): Promise<string | null>;
};

export async function resolveIdentity(
  config: IdentityConfig | undefined,
  sources: IdentitySources,
): Promise<ResolvedIdentity> {
  if (!config) {
    return {
      handleUnknown:
        "This shell does not know where that network shows the signed-in account.",
    };
  }

  const result: ResolvedIdentity = {};

  if (config.idCookie) {
    const raw = await sources.cookie(config.idCookie.name);
    const id = parseAccountId(raw, config.idCookie.pattern);
    if (id) result.accountId = id;
  }

  if (!config.handle) {
    result.handleUnknown =
      "This network does not show the signed-in account anywhere this shell can read.";
    return result;
  }

  const text = await sources.pageText(config.handle.selectors);

  if (text === null) {
    result.handleUnknown =
      "Open this workspace's network view and the signed-in account will be read from it.";
    return result;
  }

  const handle = extractHandle(text, config.handle.pattern);
  if (!handle) {
    result.handleUnknown =
      "The signed-in account could not be read from the page; the network has moved where it shows it.";
    return result;
  }

  result.accountHandle = handle;
  result.handleSource = "session";
  return result;
}
