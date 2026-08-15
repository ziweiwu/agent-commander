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
]

# Surfaces built with color-mix rather than a flat token. Auditing only flat
# pairs missed the mock-mode banner entirely: amber text on its own 18% amber
# wash measures 4.04:1 in light, and the banner is on screen on every route.
# fg token, (tint token, base token, tint fraction), required ratio, what it is
COMPOSITES = [
    ("text", ("waiting", "bg", 0.18), 4.5, "mock-mode banner text"),
]


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
    """Pull the dark palette and the explicit light palette out of the file."""

    def block(pattern: str) -> dict[str, str]:
        match = re.search(pattern + r"\s*\{(.*?)\n\s*\}", css, re.S)
        if not match:
            return {}
        return dict(re.findall(r"--([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})", match.group(1)))

    return {
        "dark": block(r":root(?!\[)"),
        "light": block(r":root\[data-theme='light'\]"),
    }


def main() -> int:
    if len(sys.argv) == 3:
        value = ratio(sys.argv[1], sys.argv[2])
        print(f"{sys.argv[1]} on {sys.argv[2]}: {value:.2f}:1")
        print(f"  normal text AA (4.5:1): {'PASS' if value >= 4.5 else 'FAIL'}")
        print(f"  UI / large   AA (3.0:1): {'PASS' if value >= 3.0 else 'FAIL'}")
        return 0 if value >= 4.5 else 1

    css = TOKENS.read_text()
    failures = 0
    for theme, tokens in palettes(css).items():
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

        for fg, (tint, base, fraction), need, label in COMPOSITES:
            if fg not in tokens or tint not in tokens or base not in tokens:
                print(f"  SKIP  {label} (missing a token)")
                continue
            surface = composite(tokens[tint], tokens[base], fraction)
            value = ratio(tokens[fg], surface)
            ok = value >= need
            if not ok:
                failures += 1
            print(
                f"  {'PASS' if ok else 'FAIL'}  {value:5.2f}:1 (need {need})  "
                f"{label:36} {tokens[fg]} on {surface} (composited)"
            )

    print(f"\n{failures} failing pair(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
