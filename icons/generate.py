#!/usr/bin/env python3
"""Generate the Bucket List PWA icon set.

Draws a mountain-range glyph (matching the app's snow-capped-mountain favicon)
in the app's cream on the olive brand color. Everything is drawn at 8x and
downsampled so the edges are antialiased.

Run from anywhere:  python3 icons/generate.py   (requires Pillow)

Outputs land next to this file. The PNGs are committed, so this only needs
re-running if the mark itself changes.
"""
import os
from PIL import Image, ImageDraw

OUT = os.path.dirname(os.path.abspath(__file__))

OLIVE = (74, 83, 64)        # --olive
CREAM = (239, 236, 230)     # --bg
SAND = (181, 166, 136)      # --sand
TERRA = (160, 96, 58)       # --terra

SS = 8  # supersample factor


def draw_art(d, size, scale):
    """Draw the mountain glyph centered in a `size` box.

    `scale` shrinks the artwork about the center (used for the maskable icon,
    whose safe zone is only the inner 80%).
    """
    c = size / 2.0

    def p(x, y):
        """Map a 0..1 design coordinate into the (possibly scaled) icon box."""
        return (c + (x - 0.5) * size * scale, c + (y - 0.5) * size * scale)

    # Sun
    sr = 0.058
    sx, sy = 0.790, 0.250
    d.ellipse(
        [p(sx - sr, sy - sr), p(sx + sr, sy + sr)],
        fill=SAND,
    )

    # Back mountain — offset right so its peak clears the front one.
    d.polygon(
        [p(0.690, 0.390), p(0.985, 0.775), p(0.395, 0.775)],
        fill=(101, 111, 88),
    )
    d.polygon(
        [p(0.690, 0.390), p(0.760, 0.482), p(0.620, 0.482)],
        fill=(196, 199, 184),
    )

    # Front mountain (large, left of center)
    peak = (0.345, 0.235)
    d.polygon(
        [p(*peak), p(0.725, 0.775), p(-0.035, 0.775)],
        fill=CREAM,
    )

    # Snow cap: a clean zigzag hem across the top wedge of the front peak.
    d.polygon(
        [p(*peak), p(0.480, 0.427), p(0.412, 0.383),
         p(0.345, 0.440), p(0.278, 0.383), p(0.210, 0.427)],
        fill=(255, 255, 255),
    )

    # Ground line
    d.rectangle([p(-0.035, 0.775), p(0.985, 0.815)], fill=TERRA)


def make(size, scale=1.0, bg=OLIVE, path=None):
    big = size * SS
    img = Image.new("RGB", (big, big), bg)
    d = ImageDraw.Draw(img)
    draw_art(d, big, scale)
    img = img.resize((size, size), Image.LANCZOS)
    img.save(path, "PNG", optimize=True)
    print(f"  {os.path.basename(path)}  {size}x{size}")


print("Writing icons to", OUT)
# Standard (any-purpose) icons — artwork uses most of the canvas.
make(192, 0.86, path=os.path.join(OUT, "icon-192.png"))
make(512, 0.86, path=os.path.join(OUT, "icon-512.png"))
# Maskable — artwork stays inside the inner 80% safe zone so Android's
# adaptive-icon mask can never crop the peaks.
make(512, 0.62, path=os.path.join(OUT, "icon-maskable-512.png"))
# iOS home screen. iOS applies its own squircle mask, so keep it full bleed.
make(180, 0.84, path=os.path.join(OUT, "apple-touch-icon.png"))
# Browser tab.
make(32, 0.92, path=os.path.join(OUT, "favicon-32.png"))
make(16, 0.96, path=os.path.join(OUT, "favicon-16.png"))
