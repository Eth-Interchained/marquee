/**
 * Two ways a post can leave this app, and which one a given post may take.
 *
 * Until now there was one route: drive the operator's own signed-in session in
 * the workspace surface. That route is the reason the product exists — it is
 * how a human posts as themselves — but it is not the only sanctioned one, and
 * for the three Meta networks it is not the one Meta designates.
 *
 * So there are two MODES, and this module decides which are open:
 *
 *  - `session` — the existing route. The post is handed to the signed-in
 *    workspace surface and a human sends it. Works on every network, needs no
 *    credentials, and carries the operator's own account risk.
 *
 *  - `api` — the sanctioned route, where the network publishes one. Returns a
 *    real post id instead of a DOM guess, can be scheduled server-side without
 *    the app running, and puts no automation fingerprint on the account.
 *
 * These are MODES, NOT A FORK. One product, one composer, one review queue.
 * The mode decides the transport at the end, and nothing upstream of publish
 * needs to know which one was chosen.
 *
 * WHAT THIS MODULE IS FOR: the API mode has preconditions the session mode
 * does not, and discovering them at publish time is the worst place to find
 * out. Instagram will not take a text-only post at all. Facebook's API cannot
 * post to a personal profile. Instagram's API needs a professional account and
 * fetches media from a public URL rather than accepting an upload. Each of
 * those is a real reason a post cannot go, and each should be readable in the
 * composer before the operator commits to a mode.
 *
 * THE RULE THIS FOLLOWS, AND WHERE IT INVERTS AN EARLIER ONE.
 *
 * `model-picker.ts` holds "a missing field never hides a model" — being shown
 * a model that then fails is a smaller harm than being shown nothing. That
 * calculus does NOT carry here, and the difference is worth stating because
 * the two modules look alike. Picking a model that fails costs one retry.
 * A post that fails at publish time, or worse half-publishes, costs the
 * operator a scheduled slot and their confidence in the queue. So here an
 * unmet precondition BLOCKS the mode and says why, rather than being waved
 * through on the chance it works out.
 */

import type { Platform } from '@/types';

export type PublishMode = 'session' | 'api';

/**
 * What a network's sanctioned publishing API can and cannot do.
 *
 * NOT YET VERIFIED AGAINST LIVE DOCS. Meta's developer documentation is a
 * JavaScript shell that neither a fetch nor a crawler can read, so every field
 * below is written from working knowledge and MUST be confirmed against
 * developers.facebook.com before the transport layer is built on it. They are
 * gathered in this one table precisely so that confirmation is a single edit
 * and the tests around the decision logic keep holding either way.
 */
export type ApiSurface = {
  /** The vendor relationship this surface comes with. */
  family: string;
  /** Can it publish a post carrying no media at all? */
  textOnly: boolean;
  /** Does the API refuse a personal (non-professional) account? */
  requiresProfessionalAccount: boolean;
  /** Does publishing target a Page rather than a profile? */
  requiresPage: boolean;
  /** How media reaches the network when the post carries any. */
  mediaTransport: 'public-url' | 'resumable-upload' | 'none';
  /** The permission the app must hold, subject to App Review. */
  permission: string;
  /** Does this surface log in separately from the rest of its family? */
  separateLogin: boolean;
  /**
   * The server environment variable holding this surface's access token.
   *
   * Named here so Settings can tell the operator what to set without the
   * value ever entering the app. Renderer state is exportable; a token in it
   * would be a token in someone's Downloads folder.
   */
  tokenEnvVar: string;
};

/** Where the media host's key is read from. Same reasoning: env, not state. */
export const MEDIA_HOST_ENV = 'IMGBB_API_KEY';

/**
 * The networks with an API mode.
 *
 * Only three, and they are the three Meta grants together — which is the whole
 * argument for going this way. Note the ordering of usefulness is the opposite
 * of the obvious one: Threads is text-native at 500 characters and is the best
 * fit for what this composer produces, Facebook Pages takes text fine, and
 * Instagram — the surface anyone would reach for the API to fix — is the worst
 * fit of the three because Instagram has no text-only post to publish.
 *
 * Every other network keeps the session mode alone. That is not a gap to fill
 * later; for most of them no usable publishing API exists to fill it with.
 */
const API_SURFACES: Partial<Record<Platform, ApiSurface>> = {
  threads: {
    family: 'Meta',
    textOnly: true,
    requiresProfessionalAccount: false,
    requiresPage: false,
    mediaTransport: 'public-url',
    permission: 'threads_content_publish',
    // Threads logs in on its own, separate from the Facebook/Instagram token,
    // even though it is the same developer account. "One Meta login" would
    // oversell it.
    separateLogin: true,
    tokenEnvVar: 'THREADS_ACCESS_TOKEN',
  },
  facebook: {
    family: 'Meta',
    textOnly: true,
    requiresProfessionalAccount: false,
    // Personal-profile publishing is not available through the API. If the
    // operator wants to post as themselves rather than as a Page, the session
    // mode is the only route and this is not a limitation we can engineer past.
    requiresPage: true,
    mediaTransport: 'public-url',
    permission: 'pages_manage_posts',
    separateLogin: false,
    tokenEnvVar: 'META_PAGE_ACCESS_TOKEN',
  },
  instagram: {
    family: 'Meta',
    // The single most consequential fact in this table.
    textOnly: false,
    requiresProfessionalAccount: true,
    requiresPage: false,
    // Images cannot be uploaded to the API directly — Meta is handed a URL and
    // fetches it. That is why a media host is a hard requirement here and not
    // a convenience.
    mediaTransport: 'public-url',
    permission: 'instagram_content_publish',
    separateLogin: false,
    // Instagram publishes through the linked Page's token, so this is
    // deliberately the same variable as Facebook rather than a second one.
    tokenEnvVar: 'META_PAGE_ACCESS_TOKEN',
  },
};

export function apiSurface(platform: Platform): ApiSurface | null {
  return API_SURFACES[platform] ?? null;
}

/** What the operator has set up, none of which includes a secret value. */
export type PublishConfig = {
  /** The Facebook/Instagram token is present server-side. */
  metaConnected: boolean;
  /** The Threads token is present server-side, separately. */
  threadsConnected: boolean;
  /** A Page has been chosen to publish as. */
  pageSelected: boolean;
  /** The linked Instagram account is a Business or Creator account. */
  professionalAccount: boolean;
  /** A media host is configured, so an image can be given a public URL. */
  mediaHostConfigured: boolean;
};

/** The post as it stands, which decides what the route has to carry. */
export type PostShape = {
  platform: Platform;
  hasMedia: boolean;
  /** Is that media already reachable at a public URL? */
  mediaHosted: boolean;
};

export type ModeAvailability = {
  mode: PublishMode;
  available: boolean;
  /** Why not, in words for the operator. Empty when available. */
  blockers: string[];
};

export type RouteDecision = {
  modes: ModeAvailability[];
  /** The mode this post would actually take, or null when neither is open. */
  chosen: PublishMode | null;
  /** One line, always populated, safe to render as-is. */
  summary: string;
};

/**
 * Reasons that stop a post regardless of mode.
 *
 * A platform truth is not a transport problem. Instagram has no text-only
 * post, so a caption with no image cannot go to Instagram by API, by session,
 * or by hand — and reporting that as "the API mode is unavailable" would send
 * the operator switching modes to fix something no mode fixes.
 */
function platformBlockers(post: PostShape): string[] {
  const blockers: string[] = [];
  if (post.platform === 'instagram' && !post.hasMedia) {
    blockers.push(
      'Instagram has no text-only post. Attach an image or video — this is a limit of the network, not of either publishing mode.',
    );
  }
  return blockers;
}

function apiBlockers(post: PostShape, config: PublishConfig): string[] {
  const surface = apiSurface(post.platform);
  if (!surface) {
    return [
      'This network has no sanctioned publishing API, so posts here go through your signed-in session.',
    ];
  }

  const blockers: string[] = [];

  const connected =
    post.platform === 'threads' ? config.threadsConnected : config.metaConnected;
  if (!connected) {
    blockers.push(
      surface.separateLogin
        ? `${surface.family} is connected, but Threads signs in separately. Connect Threads to publish here directly.`
        : `Connect ${surface.family} in Settings to publish here directly.`,
    );
  }

  if (surface.requiresPage && !config.pageSelected) {
    blockers.push(
      'Facebook’s API publishes as a Page, never as a personal profile. Choose a Page, or use the session mode to post as yourself.',
    );
  }

  if (surface.requiresProfessionalAccount && !config.professionalAccount) {
    blockers.push(
      'Instagram’s API only works with a Business or Creator account. A personal account has to use the session mode.',
    );
  }

  // Only worth raising once media is actually in play. Saying "no media host"
  // about a text post on Threads would be noise.
  if (
    post.hasMedia &&
    surface.mediaTransport === 'public-url' &&
    !post.mediaHosted
  ) {
    blockers.push(
      config.mediaHostConfigured
        ? 'The media needs uploading to the host first — the network fetches it from a public URL rather than accepting the file.'
        : 'No media host is configured. The network fetches media from a public URL, so images have to be hosted before they can be published.',
    );
  }

  return blockers;
}

function sessionBlockers(signedIn: boolean): string[] {
  return signedIn
    ? []
    : ['This workspace is not signed in to the network. Open the surface and sign in.'];
}

/**
 * Which modes are open for this post, and which one it would take.
 *
 * Pure. `preferred` is the operator's setting; it wins when it is open, and
 * the other mode is offered rather than silently substituted when it is not.
 * Substituting the transport under a post is exactly the kind of quiet
 * decision this app does not make.
 */
export function routeFor(
  post: PostShape,
  config: PublishConfig,
  session: { signedIn: boolean },
  preferred: PublishMode,
): RouteDecision {
  const shared = platformBlockers(post);

  const api: ModeAvailability = {
    mode: 'api',
    available: false,
    blockers: [...shared, ...apiBlockers(post, config)],
  };
  const sessionMode: ModeAvailability = {
    mode: 'session',
    available: false,
    blockers: [...shared, ...sessionBlockers(session.signedIn)],
  };
  api.available = api.blockers.length === 0;
  sessionMode.available = sessionMode.blockers.length === 0;

  const modes = [api, sessionMode];
  const byPreference =
    preferred === 'api' ? [api, sessionMode] : [sessionMode, api];
  const chosen = byPreference.find((entry) => entry.available)?.mode ?? null;

  return { modes, chosen, summary: summarise(post, chosen, preferred, shared) };
}

function summarise(
  post: PostShape,
  chosen: PublishMode | null,
  preferred: PublishMode,
  shared: string[],
): string {
  if (chosen === null) {
    // The platform-level reason is the useful one to lead with, because no
    // amount of configuring will move it.
    return shared[0] ?? 'This post cannot be published yet.';
  }
  if (chosen === preferred) {
    return chosen === 'api'
      ? 'Publishing directly through the network’s API. You will get a post id back.'
      : 'Publishing through your signed-in session, with your approval.';
  }
  return chosen === 'session'
    ? 'Direct publishing is not available for this post, so it will go through your signed-in session instead.'
    : 'Your session is not signed in, so this will publish directly through the network’s API instead.';
}

/** Every network that has an API mode at all, for Settings to enumerate. */
export function platformsWithApiMode(): Platform[] {
  return Object.keys(API_SURFACES) as Platform[];
}
