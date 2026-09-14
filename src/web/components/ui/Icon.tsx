import { ICON_PATHS, ICON_STROKE, ICON_VIEWBOX, type IconName } from '../../lib/icon-paths.ts'

export type { IconName }

/*
 * The three sizes, named because a bare 11 in a component says nothing about
 * why it is not 12.
 *
 * They are optical rather than arbitrary: a stroke drawn on a 24px grid and
 * scaled down needs to land on whole pixels to stay crisp, and each of these
 * sits with a particular text size. Anything else is drift, which is the same
 * argument that collapsed nine stray font sizes onto the type scale.
 */
/** Inside a chip or a status mark, beside 11px text. */
export const ICON_MARK = 11
/** Inline in a row of 12-13px text: a disclosure chevron, a sort arrow. */
export const ICON_INLINE = 12
/** The default: an icon button's own face. */
export const ICON_BUTTON = 16

export interface IconProps {
  name: IconName
  /** Rendered size in px. The grid is square, so this is both dimensions. */
  size?: number
}

/**
 * One control face, drawn from the generated set.
 *
 * **It is always `aria-hidden`, and that is the contract rather than a
 * default.** An icon here replaces a Unicode glyph that used to sit inside the
 * button as its text, and `textContent` is something the accessibility tree
 * will happily use as a name — the app's own `audit-a11y.mjs` accepts it. So
 * swapping a glyph for a decorative SVG silently removes the name from any
 * button that was relying on the character. Every icon button in this app
 * already carries an explicit `aria-label` (checked before this landed), and
 * `test/icons.test.ts` holds that line: the icon says nothing, the button says
 * everything.
 *
 * `focusable="false"` because IE-era SVG lands in the tab order otherwise, and
 * a decorative child stealing a tab stop is the same defect wearing a
 * different hat.
 *
 * No colour is set. The stroke is `currentColor`, so one set serves all sixteen
 * palettes in both modes and an icon is always exactly as bright as the text
 * beside it — including when a parent dims it for a disabled control.
 */
export function Icon({ name, size = ICON_BUTTON }: IconProps) {
  return (
    <svg
      viewBox={`0 0 ${ICON_VIEWBOX} ${ICON_VIEWBOX}`}
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      // The set is generated and the strings are literals in a checked-in
      // module, never anything a user or an agent supplied — which is what
      // makes this the one safe use of the escape hatch here. The alternative
      // is parsing SVG into React elements at build time for no benefit.
      dangerouslySetInnerHTML={{ __html: ICON_PATHS[name] }}
    />
  )
}
