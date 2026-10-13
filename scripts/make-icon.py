#!/usr/bin/env python3
"""Generates the FireIO launcher tile.

The launcher renders app tiles in 16:9, not square — a square icon just gets
letterboxed with dead bars either side. So the artwork IS 16:9, laid out as a
lockup: mark on the left, wordmark to its right.

The mark reconstructs the supplied logo: a rounded play triangle in light
cyan, with a darker blue "P" hook (left stem + upper bowl) overlaid on it, on
the supplied dark navy. If you drop the original PNG at
    StremioVega/assets/image/logo.png
this script uses that file verbatim instead of redrawing it — always prefer
the real asset over this approximation.

Run from anywhere (needs Pillow and the DejaVu fonts):
    python3 scripts/make-icon.py
"""
import os

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

TILE_W, TILE_H = 1280, 720
SS = 2  # supersample factor; drawn at 2x and downsampled
W, H = TILE_W * SS, TILE_H * SS

FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOGO_OVERRIDE = os.path.join(REPO, "assets", "image", "logo.png")
OUT = os.path.join(REPO, "assets", "image", "icon.png")

# Supplied background swatch.
NAVY = (6, 19, 47)
# Sampled from the supplied mark.
BLUE_TOP = (30, 126, 214)
BLUE_BOTTOM = (10, 82, 200)
CYAN_TOP = (86, 210, 245)
CYAN_BOTTOM = (56, 190, 238)
WORDMARK_ACCENT = (86, 200, 244)


def rounded_mask(w, h, radius):
    m = Image.new("L", (w, h), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, w - 1, h - 1], radius=radius, fill=255)
    return m


def vertical_gradient(w, h, top, bottom):
    g = Image.new("RGB", (1, h))
    for y in range(h):
        t = y / max(1, h - 1)
        g.putpixel((0, y), tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return g.resize((w, h), Image.BILINEAR)


def soften(mask, radius, cut=138):
    """Rounds a polygon's corners: blur to round the vertices, threshold to
    snap the soft edge back to a crisp silhouette, then a hair of blur again
    purely for antialiasing."""
    m = mask.filter(ImageFilter.GaussianBlur(radius))
    m = m.point(lambda v: 255 if v > cut else 0)
    return m.filter(ImageFilter.GaussianBlur(max(1, radius * 0.07)))


def build_mark(size):
    """Redraws the logo at size x size, transparent background."""
    s = size
    u = s / 1000.0  # everything below is expressed against a 1000px design grid

    # --- light cyan play triangle (the full play shape) ---------------------
    tri = Image.new("L", (s, s), 0)
    ImageDraw.Draw(tri).polygon(
        [(300 * u, 120 * u), (300 * u, 880 * u), (880 * u, 500 * u)], fill=255
    )
    tri = soften(tri, 70 * u)

    # --- dark blue "P" hook: left stem + upper bowl -------------------------
    stem = Image.new("L", (s, s), 0)
    ImageDraw.Draw(stem).rounded_rectangle(
        [140 * u, 120 * u, 400 * u, 880 * u], radius=130 * u, fill=255
    )

    bowl = Image.new("L", (s, s), 0)
    ImageDraw.Draw(bowl).polygon(
        # Upper half of the play shape — its lower-right edge is the straight
        # diagonal where the blue gives way to the cyan.
        [(250 * u, 120 * u), (700 * u, 400 * u), (250 * u, 690 * u)], fill=255
    )
    bowl = soften(bowl, 70 * u)

    # Union via `lighter`, NOT paste-with-alpha: pasting composites the
    # bowl's soft antialiased edge on top of the stem, which leaves a visible
    # seam line where the two overlap. Taking the per-pixel max merges them
    # into one silhouette with no internal edge at all.
    hook = ImageChops.lighter(stem, bowl)

    # --- compose ------------------------------------------------------------
    mark = Image.new("RGBA", (s, s), (0, 0, 0, 0))

    cyan = vertical_gradient(s, s, CYAN_TOP, CYAN_BOTTOM).convert("RGBA")
    cyan.putalpha(tri)
    mark = Image.alpha_composite(mark, cyan)

    blue = vertical_gradient(s, s, BLUE_TOP, BLUE_BOTTOM).convert("RGBA")
    blue.putalpha(hook)
    mark = Image.alpha_composite(mark, blue)
    return mark


# --- tile -------------------------------------------------------------------
tile = Image.new("RGBA", (W, H), NAVY + (255,))

mark_size = int(H * 0.62)
if os.path.exists(LOGO_OVERRIDE):
    mark = Image.open(LOGO_OVERRIDE).convert("RGBA").resize((mark_size, mark_size), Image.LANCZOS)
    print("using supplied logo:", LOGO_OVERRIDE)
else:
    mark = build_mark(mark_size * SS).resize((mark_size, mark_size), Image.LANCZOS)
    print("using reconstructed mark (drop a PNG at %s to override)" % LOGO_OVERRIDE)

mark_x = int(W * 0.17)
mark_y = (H - mark_size) // 2
tile.alpha_composite(mark, (mark_x, mark_y))

# --- wordmark ---------------------------------------------------------------
# "Fire" in white, "IO" in the logo's cyan — the split gives the name some
# structure at a glance instead of one flat run of letters.
label = Image.new("RGBA", (W, H), (0, 0, 0, 0))
ld = ImageDraw.Draw(label)
font = ImageFont.truetype(FONT_PATH, int(H * 0.19))
text_x = mark_x + mark_size + int(W * 0.035)
fire_w = ld.textlength("Fire", font=font)
baseline = H // 2 - int(H * 0.128)
ld.text((text_x, baseline), "Fire", font=font, fill=(255, 255, 255, 255))
ld.text((text_x + fire_w, baseline), "IO", font=font, fill=WORDMARK_ACCENT + (255,))
tile = Image.alpha_composite(tile, label)

# --- finish -----------------------------------------------------------------
tile.putalpha(rounded_mask(W, H, int(H * 0.075)))
icon = tile.resize((TILE_W, TILE_H), Image.LANCZOS)
icon.save(OUT, "PNG")
print("wrote", OUT, icon.size)
