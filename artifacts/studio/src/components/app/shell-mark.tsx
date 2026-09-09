/**
 * The product mark.
 *
 * It replaces three coloured dots that used to sit here imitating macOS window
 * controls. They closed nothing, moved nothing, and invited a click that did
 * nothing — chrome pretending to be chrome. This app's whole argument is that
 * it does not pretend, so the decoration had to either become true or go.
 *
 * What it draws is a lowercase `i` inside a ring:
 *
 *  - the **stem** is upright, with the motion carried in a flick at its base.
 *    An earlier version bowed the whole stem instead, which stopped reading as
 *    a letter and started reading as a bracket — the curve has to be a gesture
 *    at the end of a stem, not the stem itself;
 *  - the **tittle** sits at the top of the ring and fuses with it. Its centre
 *    is exactly the ring's radius from the centre, so the join is true rather
 *    than eyeballed;
 *  - the **ring** is the workspace: one identity, closed, with everything that
 *    goes out passing through it.
 *
 * It is tinted with the active workspace's accent, which is the part that makes
 * it worth more than the dots it replaced. The colour is not decoration — it
 * answers *which signed-in identity am I about to act as*, the one question the
 * operator must never have to guess. With no workspace open there is no
 * identity to claim, so it falls back to the muted foreground.
 *
 * Geometry is static on a 24-grid. A mark is not a place for runtime maths: the
 * numbers were fitted once (stroke weights chosen so the stem still reads at
 * 16px, where a tapered or hairline mark disappears) and then frozen.
 */

type ShellMarkProps = {
  /** The active workspace's accent. Absent when no workspace is open. */
  accent?: string;
  className?: string;
};

export function ShellMark({ accent, className }: ShellMarkProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      role="img"
      aria-label="marquee"
      style={{ color: accent ?? 'hsl(var(--muted-foreground))' }}
    >
      {/* The workspace: one identity, closed. */}
      <circle
        cx="12"
        cy="12"
        r="9.35"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.65"
      />
      {/* The stem: upright, with the gesture in a flick off its base. */}
      <path
        d="M12 10.7 L12 16.9 Q12 19.3 15.3 19.1"
        fill="none"
        stroke="currentColor"
        strokeWidth="3.03"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* The tittle, fused into the top of the ring. */}
      <circle cx="12" cy="2.65" r="2.05" fill="currentColor" />
    </svg>
  );
}
