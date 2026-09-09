/**
 * Which device a UA profile claims to be, and how big its screen is.
 *
 * This exists because a network's composer is not one thing. Instagram serves
 * a completely different set of screens to a phone than to a desktop — not a
 * restyled version of the same markup, but a different flow with different
 * elements, different controls and different URLs. An adapter written against
 * one of them cannot drive the other, and the thing that decides which one
 * arrives is the UA profile the workspace runs under.
 *
 * So the profile picks the graph. That is the whole idea here.
 *
 * There is a second, quieter problem this fixes. Every UA profile declares a
 * viewport — the iPhone profile says `393 × 852` — and until now nothing did
 * anything with it. The hidden publish window was hardcoded to 1280×900, so a
 * workspace running the iPhone profile sent a phone's user agent from a
 * desktop-sized window. That is an incoherent claim about the client, and it
 * is exactly the kind of mismatch a site keys layout decisions off.
 */

/**
 * The two shapes a composer graph can be written for.
 *
 * Two rather than four, because the four shipped profiles are two desktops and
 * two phones, and no evidence yet suggests iOS and Android are served
 * different composers. If one ever is, this is where the distinction goes.
 */
export type DeviceClass = "desktop" | "mobile";

export type Viewport = { width: number; height: number };

/**
 * The viewport a profile declares, as the UI writes it: `"393 × 852"`.
 *
 * Accepts the `×` the UI uses and a plain `x`, with or without spaces, because
 * this string is displayed to the operator and someone will eventually type it
 * by hand. Anything that is not two plausible dimensions returns `null` rather
 * than a guess — a made-up viewport is worse than the window's own default,
 * since it would be a claim about the client that nothing checked.
 */
export function parseViewport(raw: string | null | undefined): Viewport | null {
  if (!raw) return null;

  const match = raw.match(/^\s*(\d{2,5})\s*[×xX*]\s*(\d{2,5})\s*$/);
  if (!match) return null;

  const width = Number(match[1]);
  const height = Number(match[2]);

  // Below this nothing renders usefully, and above it nobody is claiming a
  // real device. Both bounds are deliberately generous.
  if (width < 240 || height < 240) return null;
  if (width > 7680 || height > 7680) return null;

  return { width, height };
}

/**
 * Whether a user agent is claiming to be a phone.
 *
 * Read from the UA string rather than taken from the profile's name, because
 * the string is what the network sees and the name is a label. `Mobile` is the
 * token both iOS Safari and Android Chrome carry; `iPhone`, `iPad` and
 * `Android` are checked too so a hand-written string without it still lands in
 * the right graph.
 *
 * `iPad` counts as mobile here, which is a judgement rather than a fact: a
 * tablet is sometimes served the desktop layout. No shipped profile is a
 * tablet, so nothing currently depends on it being right.
 */
export function deviceClassFor(userAgent: string | null | undefined): DeviceClass {
  if (!userAgent) return "desktop";
  return /\bMobile\b|\biPhone\b|\biPad\b|\bAndroid\b/i.test(userAgent)
    ? "mobile"
    : "desktop";
}

/**
 * The viewport to run a publish window at.
 *
 * The profile's declaration wins when it parses. Falling back to the window's
 * old hardcoded size keeps a profile with a malformed viewport working exactly
 * as it does today rather than breaking it.
 */
export const DEFAULT_PUBLISH_VIEWPORT: Viewport = { width: 1280, height: 900 };

export function publishViewportFor(
  declared: string | null | undefined,
): Viewport {
  return parseViewport(declared) ?? DEFAULT_PUBLISH_VIEWPORT;
}
