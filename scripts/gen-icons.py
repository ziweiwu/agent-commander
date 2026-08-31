#!/usr/bin/env python3
"""The app icon, drawn rather than designed.

Three lanes on a dark ground — the forest view's own motif — in the graphite
scheme's three status colours, with the waiting lane's mark at the right-hand
edge because "which agent needs you" is the icon-sized version of the whole
app. Standard library only, so regenerating it needs nothing installed.

Two outputs, from one drawing:

  (no arguments)   writes src/web/public/assets/icon-192.png and icon-512.png,
                   the PWA icons. Both are committed; this script exists so a
                   palette change can regenerate them honestly.
  --iconset DIR    writes a macOS .iconset, for `iconutil -c icns`. Not
                   committed: its only consumer is the .app bundle, whose build
                   script regenerates it every time.
  --stdout SIDE    writes one PNG to stdout, for the test that keeps the
                   committed pair honest against this file.

The macOS variant differs in two ways, and both are about sitting correctly in
a Dock beside other icons rather than about the drawing:

  * It is **inset** to Apple's grid — an 824-in-1024 body with a transparent
    margin. The web icon is full-bleed, which in a Dock renders visibly *larger*
    than every neighbour. That is a size mismatch, and more noticeable than any
    shape mismatch.
  * Its outline is a **superellipse**, not a circular-corner rounded square.
    Apple's shape has continuous curvature; in a per-pixel sampler that is one
    line, and simpler than the rounded-rect it replaces.

There is deliberately no drop shadow, which Apple's own template does carry.
Adding one is the point where "drawn rather than designed" would stop being true.

Every parameter added for the macOS path defaults to the web behaviour, so the
committed PNGs are untouched by construction — and `test/mac-app.test.ts` holds
this file to that rather than trusting it.
"""

import struct
import sys
import zlib
from pathlib import Path

GROUND = (0x15, 0x17, 0x1A)  # --bg, graphite dark
WAITING = (0xC7, 0x99, 0x45)  # --waiting
BUSY = (0x66, 0xA5, 0xE5)  # --busy
IDLE = (0x90, 0x94, 0x99)  # --idle

OUT_DIR = Path(__file__).resolve().parent.parent / "src" / "web" / "public" / "assets"

OPAQUE = 255
TRANSPARENT = (0, 0, 0, 0)
# The bar stops short of its own mark by this many radii, leaving a visible gap.
BAR_TO_MARK_GAP = 1.6
# Sample at each pixel's centre rather than its corner.
PIXEL_CENTRE = 0.5
CRC_MASK = 0xFFFFFFFF
BIT_DEPTH = 8
COLOUR_TYPE_RGBA = 6
NO_FILTER = 0
BEST_COMPRESSION = 9
SIZES = (192, 512)

# Each lane: (top, bottom, right edge, colour), in fractions of the side.
# The waiting lane reaches the "now" edge; the others stop short of it.
LANES = [
    (0.22, 0.32, 0.88, WAITING),
    (0.45, 0.55, 0.66, BUSY),
    (0.68, 0.78, 0.47, IDLE),
]
LANE_LEFT = 0.12
MARK_RADIUS = 0.055
CORNER_RADIUS = 0.18

# --- the macOS variant ---

# Apple's icon grid: an 824-wide body centred in a 1024-wide canvas.
#
# Both of these numbers are measured rather than cited. Rendered at 256 and
# compared against Notes.app's own icon, this body is 206x206 with 25px margins
# on every side — the same, to the pixel. And with the exponent at 5 the corner
# profile tracks Apple's within one pixel the whole way down the curve. 4 is
# visibly squarer, 6 visibly rounder.
MACOS_BODY = 824 / 1024
MACOS_MARGIN = (1 - MACOS_BODY) / 2
SUPERELLIPSE_N = 5.0
# Ten .iconset files, but only seven distinct renders: every @2x is its 1x twin
# at the next size up.
MACOS_SIZES = (16, 32, 64, 128, 256, 512, 1024)
ICONSET_NAMES = {
    16: ("icon_16x16.png",),
    32: ("icon_16x16@2x.png", "icon_32x32.png"),
    64: ("icon_32x32@2x.png",),
    128: ("icon_128x128.png",),
    256: ("icon_128x128@2x.png", "icon_256x256.png"),
    512: ("icon_256x256@2x.png", "icon_512x512.png"),
    1024: ("icon_512x512@2x.png",),
}
# A hard-edged sampler is invisible at 192 and 512 and unusable at 16, where a
# squircle's corners stair-step across a third of the icon. Cost is O(factor²),
# so the small sizes — where it matters — are also the cheap ones.
FINE_SUPERSAMPLE = 4
COARSE_SUPERSAMPLE = 2
SUPERSAMPLE_FINE_UPTO = 256


def rounded(x: float, y: float) -> bool:
    """Inside the rounded square, coordinates in [0, 1]."""
    r = CORNER_RADIUS
    cx = min(max(x, r), 1 - r)
    cy = min(max(y, r), 1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r or (r <= x <= 1 - r) or (r <= y <= 1 - r)


def superellipse(x: float, y: float) -> bool:
    """Inside the Apple-style squircle, coordinates in [0, 1]."""
    return abs(2 * x - 1) ** SUPERELLIPSE_N + abs(2 * y - 1) ** SUPERELLIPSE_N <= 1


def pixel(x: float, y: float, inset: float = 0.0, shape=rounded) -> tuple[int, int, int, int]:
    """One sample. `x` and `y` are canvas coordinates in [0, 1].

    `inset` is the transparent margin on each side; the drawing is scaled into
    what is left, so the lanes shrink with the body rather than being cropped.
    """
    if inset:
        span = 1 - 2 * inset
        x = (x - inset) / span
        y = (y - inset) / span
        if not (0 <= x <= 1 and 0 <= y <= 1):
            return TRANSPARENT
    if not shape(x, y):
        return TRANSPARENT
    for top, bottom, right, colour in LANES:
        mid = (top + bottom) / 2
        if (x - right) ** 2 + (y - mid) ** 2 <= MARK_RADIUS**2:
            return (*colour, OPAQUE)
        if top <= y <= bottom and LANE_LEFT <= x <= right - MARK_RADIUS * BAR_TO_MARK_GAP:
            return (*colour, OPAQUE)
    return (*GROUND, OPAQUE)


def sample(i: int, j: int, side: int, factor: int, **shape) -> tuple[int, int, int, int]:
    """One output pixel, averaged over `factor`² samples.

    Averaged in premultiplied alpha: a transparent sample is (0,0,0,0), so
    averaging its colour channels straight would drag every edge pixel towards
    black and ring the icon in a dark fringe.
    """
    if factor == 1:
        return pixel((i + PIXEL_CENTRE) / side, (j + PIXEL_CENTRE) / side, **shape)
    weighted = [0, 0, 0]
    alpha = 0
    for sy in range(factor):
        for sx in range(factor):
            x = (i + (sx + PIXEL_CENTRE) / factor) / side
            y = (j + (sy + PIXEL_CENTRE) / factor) / side
            *colour, a = pixel(x, y, **shape)
            for channel in range(len(weighted)):
                weighted[channel] += colour[channel] * a
            alpha += a
    if alpha == 0:
        return TRANSPARENT
    return (*(round(c / alpha) for c in weighted), round(alpha / (factor * factor)))


def png(side: int, factor: int = 1, **shape) -> bytes:
    raw = bytearray()
    for j in range(side):
        raw.append(NO_FILTER)
        for i in range(side):
            raw.extend(sample(i, j, side, factor, **shape))

    def chunk(kind: bytes, body: bytes) -> bytes:
        return (
            struct.pack(">I", len(body))
            + kind
            + body
            + struct.pack(">I", zlib.crc32(kind + body) & CRC_MASK)
        )

    header = struct.pack(">IIBBBBB", side, side, BIT_DEPTH, COLOUR_TYPE_RGBA, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(bytes(raw), BEST_COMPRESSION))
        + chunk(b"IEND", b"")
    )


def macos_png(side: int) -> bytes:
    factor = FINE_SUPERSAMPLE if side <= SUPERSAMPLE_FINE_UPTO else COARSE_SUPERSAMPLE
    return png(side, factor, inset=MACOS_MARGIN, shape=superellipse)


def write_iconset(out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    for side in MACOS_SIZES:
        rendered = macos_png(side)
        for name in ICONSET_NAMES[side]:
            (out / name).write_bytes(rendered)


def value_after(flag: str) -> str:
    """The argument following `flag`, or exit with what was expected."""
    argv = sys.argv
    if flag not in argv or argv.index(flag) + 1 >= len(argv):
        sys.exit(f"{flag} needs a value")
    return argv[argv.index(flag) + 1]


def main() -> None:
    if "--iconset" in sys.argv:
        write_iconset(Path(value_after("--iconset")))
        return
    # Raw bytes to stdout rather than to a file, so the test comparing this
    # generator against the committed PNGs never has to write anywhere.
    if "--stdout" in sys.argv:
        sys.stdout.buffer.write(png(int(value_after("--stdout"))))
        return

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for side in SIZES:
        path = OUT_DIR / f"icon-{side}.png"
        path.write_bytes(png(side))
        print(f"wrote {path} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
