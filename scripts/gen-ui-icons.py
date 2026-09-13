#!/usr/bin/env python3
"""Generate the in-app icon set.

    python3 scripts/gen-ui-icons.py            # print the module
    python3 scripts/gen-ui-icons.py --write    # rewrite src/web/lib/icon-paths.ts

**Not to be confused with `gen-icons.py`, which is a different thing entirely.**
That one draws the *application* icon — the PWA PNGs and the macOS `.iconset`,
one picture of three lanes, guarded by `test/mac-app.test.ts`. This one draws
the fifteen small control faces *inside* the app. They share nothing but a
prefix, and the near-collision is worth naming here because it has already
caused one accident.

Why a generator for fifteen shapes, rather than a hand-kept map.

The app drew its controls with Unicode glyphs: the settings ellipsis from Math
Operators, the expand arrow from Miscellaneous Mathematical Symbols-B, the
disclosure triangles from Geometric Shapes, the tick from Dingbats, the gear
from Miscellaneous Symbols, the multiplication sign from Latin-1. Seven blocks,
seven foundries, seven ideas about stroke weight and where the baseline sits —
and the final rendering decided by whatever font the reader happens to have,
which on some platforms turns the gear and the tick into colour emoji.

A set cannot be made out of that. So the shapes are drawn here, on one grid at
one weight, and `test/icons.test.ts` re-runs this file and refuses a checkout
whose output has drifted. That is the contract `gen-themes.py` has with
`tokens.css` through `scheme.test.ts`, and it is this repo's existing answer to
"who keeps this honest": a hand-maintained `Record<IconName, ReactNode>` has
nobody.

The grid: 24x24, drawings kept inside a 3px margin so every icon carries the
same optical weight in the same box. Stroke 1.7, chosen against the app's 13px
body text — 1.4 disappears beside it, 2.4 competes with it.

What is deliberately *not* here: keycap legends. The terminal key bar, the
answer card and the help sheet draw arrows and a shift symbol that depict
physical keys rather than naming an app action, and those stay as characters.
An icon set is for controls; a keycap is a picture of a key.

Colour is never set. Every shape inherits `currentColor`, which is what lets
one set serve all sixteen palettes in both modes with no variants.
"""
from __future__ import annotations

import sys
from pathlib import Path

OUT = Path("src/web/lib/icon-paths.ts")

# The box, the weight, and the margin the drawings respect. Changing any of
# these changes every icon at once, which is the point of them living here.
VIEWBOX = 24
STROKE = 1.7

# name -> the SVG child elements, drawn on the 24x24 grid.
ICONS: dict[str, str] = {
    # Disclosure. One chevron rotated, so an open row and a closed row are
    # visibly the same control in two states rather than two different marks.
    "chevron-right": '<path d="M9.5 5.5 16 12l-6.5 6.5"/>',
    "chevron-down": '<path d="M5.5 9.5 12 16l6.5-6.5"/>',
    # The overflow menu. Three dots on the optical centre.
    "ellipsis": '<circle cx="5.2" cy="12" r="1.35"/><circle cx="12" cy="12" r="1.35"/>'
    '<circle cx="18.8" cy="12" r="1.35"/>',
    # Full screen: two arrows leaving a shared centre, which reads as "more
    # room" where a single diagonal reads as "resize".
    "expand": '<path d="M14 4h6v6M20 4l-7.2 7.2M10 20H4v-6M4 20l7.2-7.2"/>',
    # The fleet column, hidden and shown. The bar is the edge of the screen and
    # the arrow says which way the panel goes, so the pair is symmetrical.
    "panel-hide": '<path d="M20 4.5v15M15.5 12H5M9.2 7.8 5 12l4.2 4.2"/>',
    "panel-show": '<path d="M4 4.5v15M8.5 12H19M14.8 7.8 19 12l-4.2 4.2"/>',
    # Direction, for sorting and for paging a list — never for a key legend.
    "arrow-up": '<path d="M12 19.5V5M6.2 10.8 12 5l5.8 5.8"/>',
    "arrow-down": '<path d="M12 4.5V19M6.2 13.2 12 19l5.8-5.8"/>',
    "arrow-right": '<path d="M4.5 12h15M13.7 6.2 19.5 12l-5.8 5.8"/>',
    # Settled state.
    "check": '<path d="M5 12.8 9.4 17.2 19 6.6"/>',
    "close": '<path d="M6.2 6.2 17.8 17.8M17.8 6.2 6.2 17.8"/>',
    # Stop: a square, not an octagon. It ends something the user started, which
    # is a milder claim than a hazard sign.
    "stop": '<rect x="6.4" y="6.4" width="11.2" height="11.2" rx="2.4"/>',
    # Application settings, distinct from the per-agent overflow above.
    "gear": '<circle cx="12" cy="12" r="3.1"/>'
    '<path d="M12 3.4v2.3M12 18.3v2.3M20.6 12h-2.3M5.7 12H3.4'
    'M18.08 5.92l-1.63 1.63M7.55 16.45l-1.63 1.63'
    'M18.08 18.08l-1.63-1.63M7.55 7.55 5.92 5.92"/>',
    "help": '<circle cx="12" cy="12" r="8.4"/>'
    '<path d="M9.6 9.6a2.5 2.5 0 1 1 3.4 2.33c-.78.32-1 .84-1 1.57M12 16.9v.1"/>',
    # The notification bell, redrawn from the 20x20 one that used to live inside
    # NotifyButton so that it belongs to the same set as everything beside it.
    "bell": '<path d="M12 3.6a5 5 0 0 0-5 5v3.4L5.4 15.2v1.1h13.2v-1.1L17 12V8.6a5 5 0 0 0-5-5Z"/>'
    '<path d="M9.7 18.9a2.4 2.4 0 0 0 4.6 0"/>',
    # Off is the same bell struck through: the state has to be readable without
    # colour (INV-13).
    "bell-off": '<path d="M12 3.6a5 5 0 0 0-5 5v3.4L5.4 15.2v1.1h13.2v-1.1L17 12V8.6a5 5 0 0 0-5-5Z"/>'
    '<path d="M9.7 18.9a2.4 2.4 0 0 0 4.6 0"/><path d="M4.4 19.6 19.6 4.4"/>',
}

HEADER = """// Generated by scripts/gen-ui-icons.py -- do not edit.
//
//     python3 scripts/gen-ui-icons.py --write
//
// One grid and one stroke weight for every control face in the app. The shapes
// and the reasoning live in the generator; `test/icons.test.ts` re-runs it and
// fails a checkout where this file has drifted. Rendered by `ui/Icon.tsx`,
// which is the only thing that should import this.
//
// (`gen-icons.py`, without the `ui`, is a different script: it draws the
// application icon. See that file's docstring.)
"""


def render() -> str:
    lines = [HEADER, ""]
    lines.append(f"export const ICON_VIEWBOX = {VIEWBOX}")
    lines.append(f"export const ICON_STROKE = {STROKE}")
    lines.append("")
    lines.append("export const ICON_PATHS = {")
    for name, body in ICONS.items():
        lines.append(f"  '{name}':")
        lines.append(f"    '{body}',")
    lines.append("} as const")
    lines.append("")
    lines.append("export type IconName = keyof typeof ICON_PATHS")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    out = render()
    if "--write" in sys.argv:
        OUT.write_text(out, encoding="utf-8")
        print(f"wrote {OUT} ({len(ICONS)} icons)")
    else:
        sys.stdout.write(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
