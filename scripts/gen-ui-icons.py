#!/usr/bin/env python3
"""Generate the in-app icon set.

    python3 scripts/gen-ui-icons.py            # print the module
    python3 scripts/gen-ui-icons.py --write    # rewrite src/web/lib/icon-paths.ts

**Not to be confused with `gen-icons.py`, which is a different thing entirely.**
That one draws the *application* icon — the PWA PNGs and the macOS `.iconset`,
one picture of three lanes, guarded by `test/mac-app.test.ts`. This one draws
the small control faces *inside* the app. They share nothing but a
prefix, and the near-collision is worth naming here because it has already
caused one accident.

Why a generator for these shapes, rather than a hand-kept map.

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
same optical weight in the same box. Stroke 2.1, and that is heavier than a
first pass would choose.

Five complete sets were drawn against this brief and rasterised together at a
true 11px — strict-geometric, humanist, heavy, solid and duotone. 11px is where
the decision actually happens, because that is the size the status chips and
disclosure rows use, and four of the five fell apart there while looking fine
at 16. The geometric panel pair became one indistinguishable smudge; the
humanist gear collapsed into a mesh and the whole set went faint; the solid set
lost bell-off to a blob and its chevron read as a play button; the duotone stop
read as a record button. This one is the only set where all sixteen icons that
existed at the time survived, and a dashboard glanced at from across a room is
a legibility problem before it is a refinement problem. Anything added since
has been held to the same bar, one at a time — see `hand` below.

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
STROKE = 2.1

# name -> the SVG child elements, drawn on the 24x24 grid.
ICONS: dict[str, str] = {
    # Disclosure. One chevron rotated, so a closed row and an open row are
    # visibly the same control in two states.
    "chevron-right": '<path d="M9 5L16 12L9 19"/>',
    "chevron-down": '<path d="M5 9L12 16L19 9"/>',
    # The overflow menu.
    "ellipsis": '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    # Full screen, as four corner brackets rather than a pair of diagonal
    # arrows: at 11px the diagonals read as "resize" and the brackets read as
    # "take the whole screen".
    "expand": '<path d="M9 4.5H4.5V9"/><path d="M15 4.5H19.5V9"/><path d="M15 19.5H19.5V15"/><path d="M9 19.5H4.5V15"/>',
    # The fleet column, hidden and shown. A bar for the screen edge and a
    # chevron for the direction the panel goes. The teeth of this pair are what
    # a reader tells apart at 11px, so the bar sits on opposite sides rather
    # than the chevron alone flipping.
    "panel-hide": '<path d="M5.5 4.5V19.5"/><path d="M16 6.5L11 12L16 17.5"/>',
    "panel-show": '<path d="M18.5 4.5V19.5"/><path d="M8 6.5L13 12L8 17.5"/>',
    # Direction: sorting, and paging a list. Never a key legend.
    "arrow-up": '<path d="M12 19V5"/><path d="M6 11L12 5L18 11"/>',
    "arrow-down": '<path d="M12 5V19"/><path d="M6 13L12 19L18 13"/>',
    "arrow-right": '<path d="M5 12H19"/><path d="M13 6L19 12L13 18"/>',
    # Settled state.
    "check": '<path d="M5 12.5L9.5 17L19 6.5"/>',
    "close": '<path d="M6 6L18 18"/><path d="M18 6L6 18"/>',
    # Stop is a square, not an octagon: it ends something the user started,
    # which is a milder claim than a hazard sign.
    "stop": '<rect x="5.5" y="5.5" width="13" height="13" rx="2.5"/>',
    # Application settings.
    #
    # The teeth begin exactly on the rim (r=5.2, and every tooth starts at
    # 5.2 from centre) rather than floating outside it. That is the whole
    # difference between a cog and a sunburst at 11px, and the set this
    # replaced got it wrong: its spokes started at 3.4 against a rim at 3.1,
    # so a third of a pixel of gap became a starburst once rasterised.
    "gear": '<circle cx="12" cy="12" r="5.2"/><line x1="17.2" y1="12" x2="20.6" y2="12"/><line x1="14.6" y1="16.5" x2="16.3" y2="19.4"/><line x1="9.4" y1="16.5" x2="7.7" y2="19.4"/><line x1="6.8" y1="12" x2="3.4" y2="12"/><line x1="9.4" y1="7.5" x2="7.7" y2="4.6"/><line x1="14.6" y1="7.5" x2="16.3" y2="4.6"/>',
    # No enclosing circle. At 11px the ring is what turns the mark to mush;
    # the question mark alone is the most legible glyph in the set.
    "help": '<path d="M8.6 9.6A3.8 3.8 0 1 1 12 12.4V13.9"/><circle cx="12" cy="18.6" r="1"/>',
    # Notifications.
    "bell": '<path d="M6.2 15.4H17.8V10.6A5.8 5.8 0 0 0 6.2 10.6Z"/><path d="M10.3 19.4H13.7"/>',
    # Off drops the clapper as well as adding the strike, so the silhouette
    # differs rather than just the detail — readable at 11px in greyscale
    # (INV-13: never colour alone).
    "bell-off": '<path d="M6.2 15.4H17.8V10.6A5.8 5.8 0 0 0 6.2 10.6Z"/><path d="M3.6 20.4L20.4 3.6"/>',
    # An agent with its hand up: the mark on every surface that says which
    # agents are blocked on the reader (INV-11 guarantees the claim, since an
    # inferred status may never be `waiting`).
    #
    # Two fingers and a thumb, not four and a thumb. This was drawn seven ways
    # and rasterised at a true 12 and 16px before one was picked, the same way
    # the set itself was: a hand is mostly parallel strokes, and on this grid
    # adjacent fingers land about 1.6px apart at 12px, so the realistic ones
    # filled in solid and read as a bag. The widest-palm version collided with
    # `bell` outright at 12px — both became a dome with a foot. What survives
    # the size is the asymmetry, so the thumb does the work and the fingers are
    # cut to the two that still show a gap between them.
    #
    # It never carries the meaning alone: `Icon` is always `aria-hidden`, so
    # every placement has the status text beside it, and the colour it inherits
    # is `--waiting` rather than anything set here.
    "hand": '<path d="M9.6 12.6V6.4a2.5 2.5 0 0 1 5 0v6M14.6 12.4V8a2.5 2.5 0 0 1 5 0v7.6a5.2 5.2 0 0 1-5.2 5.2h-1.6a5.2 5.2 0 0 1-5.2-5.2v-3a2 2 0 0 0-4 0"/>',
    # The status rail: one glyph per session, in a fixed gutter down the fleet.
    #
    # They are a *set within the set* and are drawn to be told apart from each
    # other first, at one size, in one column — which is a different problem
    # from the control faces above, where each is read on its own. So they share
    # one silhouette, a circle of r=7.6, and differ only in what happens to it:
    # closed, swept, dashed, struck. A reader learns one shape and then reads
    # four states off its treatment.
    #
    # `hand` is the fifth member and deliberately breaks the circle: it is the
    # only state that asks the reader to get up, and it should not be something
    # you have to look twice at to tell from an idle ring.
    "ring": '<circle cx="12" cy="12" r="7.6"/>',
    # Working. The track is the whole circle at low opacity, the arc is a
    # quarter of it; the component spins the arc.
    #
    # Opacity, not colour — the one attribute in this file that is not pure
    # geometry, and it earns that because the track has to sit *behind* the arc
    # in the same ink. It still inherits `currentColor`, so the pair works in
    # all sixteen palettes with no variants, which is the rule the no-colour
    # ban actually exists to protect.
    #
    # The arc is a fixed quarter that rotates. It must never grow toward a
    # whole: a ring that filled would assert how far along the work is, and
    # this app cannot measure that (INV-11).
    "arc": '<circle cx="12" cy="12" r="7.6" opacity="0.28"/><path d="M12 4.4A7.6 7.6 0 0 1 19.6 12"/>',
    # The pane is gone, so nothing can be sent there. Struck rather than
    # hollow, because "cannot be reached" is not a quieter kind of idle.
    "ring-off": '<circle cx="12" cy="12" r="7.6"/><path d="M6.2 17.8L17.8 6.2"/>',
    # Reachability, as a trailing mark: can this app still drive that pane.
    # A second channel, never mixed into the state above it — the strike is the
    # same gesture `ring-off` and `bell-off` use, so "off" reads the same way
    # wherever it appears.
    "screen": '<rect x="3.2" y="4.6" width="17.6" height="12.4" rx="2.4"/><path d="M9 20.4H15"/>',
    "screen-off": '<rect x="3.2" y="4.6" width="17.6" height="12.4" rx="2.4"/><path d="M9 20.4H15"/><path d="M3.4 19.6L20.6 4.4"/>',
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
