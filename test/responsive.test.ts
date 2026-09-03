/**
 * INV-17, the half a component test cannot see: what the stylesheets take away
 * on a smaller screen.
 *
 * The three layouts are one component tree under different widths, and the way
 * this app narrows is CSS — `display: none` inside a width query. That is the
 * cheapest possible way to lose a feature on a phone, and the loss is
 * invisible to every other gate: the element is in the DOM, so a component
 * test finds it, and the e2e suite only fails if a test happens to click the
 * thing that vanished.
 *
 * So the rule is inverted. Every selector any viewport query hides is
 * enumerated below with what it is, and a selector that is not on the list
 * fails this test rather than shipping. Adding a hidden label means adding a
 * line here; hiding a *control* means writing down what restores it, which is
 * the sentence that makes it a design decision rather than an omission.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const CSS_DIRS = ['src/web/components', 'src/web/styles']

/** What a hidden selector is, and — if it is a control — what brings it back. */
interface Hidden {
  /** Why hiding it costs the reader nothing they cannot get. */
  reason: string
  /**
   * Set only for something interactive. An action may narrow out of a layout,
   * but it may not narrow out of the *app*: this names the step that reaches
   * it, and its presence is what stops the list absorbing a real loss.
   */
  restoredBy?: string
}

/**
 * Every selector a viewport query is allowed to hide.
 *
 * Keyed by the selector exactly as the stylesheet writes it, so a rename shows
 * up here as a failure rather than as silent drift.
 */
const ALLOWED: Record<string, Hidden> = {
  // Labels whose glyph or control still says what they said.
  '.sheet .backLabel': { reason: 'the ‹ chevron is still the way back' },
  '.stopLabel': { reason: 'replaced by .stopGlyph, which is shown in the same query' },
  '.senseLabel': { reason: 'the arrow carries the direction; the word is the tooltip' },
  '.label': { reason: 'the select still names the mode, and .labelShort replaces the chip label' },
  '.note': { reason: 'the toggle still says whether a goal is running' },
  ":global([data-sheet='true']) .reset": {
    reason: 'how full is the number you act on; when it refills is not',
  },

  // Keyboard hints, which are true but not load-bearing — and describe keys a
  // touch device does not have.
  '.hint': { reason: 'the keys it names still work; a phone has no hardware keyboard to use them' },

  // Decoration and chrome that name nothing about the agent on screen.
  '.gutter': { reason: 'the message rail is decorative; grouping survives it' },
  '.sheetMode .title': { reason: "the sheet's own header names what is open" },
  '.statusLine': {
    reason:
      'a readout, not a control: the mode is on the strip’s own button and the delegates are on the card; a landscape phone needs the height for the conversation',
  },

  // The one control a layout takes away, and the step that reaches it.
  '.sheetMode .filters': {
    reason: 'the filters act on the fleet list, which the sheet is covering',
    restoredBy: 'leaving the sheet — the back button, Escape, or the browser back gesture',
  },
}

/** A query about the shape of the viewport, as against a preference or a theme. */
function isViewportQuery(condition: string): boolean {
  return /\b(?:min|max)-(?:width|height)\b/.test(condition)
}

interface HiddenSelector {
  file: string
  condition: string
  selector: string
}

/**
 * Every selector hidden by a viewport query, across the app's stylesheets.
 *
 * A brace scanner rather than a regex over the whole file: `@media` bodies
 * nest, and a pattern that assumed they did not would quietly stop matching
 * the day one does.
 */
function hiddenByViewport(): HiddenSelector[] {
  return stylesheets().flatMap(hiddenIn)
}

/** Every stylesheet the app ships, comments already stripped. */
function stylesheets(): { file: string; css: string }[] {
  return CSS_DIRS.flatMap((dir) =>
    readdirSync(dir)
      .filter((name) => name.endsWith('.css'))
      .map((name) => {
        const file = join(dir, name)
        // Comments first: one of them contains a `{`, and a scanner that read
        // it as a rule reported the prose as a hidden selector.
        return { file, css: readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '') }
      }),
  )
}

function hiddenIn({ file, css }: { file: string; css: string }): HiddenSelector[] {
  return mediaBlocks(css)
    .filter((block) => isViewportQuery(block.condition))
    .flatMap((block) =>
      rulesIn(block.body)
        .filter((rule) => /display:\s*none/.test(rule.body))
        .flatMap((rule) =>
          rule.selector
            .split(',')
            .map((selector) => ({ file, condition: block.condition, selector: selector.trim() })),
        ),
    )
}

function mediaBlocks(css: string): { condition: string; body: string }[] {
  const blocks: { condition: string; body: string }[] = []
  const at = /@media([^{]*)\{/g
  let match: RegExpExecArray | null
  while ((match = at.exec(css)) !== null) {
    const open = match.index + match[0].length
    let depth = 1
    let index = open
    while (index < css.length && depth > 0) {
      if (css[index] === '{') depth += 1
      if (css[index] === '}') depth -= 1
      index += 1
    }
    blocks.push({ condition: (match[1] ?? '').trim(), body: css.slice(open, index - 1) })
  }
  return blocks
}

/** The `selector { … }` rules directly inside a block, ignoring nested ones. */
function rulesIn(body: string): { selector: string; body: string }[] {
  return [...body.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap((m) =>
    m[1] === undefined || m[2] === undefined ? [] : [{ selector: m[1].trim(), body: m[2] }],
  )
}

describe('INV-17 the three layouts differ in labelling, not in capability', () => {
  it('hides nothing a viewport query has not been given permission to hide', () => {
    const surprises = hiddenByViewport()
      .filter(({ selector }) => ALLOWED[selector] === undefined)
      .map(({ file, condition, selector }) => `${file}: @media ${condition} hides ${selector}`)
    expect(
      surprises,
      'a viewport query hides something this list does not account for — say what it is, ' +
        'and if it is a control, what reaches it on that screen',
    ).toEqual([])
  })

  /*
   * The list is a claim too, so it decays. An entry for a selector nothing
   * hides any more is false debt, and the next reader would take it as
   * evidence that a control is unreachable on a phone when it is not.
   */
  it('keeps no permission for something nothing hides', () => {
    const hidden = new Set(hiddenByViewport().map((h) => h.selector))
    const stale = Object.keys(ALLOWED).filter((selector) => !hidden.has(selector))
    expect(stale, `nothing hides these any more — drop them: ${stale.join(', ')}`).toEqual([])
  })

  /*
   * The clause that makes this an invariant rather than a style rule. An action
   * that is absent on a phone with nothing to reach it is a feature this app
   * does not have on a phone — which is the whole thing INV-17 forbids.
   */
  it('names the way back to every control a layout takes away', () => {
    const unreachable = Object.entries(ALLOWED)
      .filter(([, entry]) => entry.restoredBy !== undefined)
      .filter(([, entry]) => (entry.restoredBy ?? '').trim() === '')
      .map(([selector]) => selector)
    expect(unreachable).toEqual([])
    // `.filters` is the only one today, and it is spelled out rather than
    // counted so that a second one has to be looked at by a person.
    const actions = Object.entries(ALLOWED)
      .filter(([, entry]) => entry.restoredBy !== undefined)
      .map(([selector]) => selector)
    expect(actions).toEqual(['.sheetMode .filters'])
  })

  /*
   * Three layouts, two width cuts. There were eleven breakpoints between
   * 900px and 380px, each measured and each right, and the accumulation was
   * what nobody could hold in their head. The desktop/narrow cut at 900 and
   * the phone cut at 560 are the layouts INV-17 names; a third number here is
   * a fourth layout nobody declared.
   */
  it('draws its three layouts from two width cuts', () => {
    const cuts = new Set<number>()
    for (const { css } of stylesheets()) {
      for (const block of mediaBlocks(css)) {
        for (const m of block.condition.matchAll(/(?:min|max)-width:\s*(\d+)px/g)) {
          cuts.add(Number(m[1]))
        }
      }
    }
    // 901 is the other side of the 900 cut, not a third one.
    expect([...cuts].sort((a, b) => a - b)).toEqual([560, 900, 901])
  })
})
