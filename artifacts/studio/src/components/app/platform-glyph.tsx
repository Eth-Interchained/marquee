import { cn } from '@/lib/utils';
import { platformProfile } from '@/lib/platforms';
import type { Platform } from '@/types';

export function PlatformGlyph({
  platform,
  className,
  tinted = false,
}: {
  platform: Platform;
  className?: string;
  /** Render in the network's own brand colour instead of inheriting. */
  tinted?: boolean;
}) {
  const profile = platformProfile(platform);
  const Glyph = profile.icon;
  return (
    <Glyph
      className={cn('h-4 w-4', className)}
      style={tinted ? { color: profile.accent } : undefined}
      aria-hidden="true"
    />
  );
}
