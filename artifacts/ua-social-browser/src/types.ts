export type Section =
  | 'dashboard'
  | 'network'
  | 'composer'
  | 'drafts'
  | 'calendar'
  | 'accounts'
  | 'profiles'
  | 'usage'
  | 'settings';

/** X is the primary network; the rest are first-class but secondary. */
export type Platform =
  | 'x'
  | 'instagram'
  | 'facebook'
  | 'threads'
  | 'linkedin'
  | 'bluesky'
  | 'mastodon'
  | 'reddit'
  | 'tiktok'
  | 'youtube'
  | 'pinterest'
  | 'tumblr';

export interface UAProfile {
  id: string;
  name: string;
  platform: string;
  userAgent: string;
  viewport: string;
  locale: string;
  timezone: string;
  clientHints: boolean;
  color: string;
}

export interface Workspace {
  id: string;
  name: string;
  profileId: string;
  platform: Platform;
  accountHandle: string;
  status: 'ready' | 'attention' | 'offline';
  accent: string;
  lastActive: string;
}

export interface SocialAccount {
  id: string;
  workspaceId: string;
  platform: Platform;
  handle: string;
  displayName: string;
  connected: boolean;
  avatar: string;
}

/**
 * Lifecycle of a post.
 *
 * `draft`      — model output the operator kept, not yet signed off
 * `approved`   — a person approved it; it may now be sent
 * `scheduled`  — approved, with a time attached
 * `publishing` — handed to the workspace session, awaiting the platform
 * `published`  — the platform accepted it
 * `failed`     — the attempt failed; the reason is kept on the draft
 * `attested`   — the attempt failed, and the operator later found the post on
 *                the account and said so. Deliberately NOT `published`:
 *                `published` means the network confirmed it, and an operator's
 *                word is evidence of a different kind. See `lib/attestation.ts`.
 */
export type DraftStatus =
  | 'draft'
  | 'approved'
  | 'scheduled'
  | 'publishing'
  | 'published'
  | 'failed'
  | 'attested';

/**
 * An attachment, as the draft carries it.
 *
 * A reference, never the bytes. The whole browser state document is written on
 * every edit, so an image inside it would be rewritten on every keystroke and
 * kept forever by the append-only ledger. The file itself lives under the data
 * directory, addressed by the hash of its contents, and that hash is what lets
 * the shell prove the file it uploads is the file that was approved.
 */
export interface DraftMedia {
  /** `<sha256>/<filename>`; also the path segment for `/api/media/`. */
  id: string;
  sha256: string;
  filename: string;
  mimeType: string;
  bytes: number;
  altText?: string;
}

export interface Draft {
  id: string;
  workspaceId: string;
  platform: Platform;
  body: string;
  media: DraftMedia[];
  status: DraftStatus;
  scheduledFor: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  postUrl: string | null;
  lastError: string | null;
  /**
   * The operator's account of a post the network never confirmed.
   *
   * Set only on an `attested` draft, and never a substitute for the network's
   * own confirmation — it carries the name of whoever made the claim precisely
   * so a reader can tell the two apart. `lastError` is kept alongside it: the
   * record should say the confirmation never arrived *and* that the operator
   * later found the post, because that is what happened.
   */
  attestation?: {
    by: string;
    at: string;
    postUrl: string | null;
  } | null;
  /**
   * Where the text came from, when it came from one generation of options.
   *
   * Several drafts can be kept out of a single composer run, and by the time
   * they reach the queue nothing else records that they were alternatives to
   * each other rather than separate posts. That matters at the moment of
   * approval: clearing three of them sends one idea three times.
   *
   * Absent on anything hand-written — the Network page composes directly, and
   * a post with no siblings has no group to belong to.
   */
  origin?: {
    /** Shared by every draft kept out of the same generation. */
    generationId: string;
    /** The candidate's "Option N" at the time it was kept. */
    ordinal: number;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface Activity {
  id: string;
  title: string;
  detail: string;
  timestamp: string;
  type: 'ai' | 'draft' | 'workspace' | 'publish';
}

export interface BrowserState {
  version: number;
  activeWorkspaceId: string;
  workspaces: Workspace[];
  uaProfiles: UAProfile[];
  drafts: Draft[];
  accounts: SocialAccount[];
  activity: Activity[];
  settings: {
    theme: 'dark';
    /** Recorded as the approver on every post this browser sends. */
    operatorName: string;
    confirmBeforePublish: boolean;
    storeAiPrompts: boolean;
    model: string;
    provider: 'pin';
    /**
     * How posts leave this app.
     *
     * NO SECRETS LIVE HERE. This whole document is downloadable from
     * `/api/browser/export`, so an access token in it would be a token in the
     * operator's Downloads folder. Tokens and API keys are read from the
     * server's environment and never cross into renderer state; these are the
     * non-secret identifiers that say *which* Page or account to publish to.
     */
    publish: {
      /** The preferred transport. `session` keeps the behaviour that shipped. */
      mode: 'session' | 'api';
      /** The Facebook Page to publish as. Its API cannot post to a profile. */
      metaPageId: string;
      /** The Instagram professional account id. */
      instagramUserId: string;
      /** Threads signs in separately from the rest of Meta. */
      threadsUserId: string;
    };
  };
  usage: {
    inputTokens: number;
    outputTokens: number;
    requests: number;
  };
  updatedAt: string;
}
