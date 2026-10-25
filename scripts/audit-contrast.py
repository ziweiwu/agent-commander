#!/usr/bin/env python3
"""WCAG 2.2 contrast audit of the design tokens.

Reads src/web/styles/tokens.css, extracts the dark and light palettes, and
measures every foreground/background pair the interface actually uses against
the threshold that pair has to meet:

  4.5:1  normal text                     (WCAG 1.4.3)
  3.0:1  large text and UI boundaries    (WCAG 1.4.11)

Measure, never eyeball. Two real failures were found this way: --faint was
3.80:1 on panel in dark and 4.02:1 in light, and control borders sat at
1.25:1 while being the only thing defining a card or input edge.

  python3 scripts/audit-contrast.py            # audit the tokens
  python3 scripts/audit-contrast.py '#fff' '#000'   # one ad-hoc pair

Exits non-zero if any pair fails.
"""
import re
import sys
from pathlib import Path

TOKENS = Path(__file__).resolve().parent.parent / "src" / "web" / "styles" / "tokens.css"

# How far back to look for the `@media` line that a nested block sits inside.
MEDIA_QUERY_LOOKBACK = 60

# fg token, bg token, required ratio, what it is
PAIRS = [
    ("text", "bg", 4.5, "body text on the page"),
    ("text", "panel", 4.5, "text on a card or panel"),
    ("text", "panel-2", 4.5, "text on a raised surface"),
    ("dim", "panel", 4.5, "secondary text on a panel"),
    ("dim", "bg", 4.5, "secondary text on the page"),
    ("faint", "panel", 4.5, "tertiary text on a panel"),
    ("faint", "bg", 4.5, "tertiary text on the page"),
    ("busy", "panel", 4.5, "busy status text"),
    ("waiting", "panel", 4.5, "waiting status text"),
    ("idle", "panel", 4.5, "idle status text"),
    ("accent", "panel", 4.5, "agent name / success text"),
    ("danger", "panel", 4.5, "error text"),
    # The raised surface is where the status pill and the control-bar labels
    # actually sit (.pill and .controls both set `background: var(--panel-2)`).
    # Auditing these only against `panel` passed four pairs that fail where they
    # are really drawn — busy at 4.41:1 and faint at 4.27:1 in light, faint at
    # 4.18:1 in dark, accent at 4.48:1 in light. A pair is only audited if the
    # surface it is measured against is the one it is rendered on.
    ("dim", "panel-2", 4.5, "secondary text on a raised surface"),
    ("faint", "panel-2", 4.5, "tertiary text on a raised surface"),
    ("busy", "panel-2", 4.5, "busy status pill"),
    ("waiting", "panel-2", 4.5, "waiting status pill"),
    ("idle", "panel-2", 4.5, "idle status pill"),
    ("accent", "panel-2", 4.5, "agent name on a raised surface"),
    ("danger", "panel-2", 4.5, "error text on a raised surface"),
    ("line-strong", "panel", 3.0, "control boundary on a panel"),
    ("line-strong", "bg", 3.0, "control boundary on the page"),
    ("line-strong", "panel-2", 3.0, "control boundary on a raised surface"),
    ("focus", "bg", 3.0, "focus ring on the page"),
    ("focus", "panel", 3.0, "focus ring on a panel"),
    # The raised surface, where the chips, the control bar and the send-mode
    # segment live. It was the one surface the ring was never checked against,
    # and the generator was not solving for it either. This passes as of the
    # re-solve, so it locks the fix in rather than reporting a new failure.
    ("focus", "panel-2", 3.0, "focus ring on a raised surface"),
    ("text", "wash-waiting", 4.5, "a waiting card's name and words"),
    ("dim", "wash-waiting", 4.5, "a waiting card's place line"),
    ("faint", "wash-waiting", 4.5, "a waiting card's separators and age"),
    ("waiting", "wash-waiting", 4.5, "a waiting card's status and Answer verb"),
    ("danger", "wash-waiting", 4.5, "anything red on a waiting card"),
    ("line-strong", "wash-waiting", 3.0, "a waiting card's own edge"),
    ("focus", "wash-waiting", 3.0, "the open waiting card's focus edge"),
]
"""
`--wash-waiting` is the one opaque tint: a solved colour per palette rather than
a mix, so it is measured here like any other surface. The waiting card is drawn
on it at rest, hovered and open, which is why every token its face uses is here.
"""

# Surfaces built with color-mix rather than a flat token. Auditing only flat
# pairs missed the mock-mode banner entirely: amber text on its own 18% amber
# wash measures 4.04:1 in light, and the banner is on screen on every route.
COMPOSITES = [
    ("text", ("tint-banner", "bg"), 4.5, "mock-mode banner text"),
    ("text", ("tint-banner", "bg"), 4.5, "notification nudge text"),
    ("waiting", ("tint-waiting", "panel"), 4.5, "waiting pill in the agent header"),
    ("text", ("tint-waiting", "panel"), 4.5, "blocked banner text"),
    ("waiting", ("tint-waiting", "panel"), 4.5, "blocked banner heading"),
    ("text", ("tint-accent", "panel"), 4.5, "help: Tailscale detected"),
    ("text", ("tint-waiting", "panel"), 4.5, "help: Tailscale missing"),
    ("danger", ("tint-danger", "panel"), 4.5, "help: funnel warning"),
    ("danger", ("tint-danger", "panel"), 4.5, "new-agent dialog error"),
    ("text", ("tint-danger", "panel"), 4.5, "confirm dialog: what is lost"),
    ("danger", ("tint-danger", "panel"), 4.5, "destructive button, hovered"),
    ("text", ("tint-focus", "panel"), 4.5, "settings menu: the chosen item"),
    ("dim", ("tint-focus", "panel"), 4.5, "settings menu: its icon"),
    ("text", ("tint-focus", "panel"), 4.5, "primary button in a dialog"),
    ("text", ("tint-focus", "bg"), 4.5, "primary button, folder browser"),
    ("text", ("tint-focus", "bg"), 4.5, "pressed filter chip"),
    ("text", ("tint-focus", "panel"), 4.5, "pressed chip, new-agent dialog"),
    ("waiting", "panel-2", 3.0, "Open terminal button edge"),
    ("danger", "panel-2", 3.0, "destructive button edge"),
    ("focus", ("tint-focus", "panel"), 3.0, "primary button edge on its fill"),
]
"""
Every wash the stylesheets draw something on, and every control edge. Each side
is a token, or `(overlay, base)`: one of the `--tint-*` tokens `gen-themes.py`
emits, flattened over the surface it actually sits on. The overlay's colour and
strength are read from `tokens.css` itself, so a change to a percentage in the
generator moves every pair drawn on it. A control's edge is measured over the
`--panel-2` fill of the button it outlines (WCAG 1.4.11), at the full token.
"""

OVERLAY = re.compile(
    r"--((?:tint|edge)-[a-z0-9-]+):\s*color-mix\(in srgb, var\(--([a-z0-9-]+)\) (\d+)%, transparent\)"
)
"""One generated translucent token, as `gen-themes.py` writes it."""
PERCENT = 100


def overlays(css: str) -> dict[str, tuple[str, float]]:
    """Every `--tint-*`/`--edge-*` token in the file: the token it mixes, and how much."""
    return {name: (of, int(percent) / PERCENT) for name, of, percent in OVERLAY.findall(css)}


def unaudited_tints(found: dict[str, tuple[str, float]]) -> list[str]:
    """Tints the stylesheet can draw text on that no composite measures.

    Edges are decorative, and exempt from 1.4.11 when the control's own edge is
    the full token; a tint is a surface, and a surface nothing measures is how
    the mock banner shipped at 4.04:1.
    """
    measured = {side[0] for pair in COMPOSITES for side in pair[:2] if isinstance(side, tuple)}
    return sorted(name for name in found if name.startswith("tint-") and name not in measured)


class Palette:
    """One scheme in one mode, with the overlays every palette shares."""

    def __init__(self, tokens: dict[str, str], mixes: dict[str, tuple[str, float]]):
        self.tokens = tokens
        self.mixes = mixes

    def surface(self, spec: str | tuple[str, str]) -> str | None:
        """The hex a token or a flattened overlay comes to, or None if a token is missing."""
        if isinstance(spec, str):
            return self.tokens.get(spec)
        overlay, base = spec
        if overlay not in self.mixes:
            return None
        of, fraction = self.mixes[overlay]
        if of not in self.tokens or base not in self.tokens:
            return None
        return composite(self.tokens[of], self.tokens[base], fraction)

    def describe(self, spec: str | tuple[str, str]) -> str:
        """How an entry names one side of a pair, for the report."""
        if isinstance(spec, str):
            return f"--{spec}"
        overlay, base = spec
        of, fraction = self.mixes.get(overlay, ("?", 0.0))
        return f"--{overlay} (--{of} {round(fraction * PERCENT)}%) over --{base}"


def audit_composites(palette: Palette) -> int:
    """Measure every composite pair in one palette; returns how many fail.

    A pair whose overlay or token cannot be found counts as a failure, not a
    skip: a renamed token would otherwise drop its pairs from the audit while
    the summary still read "0 failing".
    """
    failures = 0
    for fg, bg, need, label in COMPOSITES:
        front, back = palette.surface(fg), palette.surface(bg)
        if front is None or back is None:
            failures += 1
            print(f"  FAIL  {label}: {palette.describe(fg)} on {palette.describe(bg)} is not in tokens.css")
            continue
        value = ratio(front, back)
        ok = value >= need
        if not ok:
            failures += 1
        print(
            f"  {'PASS' if ok else 'FAIL'}  {value:5.2f}:1 (need {need})  "
            f"{label:36} {front} on {back} ({palette.describe(fg)} on {palette.describe(bg)})"
        )
    return failures


def composite(tint: str, base: str, fraction: float) -> str:
    """Flatten `color-mix(in srgb, <tint> N%, transparent)` drawn over `base`."""
    t, b = parse_hex(tint), parse_hex(base)
    mixed = tuple(round(t[i] * fraction + b[i] * (1 - fraction)) for i in range(3))
    return "#%02x%02x%02x" % mixed


def parse_hex(value: str) -> tuple[int, int, int]:
    h = value.strip().lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    if len(h) != 6:
        raise ValueError(f"bad hex: {value!r}")
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))


def _linear(channel: int) -> float:
    c = channel / 255
    return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4


def luminance(rgb: tuple[int, int, int]) -> float:
    r, g, b = (_linear(c) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def ratio(fg: str, bg: str) -> float:
    a, b = luminance(parse_hex(fg)), luminance(parse_hex(bg))
    lighter, darker = max(a, b), min(a, b)
    return (lighter + 0.05) / (darker + 0.05)


def palettes(css: str) -> dict[str, dict[str, str]]:
    """Every palette in the file: each scheme, in each mode.

    Found rather than listed. `tokens.css` is generated from
    `scripts/gen-themes.py`, and a list of scheme names here would be a second
    place to remember to update — so a scheme added there and forgotten here
    would ship unaudited, which is the one outcome this script exists to
    prevent. Anything that declares the token set is a palette and is measured.

    Two selectors are deliberately skipped. The `prefers-color-scheme` copies
    are byte-identical to the explicit light blocks by construction, and the
    `[data-theme='dark']` ones to the base blocks; auditing them would double
    every line of output to say the same thing twice.
    """
    palettes: dict[str, dict[str, str]] = {}

    # Each `<selector> { ... }` block at the top level, plus the ones nested one
    # level inside a media query.
    for match in re.finditer(r"(:root[^{]*)\{([^{}]*)\}", css):
        selector = match.group(1).strip()
        tokens = dict(re.findall(r"--([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})", match.group(2)))
        # A block that sets no colours is structure, not a palette.
        if "bg" not in tokens or "text" not in tokens:
            continue
        lookback = match.start() - MEDIA_QUERY_LOOKBACK
        if "prefers-color-scheme" in css[max(0, lookback) : match.start()]:
            continue
        if "[data-theme='dark']" in selector:
            continue

        scheme_match = re.search(r"\[data-scheme='([a-z0-9-]+)'\]", selector)
        scheme = scheme_match.group(1) if scheme_match else "default"
        mode = "light" if "[data-theme='light']" in selector else "dark"
        palettes[f"{scheme} {mode}"] = tokens

    return palettes


def main() -> int:
    if len(sys.argv) == 3:
        value = ratio(sys.argv[1], sys.argv[2])
        print(f"{sys.argv[1]} on {sys.argv[2]}: {value:.2f}:1")
        print(f"  normal text AA (4.5:1): {'PASS' if value >= 4.5 else 'FAIL'}")
        print(f"  UI / large   AA (3.0:1): {'PASS' if value >= 3.0 else 'FAIL'}")
        return 0 if value >= 4.5 else 1

    css = TOKENS.read_text()
    found = palettes(css)
    if len(found) < 2:
        print(f"!! only {len(found)} palette(s) parsed from {TOKENS} — the file changed shape")
        return 1
    mixes = overlays(css)
    failures = 0
    for name in unaudited_tints(mixes):
        print(f"!! --{name} is a wash no COMPOSITES entry measures")
        failures += 1
    for theme, tokens in found.items():
        if not tokens:
            print(f"!! could not parse the {theme} palette from {TOKENS}")
            failures += 1
            continue
        print(f"\n=== {theme.upper()} ===")
        for fg, bg, need, label in PAIRS:
            if fg not in tokens or bg not in tokens:
                print(f"  SKIP  {label} (missing --{fg} or --{bg})")
                continue
            value = ratio(tokens[fg], tokens[bg])
            ok = value >= need
            if not ok:
                failures += 1
            print(
                f"  {'PASS' if ok else 'FAIL'}  {value:5.2f}:1 (need {need})  "
                f"{label:36} {tokens[fg]} on {tokens[bg]}"
            )

        failures += audit_composites(Palette(tokens, mixes))

    print(f"\n{len(found)} palette(s) audited, {failures} failing pair(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
