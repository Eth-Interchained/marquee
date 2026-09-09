import type { DraftMedia, Platform } from '@/types';
import { platformProfile } from '@/lib/platforms';

/** Mirrors the server's list; refusing here saves a pointless round trip. */
const ACCEPTED_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/quicktime',
] as const;

export const MEDIA_ACCEPT_ATTRIBUTE = ACCEPTED_TYPES.join(',');

/** Matches `MAX_MEDIA_BYTES` in the API server's media store. */
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

export function isAcceptedMediaType(mimeType: string): boolean {
  return (ACCEPTED_TYPES as readonly string[]).includes(
    mimeType.split(';')[0]!.trim().toLowerCase(),
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Where the API server serves the stored bytes back for preview. */
export function mediaUrl(item: DraftMedia): string {
  return `/api/media/${item.id
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')}`;
}

export type AttachRefusal = { reason: string } | null;

/**
 * Why a file may not be attached, or `null` when it may.
 *
 * Checked before upload so the operator hears the actual limit — the network's
 * own cap, the size ceiling, an unsupported type — rather than watching a post
 * fail later for a reason the composer never explained.
 */
export function refuseAttachment(input: {
  platform: Platform;
  existing: readonly DraftMedia[];
  file: { type: string; size: number; name: string };
}): AttachRefusal {
  const network = platformProfile(input.platform);

  if (!isAcceptedMediaType(input.file.type)) {
    return {
      reason: `${input.file.name} is a ${input.file.type || 'file of unknown type'}. Attach a JPEG, PNG, GIF, WebP, MP4, or MOV.`,
    };
  }

  if (input.file.size === 0) {
    return { reason: `${input.file.name} is empty.` };
  }

  if (input.file.size > MAX_MEDIA_BYTES) {
    return {
      reason: `${input.file.name} is ${formatBytes(input.file.size)}; this build accepts up to ${formatBytes(MAX_MEDIA_BYTES)}.`,
    };
  }

  if (input.existing.length >= network.mediaLimit) {
    return {
      reason: `${network.label} takes at most ${network.mediaLimit} ${
        network.mediaLimit === 1 ? 'attachment' : 'attachments'
      } on a post.`,
    };
  }

  return null;
}

/**
 * The identity of a set of attachments.
 *
 * The same rule the API server applies when it checks a publish against the
 * approval: order counts because it is the order they post in, and alt text
 * counts because it is published content. Used here to notice that an edit
 * changed the post, which drops the sign-off.
 */
export function mediaFingerprint(media: readonly DraftMedia[] | undefined): string {
  if (!media || media.length === 0) return '';
  return media
    .map((item) => `${item.sha256}:${(item.altText ?? '').trim()}`)
    .join('|');
}

export async function uploadMedia(file: File): Promise<DraftMedia> {
  const response = await fetch('/api/media', {
    method: 'POST',
    headers: {
      'Content-Type': file.type,
      'x-filename': file.name,
    },
    body: file,
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: string }
      | null;
    throw new Error(payload?.error ?? `${file.name} could not be stored.`);
  }

  const payload = (await response.json()) as { media: DraftMedia };
  return payload.media;
}
