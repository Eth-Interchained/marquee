/**
 * A mark per model provider.
 *
 * Fifty-seven models in a scrolling list is a wall of text, and the provider
 * is the fastest way to tell one wall from another — you know whether you want
 * Claude or your own box before you know which Claude. So each provider gets a
 * glyph and a colour, and the row you are looking for is findable by shape.
 *
 * These are ORIGINAL geometric marks, not the vendors' trademarked logos:
 * simple forms in each brand's accent colour, drawn here rather than fetched.
 * That keeps the app offline-clean (no remote image per row), keeps the bundle
 * flat, and avoids shipping someone else's asset. They are recognisable by
 * colour and silhouette without pretending to be official artwork.
 *
 * PIN is the exception and deliberately so: it is the operator's own network,
 * it gets the product's own ring-and-stem mark, and it reads as "mine" rather
 * than as one vendor among five.
 */

import type { ReactElement } from 'react';

import { cn } from '@/lib/utils';

type MarkProps = { className?: string };

/** The operator's own network. Echoes `ShellMark` — the product's own form. */
function PinMark({ className }: MarkProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <circle
        cx="12"
        cy="13"
        r="8"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M12 11.5 L12 16.5 Q12 18.4 14.6 18.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
      <circle cx="12" cy="5.4" r="1.9" fill="currentColor" />
    </svg>
  );
}

/** Anthropic: an upward burst. */
function AnthropicMark({ className }: MarkProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        d="M12 3 L18.5 21 H15 L12 12 L9 21 H5.5 Z"
        fill="currentColor"
      />
    </svg>
  );
}

/** OpenAI: an interlocked six-fold knot, reduced to a hexagonal weave. */
function OpenAiMark({ className }: MarkProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        d="M12 2.5 L20 7 L20 17 L12 21.5 L4 17 L4 7 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
      />
      <circle cx="12" cy="12" r="3" fill="currentColor" />
    </svg>
  );
}

/** Gemini: a four-point star. */
function GeminiMark({ className }: MarkProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        d="M12 2 Q13.4 9 21 12 Q13.4 15 12 22 Q10.6 15 3 12 Q10.6 9 12 2 Z"
        fill="currentColor"
      />
    </svg>
  );
}

/** Groq: a fast-forward chevron pair — the one that sells itself on speed. */
function GroqMark({ className }: MarkProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M4 5 L12 12 L4 19 Z" fill="currentColor" />
      <path d="M12 5 L20 12 L12 19 Z" fill="currentColor" opacity="0.55" />
    </svg>
  );
}

/** Anything the app has not been taught: a neutral disc, never a blank gap. */
function UnknownMark({ className }: MarkProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <circle
        cx="12"
        cy="12"
        r="7.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeDasharray="3 2.5"
      />
    </svg>
  );
}

const MARKS: Record<
  string,
  { Mark: (props: MarkProps) => ReactElement; tint: string }
> = {
  pin: { Mark: PinMark, tint: 'text-primary' },
  anthropic: { Mark: AnthropicMark, tint: 'text-[#d97757]' },
  openai: { Mark: OpenAiMark, tint: 'text-[#10a37f]' },
  gemini: { Mark: GeminiMark, tint: 'text-[#4285f4]' },
  groq: { Mark: GroqMark, tint: 'text-[#f55036]' },
};

export function ProviderMark({
  provider,
  className,
}: {
  provider: string | undefined;
  className?: string;
}) {
  const entry = provider ? MARKS[provider] : undefined;
  const Mark = entry?.Mark ?? UnknownMark;
  return (
    <Mark
      className={cn(
        'shrink-0',
        entry?.tint ?? 'text-muted-foreground',
        className,
      )}
    />
  );
}
