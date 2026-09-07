import type { BrowserState } from './types';

/**
 * The state a fresh install boots with, and what "Reset to defaults" returns to.
 *
 * It is deliberately empty of anything that looks like a tenant. An earlier
 * version shipped a fictional operator, three fictional accounts, and sample
 * drafts here so the UI had something to show. That broke the project's own
 * rule against mock data in a way that reached a real audience: an operator
 * approved one of the sample drafts while the sample operator name was still
 * in Settings, published it from their real account, and the ledger recorded
 * the sign-off under a person who does not exist. Approvals are snapshots of
 * who signed at the time, so no later rename could correct it — the only fix
 * was for the fiction never to have been there.
 *
 * UA profiles stay. They are declared device configurations (real browser
 * strings, visible in the toolbar), not identities, and a workspace needs one
 * to exist before it can be created.
 */
export const initialState: BrowserState = {
  version: 1,
  activeWorkspaceId: '',
  workspaces: [],
  uaProfiles: [
    {
      id: 'ua-mac',
      name: 'Chrome · macOS',
      platform: 'macOS 15',
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
      viewport: '1440 × 900',
      locale: 'en-US',
      timezone: 'America/New_York',
      clientHints: true,
      color: '#7c5cff',
    },
    {
      id: 'ua-windows',
      name: 'Chrome · Windows',
      platform: 'Windows 11',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
      viewport: '1536 × 864',
      locale: 'en-US',
      timezone: 'America/New_York',
      clientHints: true,
      color: '#40d9a0',
    },
    {
      id: 'ua-iphone',
      name: 'Safari · iPhone 16',
      platform: 'iOS 18',
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
      viewport: '393 × 852',
      locale: 'en-US',
      timezone: 'America/Los_Angeles',
      clientHints: false,
      color: '#ff8d69',
    },
    {
      id: 'ua-android',
      name: 'Chrome · Pixel 9',
      platform: 'Android 15',
      userAgent:
        'Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36',
      viewport: '412 × 915',
      locale: 'en-US',
      timezone: 'America/Chicago',
      clientHints: true,
      color: '#4bb3fd',
    },
  ],
  drafts: [],
  accounts: [],
  activity: [],
  settings: {
    theme: 'dark',
    // Empty on purpose: the review queue refuses to approve until a real name
    // is here, because this string is what the ledger records as the signer.
    operatorName: '',
    confirmBeforePublish: true,
    storeAiPrompts: false,
    model: 'GLM-4-32B',
    provider: 'pin',
    publish: {
      // The route that shipped. Switching to `api` is the operator's call, and
      // defaulting to it would change how existing posts leave without asking.
      mode: 'session',
      metaPageId: '',
      instagramUserId: '',
      threadsUserId: '',
    },
  },
  usage: { inputTokens: 0, outputTokens: 0, requests: 0 },
  updatedAt: new Date().toISOString(),
};
