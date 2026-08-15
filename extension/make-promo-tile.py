#!/usr/bin/env python3
"""Generate the 440x280 Chrome Web Store small promo tile.

Chrome renders this tile small in store listings, so it is built for legibility
rather than detail: the brand mark, the product name, and one line of value
proposition. No screenshots and no dense text — both turn to noise when scaled.

Two deliberate choices:

* The logo is the shipped ``icons/icon128.png``, not a re-drawing of
  favicon.svg. An earlier version re-derived the mark from the SVG's rectangle
  geometry and produced a subtly wrong glyph; compositing the canonical asset
  removes that whole class of error.
* Background and type are rendered at 4x and downsampled (PIL draws hard-edged
  primitives that alias badly otherwise), but the icon is composited *after*
  the downsample. Scaling a 128px source up into the 4x canvas would blur it —
  this way it only ever scales down.

    python3 extension/make-promo-tile.py
"""

import os

from PIL import Image, ImageDraw, ImageFont

W, H = 440, 280
SS = 4  # supersample factor for background + text

EMERALD = (16, 185, 129)      # #10B981 — brand, matches manifest theme_color
BG_TOP = (11, 18, 32)         # #0B1220
BG_BOTTOM = (17, 28, 43)      # #111C2B
WHITE = (255, 255, 255)
MUTED = (156, 163, 175)       # #9CA3AF

FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT_REG = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"

HERE = os.path.dirname(os.path.abspath(__file__))
ICON = os.path.join(HERE, "icons", "icon128.png")
OUT = os.path.join(HERE, "promo-tile-440x280.png")

LOGO_PX = 96   # final on-tile size; downscale from the 128px source
LOGO_TOP = 30
NAME_Y = 148
TAG_Y = 200


def centered(d: ImageDraw.ImageDraw, y: int, text: str,
             font: ImageFont.FreeTypeFont, fill) -> None:
    left, _, right, _ = d.textbbox((0, 0), text, font=font)
    d.text(((W * SS - (right - left)) / 2 - left, y), text, font=font, fill=fill)


def main() -> None:
    img = Image.new("RGB", (W * SS, H * SS), BG_TOP)
    d = ImageDraw.Draw(img)

    # Vertical gradient — a flat dark field reads cheap; a subtle ramp adds depth.
    for row in range(H * SS):
        t = row / (H * SS - 1)
        d.line([(0, row), (W * SS, row)], fill=(
            round(BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t),
            round(BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t),
            round(BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t),
        ))

    # Emerald keyline along the bottom edge.
    d.rectangle([0, H * SS - 5 * SS, W * SS, H * SS], fill=EMERALD)

    centered(d, NAME_Y * SS, "Recrutas Auto-Fill",
             ImageFont.truetype(FONT_BOLD, 34 * SS), WHITE)
    centered(d, TAG_Y * SS, "One-click job applications",
             ImageFont.truetype(FONT_REG, 17 * SS), MUTED)

    tile = img.resize((W, H), Image.LANCZOS)

    # Composite the real icon at final resolution so it only ever scales down.
    logo = Image.open(ICON).convert("RGBA").resize((LOGO_PX, LOGO_PX), Image.LANCZOS)
    tile.paste(logo, ((W - LOGO_PX) // 2, LOGO_TOP), logo)

    tile.save(OUT, "PNG", optimize=True)
    print(f"wrote {OUT} ({os.path.getsize(OUT)} bytes)")


if __name__ == "__main__":
    main()
