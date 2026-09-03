#!/usr/bin/env python3
"""Derive every colour scheme, in OKLCH, against the contrast the UI needs.

    python3 scripts/gen-themes.py            # print the generated CSS blocks
    python3 scripts/gen-themes.py --write    # rewrite src/web/styles/tokens.css

Why generate rather than pick.

A palette here is not decoration: `--dim` has to clear 4.5:1 against three
different surfaces, `--line-strong` is the only thing drawing the edge of a
control and owes 3:1 against those same three, and `--text` has to clear 4.5:1
on the mock banner's tinted wash as well. Choosing hex by eye and then checking
means iterating by hand across five schemes, two modes and ~26 pairs each —
which is how the two failures `audit-contrast.py` was written for got in
(`--faint` at 3.80:1, control borders at 1.25:1). Deriving the lightness from
the requirement inverts that: a scheme is a set of *hues* and a character, and
the numbers that decide legibility are computed.

What the research says, and where each rule shows up below.

  - Never pure black, never pure white. Material's dark baseline is #121212
    rather than #000 to keep the surface emitting some light; pure white on
    pure black produces halation — a glow around the glyphs, with ghosting on
    scroll — which is uncomfortable generally and painful for the large
    minority with astigmatism. Every DARK base here sits at OKLCH L 0.17–0.24
    and every `--text` at L ≤ 0.94, so neither end is ever at the extreme.
  - Elevation by lightness, not by shadow. Material builds raised dark surfaces
    by laying white over the base; `bg → panel → panel-2` here is a rising
    lightness ramp for the same reason.
  - Desaturate on dark. Saturated colour on a dark surface both fails contrast
    and visually vibrates, so `CHROMA_DARK` is well under `CHROMA_LIGHT`.
  - Symmetric lightness between the modes. This is Solarized's central idea —
    its monotones have symmetric CIELAB lightness differences, so switching
    modes preserves the perceived steps. The surface ramps below are mirrored
    for that reason, and OKLCH is used throughout because it is perceptually
    uniform in exactly the way sRGB and HSL are not.
  - Beloved palettes are not automatically legible ones. Gruvbox measurably
    fails WCAG contrast; Catppuccin's own tracker records that a fully AA
    palette stopped looking pastel; Nord is deliberately low-contrast and that
    is its main complaint. So what is borrowed from each here is the *hue
    relationships and the character*, and the lightness is re-derived. These are
    "inspired by", and the code says so rather than claiming to ship them.

The output is checked, not trusted: `scripts/audit-contrast.py` re-measures
every pair of every scheme from the CSS this writes, with its own independent
implementation of the WCAG formula.
"""
from __future__ import annotations

import math
import sys
from dataclasses import dataclass
from itertools import combinations
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOKENS = ROOT / "src" / "web" / "styles" / "tokens.css"

# ---------------------------------------------------------------- colour maths

# The sRGB transfer function, from IEC 61966-2-1. These are the published
# values; naming them is what stops them being read as adjustable.
SRGB_LINEAR_CUTOFF = 0.0031308
SRGB_ENCODED_CUTOFF = 0.04045
SRGB_LINEAR_SLOPE = 12.92
SRGB_GAMMA = 2.4
SRGB_GAMMA_SCALE = 1.055
SRGB_GAMMA_OFFSET = 0.055

# WCAG 2's contrast ratio adds this to both luminances, to model the light a
# screen reflects rather than emits.
CONTRAST_FLARE = 0.05

# OKLab has three: lightness and the two chromatic axes.
OKLAB_AXES = 3

# sRGB luminance weights, from ITU-R BT.709 by way of WCAG 2.
RED_LUMINANCE = 0.2126
GREEN_LUMINANCE = 0.7152
BLUE_LUMINANCE = 0.0722

# 8 bits a channel, and how finely the gamut search walks chroma down.
CHANNEL_MAX = 255
HEX_BASE = 16
#: A hex colour is three pairs of digits; these are where each pair starts.
HEX_PAIR_STARTS = (0, 2, 4)
#: OKLab's cube root, applied to each of the three cone responses.
LMS_ROOT = 3
CHROMA_SEARCH_STEP = 0.002

def _srgb_from_linear(channel: float) -> float:
    if channel <= SRGB_LINEAR_CUTOFF:
        return SRGB_LINEAR_SLOPE * channel
    return SRGB_GAMMA_SCALE * (channel ** (1 / SRGB_GAMMA)) - SRGB_GAMMA_OFFSET


def _linear_from_srgb(channel: float) -> float:
    if channel <= SRGB_ENCODED_CUTOFF:
        return channel / SRGB_LINEAR_SLOPE
    return ((channel + SRGB_GAMMA_OFFSET) / SRGB_GAMMA_SCALE) ** SRGB_GAMMA


def oklch_to_linear(L: float, C: float, h_deg: float) -> tuple[float, float, float]:
    """OKLCH -> linear sRGB, via OKLab. Björn Ottosson's matrices."""
    h = math.radians(h_deg)
    a, b = C * math.cos(h), C * math.sin(h)

    l_ = L + 0.3963377774 * a + 0.2158037573 * b
    m_ = L - 0.1055613458 * a - 0.0638541728 * b
    s_ = L - 0.0894841775 * a - 1.2914855480 * b
    l, m, s = l_**LMS_ROOT, m_**LMS_ROOT, s_**LMS_ROOT

    return (
        +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
    )


def in_gamut(rgb: tuple[float, float, float], tol: float = 1e-4) -> bool:
    return all(-tol <= c <= 1 + tol for c in rgb)


def oklch_to_hex(L: float, C: float, hue: float) -> str:
    """Nearest in-gamut sRGB, reducing chroma rather than clipping channels.

    Clipping a channel changes the hue as well as the chroma, and it does it
    silently. Walking the chroma down keeps the hue and the lightness — which
    are the two things every decision here was made in terms of.
    """
    chroma = C
    while chroma > 0:
        rgb = oklch_to_linear(L, chroma, hue)
        if in_gamut(rgb):
            break
        chroma -= CHROMA_SEARCH_STEP
    else:
        rgb = oklch_to_linear(L, 0, hue)
    channels = [min(1.0, max(0.0, _srgb_from_linear(value))) for value in rgb]
    return "#%02x%02x%02x" % tuple(round(value * CHANNEL_MAX) for value in channels)


def relative_luminance(hex_colour: str) -> float:
    digits = hex_colour.lstrip("#")
    rgb = [int(digits[at : at + 2], HEX_BASE) / CHANNEL_MAX for at in HEX_PAIR_STARTS]
    red, green, blue = (_linear_from_srgb(value) for value in rgb)
    return RED_LUMINANCE * red + GREEN_LUMINANCE * green + BLUE_LUMINANCE * blue


def contrast(first: str, second: str) -> float:
    one, other = relative_luminance(first), relative_luminance(second)
    hi, lo = max(one, other), min(one, other)
    return (hi + CONTRAST_FLARE) / (lo + CONTRAST_FLARE)


def hex_to_oklab(value: str) -> tuple[float, float, float]:
    """sRGB hex -> OKLab, for measuring how far apart two colours look."""
    digits = value.lstrip("#")
    red, green, blue = (
        _linear_from_srgb(int(digits[at : at + 2], HEX_BASE) / CHANNEL_MAX)
        for at in HEX_PAIR_STARTS
    )
    l = 0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue
    m = 0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue
    s = 0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue
    l_, m_, s_ = l ** (1 / LMS_ROOT), m ** (1 / LMS_ROOT), s ** (1 / LMS_ROOT)
    return (
        0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
        1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
        0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
    )


def separation(first: str, second: str) -> float:
    """How different two colours look, in a space where distance means that.

    Contrast against the *background* is what WCAG measures and is not the only
    thing that matters: two status colours can each clear 4.5:1 and still be the
    same colour as each other. `--waiting` and `--danger` sitting 0.073 apart is
    an amber pill and a red one that both read "warm" at a glance — which is the
    entire job of a status colour failing, without a single failing pair in the
    contrast audit.
    """
    one, other = hex_to_oklab(first), hex_to_oklab(second)
    return math.sqrt(sum((one[axis] - other[axis]) ** 2 for axis in range(OKLAB_AXES)))


def mix(tint: str, base: str, fraction: float) -> str:
    """Flatten `color-mix(in srgb, <tint> N%, transparent)` over `base`."""
    over = [int(tint.lstrip("#")[at : at + 2], HEX_BASE) for at in HEX_PAIR_STARTS]
    under = [int(base.lstrip("#")[at : at + 2], HEX_BASE) for at in HEX_PAIR_STARTS]
    return "#%02x%02x%02x" % tuple(
        round(over[at] * fraction + under[at] * (1 - fraction))
        for at in range(len(HEX_PAIR_STARTS))
    )


@dataclass(frozen=True)
class Against:
    """What a foreground has to be legible against, and which way to search.

    The two always travel together — the surfaces come from the mode — and
    passing them as one thing is what keeps `solve_lightness` down to a
    readable signature.
    """

    surfaces: list[str]
    dark: bool


# How far the lightness search may roam, and how finely.
DARK_SEARCH = (0.30, 0.99)
LIGHT_SEARCH = (0.02, 0.72)
LIGHTNESS_SEARCH_STEP = 0.002


def solve_lightness(hue: float, chroma: float, against: Against, need: float) -> str:
    """The closest colour to the surfaces that still clears `need` against all.

    Closest, not safest. Pushing every foreground to maximum contrast is how a
    dark theme ends up at pure white on pure black — legible by the numbers and
    the exact thing that makes text glow and ghost. So this walks *towards* the
    surfaces and stops at the first lightness that still passes everywhere,
    which puts each token at the gentlest value its job allows.
    """
    lo, hi = DARK_SEARCH if against.dark else LIGHT_SEARCH
    step = LIGHTNESS_SEARCH_STEP
    candidates = [lo + index * step for index in range(int((hi - lo) / step) + 1)]
    # Dark themes want the lowest passing lightness, light themes the highest:
    # both mean "nearest the background".
    order = candidates if against.dark else list(reversed(candidates))
    best = None
    for L in order:
        colour = oklch_to_hex(L, chroma, hue)
        if all(contrast(colour, surface) >= need for surface in against.surfaces):
            best = colour
            break
    if best is None:
        # Nothing at this chroma can do it; fall back to the extreme end, which
        # the audit will then report rather than letting it pass quietly.
        best = oklch_to_hex(hi if against.dark else lo, chroma, hue)
    return best


# ------------------------------------------------------------------- the ramps

# Surface lightness, mirrored between the modes so the perceived steps match —
# Solarized's symmetry, in OKLCH rather than CIELAB.
#
# The dark base is 0.205, not 0. Material's #121212 is ~0.18 in OKLCH and is
# chosen for the same reason: a surface that still emits light does not make
# text bleed into it.
DARK_SURFACES = {"bg": 0.205, "panel": 0.245, "panel-2": 0.285, "line": 0.33}
# The light ramp sits a little below where it started, and the reason is gamut
# rather than taste. Near the top of the range there is almost no chroma to be
# had — at L 0.975 a blue can reach 0.011 before it leaves sRGB, while a warm
# yellow reaches 0.031 — so Nordic and Mauve were being flattened to the same
# near-white as Graphite while Solar and Ember kept their colour. Dropping the
# page to 0.955 buys a blue roughly twice the chroma, which is the difference
# between five schemes and three schemes and two paler copies of one of them.
#
# `panel` stays close to white on purpose: a card that is not the lightest thing
# on the page stops reading as raised.
LIGHT_SURFACES = {"bg": 0.955, "panel": 0.99, "panel-2": 0.925, "line": 0.88}

# Chroma of the surfaces: enough for a scheme to have a temperature, little
# enough that the greys still read as greys.
#
# Lower on light, because the same chroma is far more obvious up at L 0.97 than
# down at L 0.2 — a neutral scheme tinted as much in light mode as in dark reads
# as "blue", not as "grey with a hint".
CHROMA_SURFACE_DARK = 0.014
CHROMA_SURFACE_LIGHT = 0.006

#: Where a generated comment wraps. Under the hook's 120, with room for the
#: closing marker.
COMMENT_WRAP_WIDTH = 88

#: The four colours that carry a meaning, as opposed to a surface or a rule.
STATUS_TOKENS = ("busy", "waiting", "accent", "danger")

# Separators get a little more colour than the surfaces, up to a point.
LINE_CHROMA_LIFT = 2
LINE_CHROMA_MAX = 0.045
# Secondary text carries a touch more colour than body text, which is what
# separates `--dim` and `--faint` from `--text` when all three owe the same
# ratio against the same three surfaces.
MUTED_CHROMA_LIFT = 1.5

DARK_SHADOW = "0 10px 30px rgb(0 0 0 / 0.45)"
LIGHT_SHADOW = "0 10px 30px rgb(16 24 40 / 0.12)"

# How far apart two status colours must look, in OKLab. Measured across the
# schemes that read well, a comfortable pair sits at 0.12-0.20 and anything
# under 0.10 was picked out by eye as "those two are the same colour".
MIN_SEPARATION = 0.10

# Accent chroma. Lower on dark, where saturated colour both fails contrast and
# vibrates against the background.
CHROMA_DARK = 0.115
CHROMA_LIGHT = 0.145

# Required ratios, from the roles in `audit-contrast.py`. The margin over 4.5
# and 3.0 is deliberate: these are 8-bit values and the audit re-measures them
# after rounding, so a token solved to exactly 4.5 can audit at 4.49.
NEED_TEXT = 4.7
NEED_UI = 3.2

# What WCAG itself requires, as opposed to the margin the solver aims for.
NEED_TEXT_AA = 4.5
NEED_UI_AA = 3.0

# Targets per role, above the minimum where the role earns it.
#
# Body text is not pushed to the maximum the surface allows. Off-white on
# near-black is the halation case; the guidance that comes out of it is text
# around RGB 220 on a background around RGB 30, which is roughly 11:1 — high
# enough to be crisp, short of the glow. Symmetric between the modes, so the
# perceived step is the same whichever way round it is.
NEED_BODY = 11.0
NEED_DIM = 6.5
# A border is meant to describe an edge, not to announce it, so it sits just
# over the 3:1 that 1.4.11 requires and no further.
NEED_BORDER = 3.4
# Status colours carry meaning and are read at a glance, so they get more than
# the bare text minimum.
NEED_STATUS = 5.5
# The focus ring is the one indicator that has to be findable rather than
# merely present: it is what tells a keyboard user where they are.
NEED_FOCUS = 5.0


@dataclass(frozen=True)
class Scheme:
    """A scheme is hues and a character; every lightness is derived.

    A dataclass rather than a written-out constructor: this is a record of
    decisions, and every one of the fields below is a decision someone made
    about how a scheme should feel. Spelling out the assignments added nothing
    a reader did not already have from the field list.
    """

    key: str
    label: str
    note: str
    #: Hue of the greys, which is what gives a scheme its temperature.
    neutral_dark: float
    neutral_light: float
    #: Hue per semantic colour: busy, waiting, accent, danger.
    hues: dict[str, float]
    chroma_surface_dark: float = CHROMA_SURFACE_DARK
    chroma_surface_light: float = CHROMA_SURFACE_LIGHT
    chroma_dark: float = CHROMA_DARK
    chroma_light: float = CHROMA_LIGHT
    #: Nudges the whole light surface ramp. Two warm schemes both landing on
    #: "cream" is how Solar and Ember came to differ by three units of blue in
    #: light mode — distinct in the code and the same thing on screen.
    surface_shift_light: float = 0.0

    def _surfaces(self, dark: bool) -> dict[str, str]:
        """The page, the card, the raised surface and the separator."""
        ramp = DARK_SURFACES if dark else {
            # `panel` is left alone: it is the card, and a card that is not the
            # lightest thing on the page stops reading as raised.
            name: L if name == "panel" else L + self.surface_shift_light
            for name, L in LIGHT_SURFACES.items()
        }
        neutral = self.neutral_dark if dark else self.neutral_light
        base = self.chroma_surface_dark if dark else self.chroma_surface_light

        out = {}
        for name, L in ramp.items():
            # `--line` is decorative (1.4.11 exempts it) so it only has to be
            # visible, not measured; a touch more chroma keeps it from looking
            # like a different scheme's grey. Capped, because doubling a chroma
            # that is already high for a warm scheme turns a separator into a
            # stripe of colour.
            chroma = min(base * LINE_CHROMA_LIFT, LINE_CHROMA_MAX) if name == "line" else base
            out[name] = oklch_to_hex(L, chroma, neutral)
        return out

    def palette(self, dark: bool) -> dict[str, str]:
        out = self._surfaces(dark)
        neutral = self.neutral_dark if dark else self.neutral_light
        c_surface = self.chroma_surface_dark if dark else self.chroma_surface_light
        c_accent = self.chroma_dark if dark else self.chroma_light

        bg, panel, panel2 = out["bg"], out["panel"], out["panel-2"]
        on_everything = Against([bg, panel, panel2], dark)
        on_cards = Against([panel, panel2], dark)
        on_page = Against([bg, panel], dark)

        # Text ramp. Three steps, all of which owe 4.5:1 on all three surfaces —
        # so they are separated by chroma and by the small lightness room left
        # above the requirement rather than by "dim means lower contrast".
        muted = c_surface * MUTED_CHROMA_LIFT
        out["text"] = solve_lightness(neutral, c_surface, on_everything, NEED_BODY)
        out["dim"] = solve_lightness(neutral, muted, on_everything, NEED_DIM)
        out["faint"] = solve_lightness(neutral, muted, on_everything, NEED_TEXT)

        # The edge of an interactive control: the surfaces differ by so little
        # that this border is the only thing saying where a card or input
        # begins, which is exactly what 1.4.11's 3:1 is for.
        out["line-strong"] = solve_lightness(neutral, c_surface, on_everything, NEED_BORDER)

        # Status colours are read as text on the panel and on the raised
        # surface, so both are in the requirement.
        for name in STATUS_TOKENS:
            out[name] = solve_lightness(self.hues[name], c_accent, on_cards, NEED_STATUS)
        # Idle is the neutral one: it means "nothing is happening", and a hue
        # here would say something.
        out["idle"] = out["faint"]

        # 3:1 is all a non-text indicator owes; NEED_FOCUS asks for more,
        # because this is the one indicator that has to be findable.
        out["focus"] = solve_lightness(self.hues["busy"], c_accent, on_page, NEED_FOCUS)

        out["shadow"] = DARK_SHADOW if dark else LIGHT_SHADOW
        return out


SCHEMES = [
    Scheme(
        key="graphite",
        label="Graphite",
        note="Neutral slate. The default: no temperature, nothing to get tired of.",
        neutral_dark=255,
        neutral_light=255,
        hues={"busy": 250, "waiting": 80, "accent": 150, "danger": 15},
        # Nearly achromatic, because this is the scheme that is meant to have no
        # temperature — and because Nordic next to it has to be visibly the blue
        # one. The two were 0.006 apart in OKLab, which is to say identical.
        chroma_surface_dark=0.006,
        chroma_surface_light=0.003,
    ),
    Scheme(
        key="nordic",
        label="Nordic",
        note=(
            "Arctic blues, after Nord — whose muted frost is the appeal and whose "
            "low contrast is the usual complaint. The hues are kept and the "
            "lightness is re-derived, so it stays cool without going quiet."
        ),
        neutral_dark=250,
        neutral_light=250,
        # `accent` at 160 sat only 0.12 from `busy` — a cool green beside a
        # cool blue, which is the agent-name colour and the busy colour reading
        # as the same thing at a glance. Pulled towards a plainer green.
        hues={"busy": 240, "waiting": 78, "accent": 146, "danger": 10},
        chroma_surface_dark=0.038,
        chroma_surface_light=0.030,
        chroma_dark=0.10,
        chroma_light=0.13,
    ),
    Scheme(
        key="solar",
        label="Solar",
        note=(
            "Teal-tinted dark, cream light, after Solarized — the scheme that "
            "made symmetric lightness between the two modes the point. Its hue "
            "relationships are the most carefully chosen of any of these. "
            "Measured from the published palette: base03 #002b36 is hue 220, "
            "base3 #fdf6e3 is 90, blue #268bd2 is 245, yellow #b58900 is 86, "
            "red #dc322f is 27. Its green #859900 is an olive at 119, which sits "
            "too close to the amber to tell `waiting` from `accent` at a glance, "
            "so `accent` is a plainer green here — the one departure."
        ),
        neutral_dark=220,
        neutral_light=90,
        hues={"busy": 245, "waiting": 86, "accent": 145, "danger": 27},
        chroma_surface_dark=0.028,
        chroma_surface_light=0.030,
    ),
    Scheme(
        key="ember",
        label="Ember",
        note=(
            "Warm browns and ambers, after Gruvbox — which is measurably short "
            "of WCAG contrast as published. The warmth is what people want from "
            "it; the legibility is put back."
        ),
        neutral_dark=70,
        neutral_light=75,
        # The warm scheme needs the most help keeping its status colours apart,
        # since the surfaces behind them are warm too: amber sat 0.087 from the
        # olive green as well as close to the red, so `accent` is a plainer
        # green here than the scheme's palette would suggest. `busy` moved off
        # 230, where it came out an electric cyan belonging to no other scheme.
        hues={"busy": 248, "waiting": 80, "accent": 152, "danger": 12},
        chroma_surface_dark=0.032,
        # Deeper and more saturated than Solar's cream, because both schemes are
        # warm and both were otherwise resolving to the same near-white: tan
        # against parchment is the difference you can actually see.
        chroma_surface_light=0.055,
        surface_shift_light=-0.030,
        chroma_dark=0.105,
        chroma_light=0.15,
    ),
    Scheme(
        key="mauve",
        label="Mauve",
        note=(
            "Soft violet, after Catppuccin — whose own tracker records that a "
            "fully AA palette stopped looking pastel. This keeps the hue "
            "family and accepts being a little less pale for it."
        ),
        neutral_dark=295,
        neutral_light=295,
        hues={"busy": 265, "waiting": 78, "accent": 152, "danger": 5},
        chroma_surface_dark=0.036,
        chroma_surface_light=0.028,
        chroma_dark=0.11,
        chroma_light=0.14,
    ),
    Scheme(
        key="one",
        label="One",
        note=(
            "Cool blue-grey, after Atom's One Dark and One Light, measured from "
            "the syntax themes' own `colors.less`: One Dark's background "
            "hsl(220,13%,18%) is OKLCH hue 264, its blue hsl(207,82%,66%) 245, "
            "green 133, yellow 82, red 17; One Light's blue is 263, green 143, "
            "orange 76, red 28 — so each role takes the midpoint. The greys sit "
            "a little off the measured hue and well above the measured chroma "
            "(~0.016), because at One Dark's true grey the scheme was 0.015 "
            "from Nordic, and two schemes that close are one scheme with two "
            "names (FR-UI-8). The light half stays near One Light's near-white."
        ),
        neutral_dark=254,
        neutral_light=210,
        hues={"busy": 250, "waiting": 80, "accent": 138, "danger": 22},
        chroma_surface_dark=0.060,
        chroma_surface_light=0.020,
        chroma_dark=0.11,
        chroma_light=0.14,
    ),
    Scheme(
        key="dracula",
        label="Dracula",
        note=(
            "Purple-black with a violet accent, after Dracula, measured from the "
            "published spec: background #282a36 is OKLCH hue 278, purple #bd93f9 "
            "302, green #50fa7b 148, red #ff5555 24. The purple is the whole "
            "identity, so it carries `busy`. Dracula's yellow #f1fa8c is 113, "
            "which reads as the same colour as the green beside it, and its "
            "orange #ffb86c is 67, which reads as the red; `waiting` takes the "
            "hue between them. The surfaces carry more purple than #282a36 "
            "itself: at its true chroma (~0.022) the scheme was 0.012 from "
            "Mauve. The light half is Alucard's warm near-white."
        ),
        neutral_dark=278,
        neutral_light=95,
        hues={"busy": 302, "waiting": 95, "accent": 148, "danger": 24},
        chroma_surface_dark=0.060,
        chroma_surface_light=0.008,
        chroma_dark=0.125,
        chroma_light=0.15,
    ),
    Scheme(
        key="monokai",
        label="Monokai",
        note=(
            "Olive-black with lime and magenta, after Monokai, measured from "
            "monokai.vim: background #272822 is OKLCH hue 115, purple #ae81ff "
            "298, orange #fd971f 62, green #a6e22e 127, magenta #f92672 7. The "
            "lime is `accent`, the magenta `danger`, the orange `waiting`; "
            "`busy` takes the violet so the working colour is never confused "
            "with the alert. Monokai never had a light half, so this one is a "
            "warm, faintly green off-white derived to sit apart from Solar's "
            "cream."
        ),
        neutral_dark=115,
        neutral_light=120,
        hues={"busy": 298, "waiting": 62, "accent": 127, "danger": 7},
        chroma_surface_dark=0.012,
        chroma_surface_light=0.020,
        chroma_dark=0.12,
        chroma_light=0.15,
    ),
]

ORDER = [
    "bg",
    "panel",
    "panel-2",
    "line",
    "line-strong",
    "text",
    "dim",
    "faint",
    "busy",
    "waiting",
    "idle",
    "accent",
    "danger",
    "focus",
    "shadow",
]


def block(palette: dict[str, str], indent: str) -> str:
    lines = [f"{indent}--{name}: {palette[name]};" for name in ORDER]
    return "\n".join(lines)


# Which tokens a swatch shows: the page, a raised surface, and one accent.
#
# Not three status colours, which was the first attempt. The status hues are
# deliberately close to identical across the schemes — amber means waiting
# whichever palette you are in, and moving that per scheme would make the one
# thing on screen that carries meaning the thing that changes — so three of them
# made five near-identical rows. What actually differs between schemes is the
# surfaces, so that is what the dots show.
SWATCH_TOKENS = ("bg", "panel-2", "accent")


def swatches(dark: bool, indent: str) -> str:
    """Every scheme's swatch colours, for the mode the document is in.

    These exist because the palettes are defined on `:root[data-scheme=...]`,
    which by definition only ever matches the root element. The settings menu
    needs to draw *five* schemes' colours at once, on five list items inside one
    document that is only ever in one scheme — so putting `data-scheme` on the
    swatch itself does exactly nothing, which is the shape of bug that looks
    like it works until you notice every swatch is the same colour.

    Emitted per mode rather than once, so the dots show what you would actually
    get if you picked that row now, rather than its dark palette while the app
    is in light.
    """
    lines = []
    for scheme in SCHEMES:
        palette = scheme.palette(dark)
        for token in SWATCH_TOKENS:
            lines.append(f"{indent}--swatch-{scheme.key}-{token}: {palette[token]};")
    return "\n".join(lines)


def _default_blocks(default: Scheme) -> list[str]:
    """The four blocks that decide light or dark for the default scheme.

    Four, not two, and the shape is the whole reason this is fiddly: `light`
    and `dark` are attributes, but "system" is the *absence* of one — so the
    light palette has to be written twice, once for the explicit choice and
    once inside the media query that answers when nothing was chosen.
    """
    dark = block(default.palette(dark=True), "  ")
    light = block(default.palette(dark=False), "  ")
    return [
        HEADER,
        # The default scheme is the bare `:root`, so a document carrying no
        # attributes at all is still a complete theme. The scales and the
        # swatch variables ride along here for the same reason.
        ":root {",
        dark,
        "",
        SWATCH_COMMENT,
        swatches(dark=True, indent="  "),
        SCALES,
        "  color-scheme: dark;",
        "}",
        "",
        LIGHT_COMMENT,
        ":root[data-theme='light'] {",
        light,
        swatches(dark=False, indent="  "),
        "  color-scheme: light;",
        "}",
        "",
        *_system_light_block(default),
        "",
        "/* An explicit dark choice must win over a light system preference. */",
        ":root[data-theme='dark'] {",
        dark,
        swatches(dark=True, indent="  "),
        "  color-scheme: dark;",
        "}",
    ]


def _system_light_block(default: Scheme) -> list[str]:
    """The light palette again, for when no choice was made.

    Written twice because "system" is the absence of an attribute: there is no
    selector that means "light, however you arrived at it".
    """
    return [
        "@media (prefers-color-scheme: light) {",
        "  :root:not([data-theme]) {",
        block(default.palette(dark=False), "    "),
        swatches(dark=False, indent="    "),
        "    color-scheme: light;",
        "  }",
        "}",
    ]


def _wrapped_comment(note: str) -> list[str]:
    """A scheme's note as a CSS comment, wrapped to a readable width.

    It was written on one line, which came out at 200 characters. The file is
    generated, so nobody would ever have reformatted it by hand — which is
    exactly why the generator has to do it.
    """
    words = note.split()
    lines: list[str] = []
    current = "/*"
    for word in words:
        if len(current) + 1 + len(word) > COMMENT_WRAP_WIDTH:
            lines.append(current)
            current = "  " + word
        else:
            current = f"{current} {word}"
    lines.append(f"{current} */")
    return lines


def _scheme_blocks(scheme: Scheme) -> list[str]:
    """The same four blocks for a scheme that is not the default.

    These carry no swatches: the swatch variables describe every scheme at
    once and follow only light and dark, because the menu draws all five rows
    inside whichever scheme is currently applied.
    """
    selector = f":root[data-scheme='{scheme.key}']"
    return [
        "",
        f"/* ---- {scheme.label} ---- */",
        *_wrapped_comment(scheme.note),
        f"{selector} {{",
        block(scheme.palette(dark=True), "  "),
        "  color-scheme: dark;",
        "}",
        "",
        f"{selector}[data-theme='light'] {{",
        block(scheme.palette(dark=False), "  "),
        "  color-scheme: light;",
        "}",
        "",
        "@media (prefers-color-scheme: light) {",
        f"  {selector}:not([data-theme]) {{",
        block(scheme.palette(dark=False), "    "),
        "    color-scheme: light;",
        "  }",
        "}",
        "",
        f"{selector}[data-theme='dark'] {{",
        block(scheme.palette(dark=True), "  "),
        "  color-scheme: dark;",
        "}",
    ]


def render() -> str:
    """The whole of tokens.css, structure and all."""
    default = SCHEMES[0]
    out = _default_blocks(default)
    for scheme in SCHEMES:
        if scheme.key != default.key:
            out += _scheme_blocks(scheme)
    out.append("")
    return "\n".join(out)


HEADER = """/**
 * Design tokens. GENERATED — edit `scripts/gen-themes.py` and re-run it.
 *
 *     python3 scripts/gen-themes.py --write
 *
 * Every colour here is derived in OKLCH from the contrast its role requires,
 * rather than picked and then checked. The generator carries the reasoning and
 * the research behind it; `scripts/audit-contrast.py` re-measures the result
 * independently and is what actually gates a change.
 *
 * Two axes, and they are separate on purpose. `data-scheme` on <html> picks the
 * palette family; `data-theme` picks light or dark within it, and its *absence*
 * means "system", which is why every scheme repeats its light block inside a
 * `prefers-color-scheme` query. A scheme with no `data-scheme` attribute is the
 * default one, so a document with no attributes at all is still complete.
 */
"""

SWATCH_COMMENT = """  /* One row of dots per scheme for the settings menu — see `swatches()`. These
     follow light/dark but not the current scheme, because the menu draws all
     five at once. */"""

LIGHT_COMMENT = """/* The light palette, applied from two places: an explicit choice, and the
   system preference when no choice has been made. */"""

SCALES = """
  /* Type scale. Six steps; anything between them was drift. */
  --text-xs: 11px;
  --text-sm: 12px;
  --text-base: 13px;
  --text-md: 14px;
  --text-lg: 15px;
  --text-xl: 17px;
  /* 16px is not a scale step but a requirement: iOS zooms a focused field
     under it. Used verbatim in the coarse-pointer rules. */

  /* Radius scale. */
  --radius-xs: 4px;
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-pill: 999px;
"""


# How far apart two schemes must look, in OKLab.
#
# Not a contrast requirement — a "did picking this do anything" requirement.
# Graphite and Nordic arrived at 0.006, which is the same colour twice under two
# names, and no audit measuring contrast would ever have noticed.
#
# Measured across the surfaces rather than on the page alone. Near white there
# is very little chroma to be had before a colour leaves sRGB, so the page can
# only ever be faintly tinted in light mode; the raised surfaces sit lower and
# can carry the difference. A scheme has to be distinguishable *somewhere*, not
# everywhere.
MIN_SCHEME_DISTANCE = 0.02
SCHEME_DISTANCE_SURFACES = ("bg", "panel-2", "line")


TEXT_TOKENS = ("text", "dim", "faint", "busy", "waiting", "idle", "accent", "danger")
SURFACES = ("bg", "panel", "panel-2")
#: How much of the page the mock-mode banner's amber wash covers its background.
BANNER_TINT = 0.18


def _contrast_pairs(palette: dict[str, str]) -> list[tuple[float, str, float]]:
    """Every (ratio, what, required) the interface actually renders.

    The same set `audit-contrast.py` measures. It is duplicated deliberately:
    that script is the authority and reads the finished CSS, while this reads
    the palette before it is written, so a scheme that cannot be solved says so
    where it is being solved rather than two commands later.
    """
    pairs: list[tuple[float, str, float]] = []
    for foreground in TEXT_TOKENS:
        for surface in SURFACES:
            # The status colours are never drawn straight onto the page.
            if foreground in STATUS_TOKENS and surface == "bg":
                continue
            pairs.append((contrast(palette[foreground], palette[surface]),
                          f"{foreground} on {surface}", NEED_TEXT_AA))
    for surface in SURFACES:
        pairs.append((contrast(palette["line-strong"], palette[surface]),
                      f"line-strong on {surface}", NEED_UI_AA))
    for surface in ("bg", "panel"):
        pairs.append((contrast(palette["focus"], palette[surface]),
                      f"focus on {surface}", NEED_UI_AA))
    banner = mix(palette["waiting"], palette["bg"], BANNER_TINT)
    pairs.append((contrast(palette["text"], banner), "text on mock banner", NEED_TEXT_AA))
    return pairs


def _close_status_pairs(palette: dict[str, str]) -> list[tuple[float, str]]:
    """Status colours that are too near each other to tell apart."""
    return [
        (separation(palette[first], palette[second]), f"{first} vs {second}")
        for first, second in combinations(STATUS_TOKENS, 2)
        if separation(palette[first], palette[second]) < MIN_SEPARATION
    ]


def _report_palette(scheme: Scheme, dark: bool) -> float:
    """Print one palette's verdict; return its margin, where under 1.0 fails."""
    palette = scheme.palette(dark)
    pairs = _contrast_pairs(palette)
    close = _close_status_pairs(palette)
    failing = [(value, what, need) for value, what, need in pairs if value < need]
    worst = min((value / need, value, what) for value, what, need in pairs)
    nearest = min(
        separation(palette[first], palette[second])
        for first, second in combinations(STATUS_TOKENS, 2)
    )
    mode = "dark " if dark else "light"
    state = "FAIL" if (failing or close) else "ok  "
    print(f"{state} {scheme.key:9} {mode}  tightest {worst[1]:5.2f}:1  {worst[2]:24}"
          f"  nearest pair {nearest:.3f}")
    for value, what, need in failing:
        print(f"       -> {what} {value:.2f}:1 needs {need}")
    for apart, what in close:
        print(f"       -> {what} only {apart:.3f} apart, needs {MIN_SEPARATION}")
    return 0.0 if close else worst[0]


def _report_scheme_distances() -> bool:
    """Whether every scheme is distinguishable from every other one."""
    ok = True
    for dark in (True, False):
        palettes = {scheme.key: scheme.palette(dark) for scheme in SCHEMES}
        mode = "dark" if dark else "light"
        for first, second in combinations(palettes, 2):
            apart = max(
                separation(palettes[first][surface], palettes[second][surface])
                for surface in SCHEME_DISTANCE_SURFACES
            )
            if apart >= MIN_SCHEME_DISTANCE:
                continue
            print(f"FAIL {first} and {second} are {apart:.3f} apart in {mode}"
                  " — the same scheme twice")
            ok = False
    return ok


def report() -> int:
    """Print every scheme's worst pair, as a sanity check before the audit."""
    margin = min(
        _report_palette(scheme, dark)
        for scheme in SCHEMES
        for dark in (True, False)
    )
    distinct = _report_scheme_distances()
    return 0 if margin >= 1.0 and distinct else 1


def main() -> int:
    if "--write" in sys.argv:
        TOKENS.write_text(render())
        print(f"wrote {TOKENS}")
        return report()
    if "--report" in sys.argv:
        return report()
    # `write`, not `print`: stdout and the file have to be byte-identical, or
    # the test that regenerates and compares them fails on a trailing newline.
    sys.stdout.write(render())
    return 0


if __name__ == "__main__":
    sys.exit(main())
