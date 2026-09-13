/**
 * The icon set: that it is generated, and that it never becomes a name.
 *
 * The shapes are drawn in `scripts/gen-ui-icons.py` and this holds the checkout to
 * it, the same way `scheme.test.ts` holds `tokens.css` to `gen-themes.py`. That
 * contract is the reason the set is generated at all: fifteen hand-kept SVG
 * strings in a `Record` have nothing checking that they still share a grid, a
 * stroke or a margin, which is exactly how the Unicode glyphs they replaced
 * came to be drawn from seven different Unicode blocks.
 *
 * The second half matters more. Those glyphs sat inside their buttons *as
 * text*, and `textContent` is something an accessibility tree will use as an
 * accessible name — `scripts/audit-a11y.mjs` accepts it, so a bare arrow passed
 * 4.1.2 while telling a screen reader nothing useful. Replacing one with an
 * `aria-hidden` SVG empties `textContent`, so any button that was leaning on
 * its glyph loses its name outright and no gate here would say so. Hence the
 * sweep below: every button carrying an icon has to name itself.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ICON_PATHS, ICON_STROKE, ICON_VIEWBOX } from '../src/web/lib/icon-paths.ts'

const COMPONENTS = resolve('src/web/components')

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return entry.name.endsWith('.tsx') ? [path] : []
  })
}

describe('the icon set is generated', () => {
  it('re-running the generator reproduces the module byte for byte', () => {
    const generated = execFileSync('python3', ['scripts/gen-ui-icons.py'], {
      encoding: 'utf8',
      timeout: 60_000,
    })
    const onDisk = readFileSync(resolve('src/web/lib/icon-paths.ts'), 'utf8')
    expect(
      generated === onDisk
        ? true
        : 'icon-paths.ts differs from the generator: run `python3 scripts/gen-ui-icons.py --write`',
    ).toBe(true)
  })

  it('draws every icon on one grid at one weight', () => {
    expect(ICON_VIEWBOX).toBe(24)
    expect(ICON_STROKE).toBe(1.7)
    for (const [name, body] of Object.entries(ICON_PATHS)) {
      expect(body.length, `${name} is empty`).toBeGreaterThan(0)
      // A shape that sets its own colour would break in fifteen of the sixteen
      // palettes, and it is the single easiest thing to paste in by accident.
      expect(body, `${name} hard-codes a colour`).not.toMatch(/fill="(?!none)|stroke="/)
    }
  })
})

/**
 * The index of the `>` that closes a JSX opening tag, or -1.
 *
 * Brace-aware, because an attribute value is arbitrary JavaScript and
 * `onClick={() => f()}` puts a `>` inside the tag. Quote-aware for the same
 * reason at one remove: `title=">"` is legal and rare, and costs one branch.
 */
function endOfOpeningTag(block: string): number {
  let depth = 0
  let quote: string | null = null
  for (let i = 0; i < block.length; i++) {
    const ch = block[i]
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch
    else if (ch === '{') depth++
    else if (ch === '}') depth--
    else if (ch === '>' && depth === 0) return i
  }
  return -1
}

describe('an icon is never a button name', () => {
  /*
   * The regression this exists for: a glyph inside a button *is* its name until
   * something takes it away. Converting to an aria-hidden SVG takes it away.
   */
  it('every button rendering an Icon also labels itself', () => {
    const offenders: string[] = []
    for (const file of sources(COMPONENTS)) {
      const source = readFileSync(file, 'utf8')
      if (!source.includes('<Icon')) continue
      for (const match of source.matchAll(/<(Button|button)\b[\s\S]*?<\/\1>/g)) {
        const block = match[0]
        if (!block.includes('<Icon')) continue
        /*
         * Either the button names itself, or it still has text beside the icon
         * to be named by.
         *
         * Both halves of that were got wrong once, and the second wrongly in a
         * way that made this whole sweep toothless — so the method matters.
         *
         * Reading what follows `<Icon/>` failed first: `FolderBrowser` wraps
         * its icon in a `<span>`, so what follows is `</span>`, not the name.
         * Stripping tags with `/<[^>]*>/` failed next and worse: a JSX opening
         * tag routinely contains an arrow function, and the `>` in `() => !v`
         * ends that match early, so `setOpen((v) => !v)}` survived as
         * "remaining text" and *every* such button looked labelled. Deleting
         * a real `aria-label` did not fail this test until it was fixed.
         *
         * So the opening tag is found by scanning for the first `>` at brace
         * depth zero, and only what is genuinely between the tags is examined.
         */
        const openEnd = endOfOpeningTag(block)
        const children = openEnd === -1 ? '' : block.slice(openEnd + 1, block.lastIndexOf('</'))
        const remainder = children
          .replace(/<Icon[\s\S]*?\/>/g, '')
          .replace(/<[^>]*>/g, '')
          .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
          .trim()
        const labelled =
          block.includes('aria-label') ||
          block.includes('aria-labelledby') ||
          remainder.length > 0
        if (!labelled) {
          const line = source.slice(0, match.index).split('\n').length
          offenders.push(`${file.replace(`${process.cwd()}/`, '')}:${line}`)
        }
      }
    }
    expect(offenders, `icon-only buttons with no accessible name: ${offenders.join(', ')}`).toEqual(
      [],
    )
  })
})
