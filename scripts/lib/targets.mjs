/**
 * Which controls a touch-target sweep measures — written down once, because
 * four sweeps ask the question and they have to agree on the answer.
 *
 * WCAG 2.2 SC 2.5.8 (Target Size, Minimum) exempts a target that is inline in
 * a sentence or block of text: its height is the line it sits in, and there is
 * no honest way to make a word in a paragraph 40px tall. `src/web/components/
 * Message.tsx` marks exactly those links `data-inline` — the URLs an agent
 * wrote into a chat message (INV-18) — and nothing else in the app carries the
 * attribute. So `:not([data-inline])` is the exemption and the whole of it.
 *
 * The exemption keys on that attribute and not on `data-testid`, because a
 * test id names a thing for a test to find and gets renamed when the thing
 * moves; `data-inline` names the property the sweep is waiving. `e2e/
 * responsive.spec.ts` reads the same marker so the four sweeps cannot drift
 * apart on which links are exempt.
 *
 * An exempt link is still a control: the a11y audit's accessible-name check
 * and the e2e sweep's `unnamed` check both keep it. Only the size floor is
 * waived.
 */

/** The inline exception, as a selector fragment. */
export const NOT_INLINE = ':not([data-inline])'

/** What `audit-ux` and `audit-mobile` measure at phone width. */
export const TOUCH_TARGETS = `button, a${NOT_INLINE}, input`

/** What `audit-a11y` holds to 2.5.8's 24x24 — the same set, spelled the way that audit already did. */
export const TARGET_SIZE_CONTROLS = `button, a[href]${NOT_INLINE}, [role="tab"], input[type="checkbox"]`
