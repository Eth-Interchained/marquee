import {
  SiBluesky,
  SiFacebook,
  SiInstagram,
  SiMastodon,
  SiPinterest,
  SiReddit,
  SiThreads,
  SiTiktok,
  SiTumblr,
  SiX,
  SiYoutube,
} from 'react-icons/si';
import { FaLinkedin } from 'react-icons/fa6';
import type { IconType } from 'react-icons';

import type { Platform } from '@/types';

export type PlatformProfile = {
  id: Platform;
  label: string;
  icon: IconType;
  accent: string;
  /** Where the workspace surface points when the network view opens. */
  feedUrl: string;
  /** Deep link to the platform's own composer, used as the manual fallback. */
  composeUrl: string;
  notificationsUrl: string | null;
  charLimit: number;
  mediaLimit: number;
  supportsThread: boolean;
  supportsAltText: boolean;
  /** Platforms that reject text-only posts. */
  requiresMedia: boolean;
  /** Short, honest note about how posting works on this network. */
  note: string;
};

const PROFILES: Record<Platform, PlatformProfile> = {
  x: {
    id: 'x',
    label: 'X',
    icon: SiX,
    accent: '#e7e9ea',
    feedUrl: 'https://x.com/home',
    composeUrl: 'https://x.com/compose/post',
    notificationsUrl: 'https://x.com/notifications',
    charLimit: 280,
    mediaLimit: 4,
    supportsThread: true,
    supportsAltText: true,
    requiresMedia: false,
    note: 'Primary network. Posts and threads are submitted from your signed-in session.',
  },
  instagram: {
    id: 'instagram',
    label: 'Instagram',
    icon: SiInstagram,
    accent: '#e1306c',
    feedUrl: 'https://www.instagram.com/',
    composeUrl: 'https://www.instagram.com/create/style/',
    notificationsUrl: 'https://www.instagram.com/notifications/',
    charLimit: 2200,
    mediaLimit: 10,
    supportsThread: false,
    supportsAltText: true,
    requiresMedia: true,
    note: 'Every post needs at least one image or video. Captions are drafted here, media is attached in the surface.',
  },
  facebook: {
    id: 'facebook',
    label: 'Facebook',
    icon: SiFacebook,
    accent: '#1877f2',
    feedUrl: 'https://www.facebook.com/',
    composeUrl: 'https://www.facebook.com/',
    notificationsUrl: 'https://www.facebook.com/notifications',
    charLimit: 63206,
    mediaLimit: 10,
    supportsThread: false,
    supportsAltText: true,
    requiresMedia: false,
    note: 'Posts go to the profile or page selected inside the workspace session.',
  },
  threads: {
    id: 'threads',
    label: 'Threads',
    icon: SiThreads,
    accent: '#f5f5f5',
    feedUrl: 'https://www.threads.net/',
    composeUrl: 'https://www.threads.net/',
    notificationsUrl: 'https://www.threads.net/activity',
    charLimit: 500,
    mediaLimit: 10,
    supportsThread: true,
    supportsAltText: true,
    requiresMedia: false,
    note: 'Shares the Instagram identity of the workspace session.',
  },
  linkedin: {
    id: 'linkedin',
    label: 'LinkedIn',
    icon: FaLinkedin,
    accent: '#0a66c2',
    feedUrl: 'https://www.linkedin.com/feed/',
    composeUrl: 'https://www.linkedin.com/feed/?shareActive=true',
    notificationsUrl: 'https://www.linkedin.com/notifications/',
    charLimit: 3000,
    mediaLimit: 9,
    supportsThread: false,
    supportsAltText: true,
    requiresMedia: false,
    note: 'Long-form friendly. The first two lines carry the post.',
  },
  bluesky: {
    id: 'bluesky',
    label: 'Bluesky',
    icon: SiBluesky,
    accent: '#0085ff',
    feedUrl: 'https://bsky.app/',
    composeUrl: 'https://bsky.app/',
    notificationsUrl: 'https://bsky.app/notifications',
    charLimit: 300,
    mediaLimit: 4,
    supportsThread: true,
    supportsAltText: true,
    requiresMedia: false,
    note: 'AT Protocol. The workspace session holds the app password or OAuth session.',
  },
  mastodon: {
    id: 'mastodon',
    label: 'Mastodon',
    icon: SiMastodon,
    accent: '#6364ff',
    feedUrl: 'https://mastodon.social/home',
    composeUrl: 'https://mastodon.social/publish',
    notificationsUrl: 'https://mastodon.social/notifications',
    charLimit: 500,
    mediaLimit: 4,
    supportsThread: true,
    supportsAltText: true,
    requiresMedia: false,
    note: 'Instance-specific. Set the workspace home URL to your own instance.',
  },
  reddit: {
    id: 'reddit',
    label: 'Reddit',
    icon: SiReddit,
    accent: '#ff4500',
    feedUrl: 'https://www.reddit.com/',
    composeUrl: 'https://www.reddit.com/submit',
    notificationsUrl: 'https://www.reddit.com/notifications',
    charLimit: 40000,
    mediaLimit: 20,
    supportsThread: false,
    supportsAltText: false,
    requiresMedia: false,
    note: 'Community rules differ per subreddit. Read them before posting the same text twice.',
  },
  tiktok: {
    id: 'tiktok',
    label: 'TikTok',
    icon: SiTiktok,
    accent: '#ff0050',
    feedUrl: 'https://www.tiktok.com/foryou',
    composeUrl: 'https://www.tiktok.com/tiktokstudio/upload',
    notificationsUrl: 'https://www.tiktok.com/notifications',
    charLimit: 2200,
    mediaLimit: 1,
    supportsThread: false,
    supportsAltText: false,
    requiresMedia: true,
    note: 'Video only. Captions and hooks are drafted here; the upload happens in the surface.',
  },
  youtube: {
    id: 'youtube',
    label: 'YouTube',
    icon: SiYoutube,
    accent: '#ff0000',
    feedUrl: 'https://studio.youtube.com/',
    composeUrl: 'https://studio.youtube.com/channel/UC/videos/upload',
    notificationsUrl: 'https://studio.youtube.com/',
    charLimit: 5000,
    mediaLimit: 1,
    supportsThread: false,
    supportsAltText: false,
    requiresMedia: true,
    note: 'Descriptions and community posts. Uploads run through Studio in the surface.',
  },
  pinterest: {
    id: 'pinterest',
    label: 'Pinterest',
    icon: SiPinterest,
    accent: '#e60023',
    feedUrl: 'https://www.pinterest.com/',
    composeUrl: 'https://www.pinterest.com/pin-builder/',
    notificationsUrl: 'https://www.pinterest.com/',
    charLimit: 500,
    mediaLimit: 1,
    supportsThread: false,
    supportsAltText: true,
    requiresMedia: true,
    note: 'Pins need an image and a destination link.',
  },
  tumblr: {
    id: 'tumblr',
    label: 'Tumblr',
    icon: SiTumblr,
    accent: '#00cf35',
    feedUrl: 'https://www.tumblr.com/dashboard',
    composeUrl: 'https://www.tumblr.com/new/text',
    notificationsUrl: 'https://www.tumblr.com/notifications',
    charLimit: 4096,
    mediaLimit: 10,
    supportsThread: false,
    supportsAltText: true,
    requiresMedia: false,
    note: 'Tags do the discovery work here, not hashtags in the body.',
  },
};

/** X first: it is the network this browser is built around. */
export const PLATFORMS: Platform[] = [
  'x',
  'instagram',
  'facebook',
  'threads',
  'linkedin',
  'bluesky',
  'mastodon',
  'reddit',
  'tiktok',
  'youtube',
  'pinterest',
  'tumblr',
];

export function platformProfile(platform: Platform): PlatformProfile {
  return PROFILES[platform];
}

export const PLATFORM_LABEL: Record<Platform, string> = Object.fromEntries(
  PLATFORMS.map((id) => [id, PROFILES[id].label]),
) as Record<Platform, string>;

export const PLATFORM_LIMIT: Record<Platform, number> = Object.fromEntries(
  PLATFORMS.map((id) => [id, PROFILES[id].charLimit]),
) as Record<Platform, number>;

export const PLATFORM_ORIGIN: Record<Platform, string> = Object.fromEntries(
  PLATFORMS.map((id) => [id, PROFILES[id].feedUrl]),
) as Record<Platform, string>;
