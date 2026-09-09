#!/usr/bin/env python3
"""
Renders the app icon from the mark's geometry.

Not part of the build. It exists so `icon.png` is reproducible rather than an
opaque binary somebody has to trust: the numbers below are the same ones in
`artifacts/studio/public/favicon.svg` and
`artifacts/studio/src/components/app/shell-mark.tsx`, and if the
mark ever changes this is how the icon follows it.

    python3 desktop/shell/assets/make-icon.py

Requires Pillow. Electron scales one large PNG down for the window and the
dock, so a single 1024px file is all that is committed.

Anti-aliasing is done by supersampling: Pillow draws hard-edged shapes, so
everything is rendered at 4x and resized down. Without that the ring looks
chewed at dock sizes.
"""

from __future__ import annotations

import pathlib

from PIL import Image, ImageDraw

# --- the mark, on the same 24-grid as the SVG ------------------------------

RING_CENTRE = (12.0, 12.0)
RING_RADIUS = 9.35
RING_WIDTH = 1.65

STEM_START = (12.0, 10.7)
STEM_CORNER = (12.0, 16.9)          # end of the straight run
STEM_CTRL = (12.0, 19.3)            # quadratic control point
STEM_END = (15.3, 19.1)             # the flick
STEM_WIDTH = 3.03

TITTLE_CENTRE = (12.0, 2.65)
TITTLE_RADIUS = 2.05

# --- the tile -------------------------------------------------------------

CANVAS = 180                        # the SVG's viewBox
CORNER_RADIUS = 40
GRID_OFFSET = 22                    # translate(22 22)
GRID_SCALE = 5.6667                 # scale(5.6667)

TILE_COLOUR = "#7149e9"             # --primary, light theme
MARK_COLOUR = "#ffffff"

SUPERSAMPLE = 4
SIZE = 1024


def main() -> None:
    f = (SIZE * SUPERSAMPLE) / CANVAS

    def at(point: tuple[float, float]) -> tuple[float, float]:
        """A point on the 24-grid, in device pixels."""
        return (
            (GRID_OFFSET + point[0] * GRID_SCALE) * f,
            (GRID_OFFSET + point[1] * GRID_SCALE) * f,
        )

    def thickness(width: float) -> int:
        return max(1, round(width * GRID_SCALE * f))

    side = SIZE * SUPERSAMPLE
    image = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    draw.rounded_rectangle(
        [(0, 0), (side - 1, side - 1)],
        radius=CORNER_RADIUS * f,
        fill=TILE_COLOUR,
    )

    # The ring.
    cx, cy = at(RING_CENTRE)
    r = RING_RADIUS * GRID_SCALE * f
    draw.ellipse(
        [(cx - r, cy - r), (cx + r, cy + r)],
        outline=MARK_COLOUR,
        width=thickness(RING_WIDTH),
    )

    # The stem: the straight run, then the flick sampled off the curve.
    points = [at(STEM_START), at(STEM_CORNER)]
    for i in range(1, 33):
        t = i / 32
        x = (
            (1 - t) ** 2 * STEM_CORNER[0]
            + 2 * (1 - t) * t * STEM_CTRL[0]
            + t**2 * STEM_END[0]
        )
        y = (
            (1 - t) ** 2 * STEM_CORNER[1]
            + 2 * (1 - t) * t * STEM_CTRL[1]
            + t**2 * STEM_END[1]
        )
        points.append(at((x, y)))

    stem_width = thickness(STEM_WIDTH)
    draw.line(points, fill=MARK_COLOUR, width=stem_width, joint="curve")

    # `stroke-linecap="round"`: Pillow's lines are butt-capped, so both ends
    # get a disc. Without this the stem reads as cut off at dock sizes.
    cap = stem_width / 2
    for end in (points[0], points[-1]):
        draw.ellipse(
            [(end[0] - cap, end[1] - cap), (end[0] + cap, end[1] + cap)],
            fill=MARK_COLOUR,
        )

    # The tittle.
    tx, ty = at(TITTLE_CENTRE)
    tr = TITTLE_RADIUS * GRID_SCALE * f
    draw.ellipse([(tx - tr, ty - tr), (tx + tr, ty + tr)], fill=MARK_COLOUR)

    out = pathlib.Path(__file__).with_name("icon.png")
    image.resize((SIZE, SIZE), Image.LANCZOS).save(out, "PNG")
    print(f"wrote {out} at {SIZE}x{SIZE}")


if __name__ == "__main__":
    main()
