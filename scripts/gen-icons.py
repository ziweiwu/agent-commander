#!/usr/bin/env python3
"""The app icon, drawn rather than designed.

Three lanes on a dark ground — the forest view's own motif — in the graphite
scheme's three status colours, with the waiting lane's mark at the right-hand
edge because "which agent needs you" is the icon-sized version of the whole
app. Standard library only, so regenerating it needs nothing installed.

Writes src/web/public/assets/icon-192.png and icon-512.png. Both are committed;
this script exists so a palette change can regenerate them honestly.
"""

import struct
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


def rounded(x: float, y: float) -> bool:
    """Inside the rounded square, coordinates in [0, 1]."""
    r = CORNER_RADIUS
    cx = min(max(x, r), 1 - r)
    cy = min(max(y, r), 1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r or (r <= x <= 1 - r) or (r <= y <= 1 - r)


def pixel(x: float, y: float) -> tuple[int, int, int, int]:
    if not rounded(x, y):
        return TRANSPARENT
    for top, bottom, right, colour in LANES:
        mid = (top + bottom) / 2
        if (x - right) ** 2 + (y - mid) ** 2 <= MARK_RADIUS**2:
            return (*colour, OPAQUE)
        if top <= y <= bottom and LANE_LEFT <= x <= right - MARK_RADIUS * BAR_TO_MARK_GAP:
            return (*colour, OPAQUE)
    return (*GROUND, OPAQUE)


def png(side: int) -> bytes:
    raw = bytearray()
    for j in range(side):
        raw.append(NO_FILTER)
        for i in range(side):
            raw.extend(pixel((i + PIXEL_CENTRE) / side, (j + PIXEL_CENTRE) / side))

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


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for side in SIZES:
        path = OUT_DIR / f"icon-{side}.png"
        path.write_bytes(png(side))
        print(f"wrote {path} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
