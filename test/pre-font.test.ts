/**
 * A `<pre>` draws in the browser's own monospace unless its class names one.
 *
 * The answer card's command was a `<pre class=detail>` whose rule set a size
 * and no family, so it rendered in the user agent's Courier at 11px: the
 * command a phone is asked to approve, in the one face this app never chose,
 * beside text set in `--font-mono` everywhere else. Every `<pre>` a component
 * draws has to carry a class that says which family it means.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const COMPONENTS = 'src/web/components'

interface PreElement {
  file: string
  sheet: string
  classes: string[]
}

/**
 * The opening tag that starts at `start`, read brace-aware.
 *
 * A character class like `[^>]*` stops at the `>` inside `onClick={() => f()}`,
 * which is how `test/icons.test.ts` once read every icon button as labelled.
 */
function openingTag(source: string, start: number): string {
  let depth = 0
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') depth += 1
    if (char === '}') depth -= 1
    if (char === '>' && depth === 0) return source.slice(start, index + 1)
  }
  return source.slice(start)
}

/** Every `<pre>` in the components, with the classes it takes from its own stylesheet. */
function preElements(): PreElement[] {
  return readdirSync(COMPONENTS)
    .filter((name) => name.endsWith('.tsx'))
    .flatMap((file) => {
      const source = readFileSync(join(COMPONENTS, file), 'utf8')
      const sheet = /import\s+styles\s+from\s+'\.\/([^']+\.module\.css)'/.exec(source)?.[1] ?? ''
      return [...source.matchAll(/<pre[\s>]/g)].map((match) => {
        const tag = openingTag(source, match.index)
        const classes = [...tag.matchAll(/styles\.(\w+)/g)].map((found) => found[1] ?? '')
        return { file, sheet, classes }
      })
    })
}

/** A CSS comment, written as a string so no scanner reads its opening as one. */
const CSS_COMMENT = new RegExp('/\\*[\\s\\S]*?\\*/', 'g')

/** Whether a rule for this class sets a family, on its own or in the `font` shorthand. */
function namesAFamily(css: string, className: string): boolean {
  const selector = new RegExp(`\\.${className}(?![\\w-])`)
  return [...css.replace(CSS_COMMENT, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].some(
    ([, head = '', body = '']) => selector.test(head) && /(^|[;\s])font(-family)?\s*:/.test(body),
  )
}

describe('a <pre> names its font family', () => {
  it('finds the pre elements it guards, so an empty sweep cannot pass for a clean one', () => {
    const found = preElements().map(({ file, classes }) => `${file}:${classes.join('+')}`)
    expect(found).toEqual(expect.arrayContaining(['AnswerCard.tsx:detail', 'AnswerCard.tsx:preview']))
  })

  it('gives every pre a class whose rule sets the family', () => {
    const unset = preElements()
      .filter(({ sheet, classes }) => {
        const css = sheet ? readFileSync(join(COMPONENTS, sheet), 'utf8') : ''
        return !classes.some((className) => namesAFamily(css, className))
      })
      .map(({ file, classes }) => `${file}: <pre class=${classes.join(' ') || '(none)'}>`)
    expect(unset, 'a <pre> with no family falls back to the browser’s Courier').toEqual([])
  })
})
