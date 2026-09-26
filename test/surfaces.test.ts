/**
 * INV-17's declared action list, checked the direction a render cannot check.
 *
 * `src/shared/surfaces.ts` explains why `AGENT_SCREEN_ACTIONS` is a literal
 * array rather than something read off a rendered tree: a *discovered* list
 * would shrink along with a control that stopped rendering everywhere, which
 * is the exact failure INV-17 exists to catch, and a "compare the shapes"
 * test built on one would agree with itself and say nothing.
 *
 * That safety comes at a cost the render-based tests cannot pay back: nothing
 * stops the declared list itself from going stale the other way — a rename in
 * the component, a copy-paste typo, an id nobody ever wired up. Comparing it
 * against a *render* would reintroduce the exact blind spot above, so this
 * reads the component source instead: every declared id has to name a real
 * `data-testid` on an interactive element somewhere under `src/web/components`.
 * A source string cannot "agree with itself" the way a render can — the id is
 * either written down as an attribute value or it is not.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AGENT_SCREEN_ACTIONS } from '../src/shared/surfaces.ts'

const COMPONENTS = resolve('src/web/components')

/** Every interactive element this app hangs a `data-testid` off of. */
const INTERACTIVE_TAGS = ['Button', 'button', 'select', 'textarea', 'input', 'a']

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return entry.name.endsWith('.tsx') ? [path] : []
  })
}

/**
 * The index of the opening tag's closing `>`, starting from its `<`.
 *
 * Brace- and quote-aware for the reason `test/icons.test.ts` already learned
 * this the hard way: an attribute value is arbitrary JavaScript, and
 * `onClick={() => f()}` puts a `>` inside the tag at brace depth 1. This app's
 * own comments learned it a second way — a JSX attribute is commented in full
 * sentences, and "the IME's Enter" has a bare `'` that is not a string
 * delimiter. So `//` and `/* *\/` regions are skipped whole rather than
 * scanned, and a backslash inside a string is not read as its own character,
 * or `'don\'t'` closes the string one character early.
 */
function endOfOpeningTag(source: string, openStart: number): number {
  let depth = 0
  let quote: string | null = null
  for (let i = openStart; i < source.length; i++) {
    const ch = source[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i)
      if (end === -1) return -1
      i = end
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      if (end === -1) return -1
      i = end + 1
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch
    else if (ch === '{') depth++
    else if (ch === '}') depth--
    else if (ch === '>' && depth === 0) return i
  }
  return -1
}

/**
 * The `data-testid` an opening tag carries, split into what a declared id can
 * be matched against.
 *
 * A literal (`data-testid="clear-agent"`) is an exact id. A template
 * (`` data-testid={`send-mode-${mode}`} ``) names a family rather than one id
 * — `mode` is a runtime value this static read cannot resolve — so it
 * contributes the literal text before the first `${` as a prefix instead.
 */
function testIdsIn(openingTag: string): { exact: string[]; prefixes: string[] } {
  const exact: string[] = []
  const prefixes: string[] = []
  for (const match of openingTag.matchAll(/data-testid=(?:"([^"]+)"|\{`([^`]*)`\})/g)) {
    const [, literal, template] = match
    if (literal !== undefined) exact.push(literal)
    else if (template) {
      // A template with nothing but an expression (`` `${x}` ``) has no
      // static prefix, and an empty prefix would match every declared id —
      // the vacuous match this whole file exists to avoid.
      const prefix = template.split('${')[0]
      if (prefix) prefixes.push(prefix)
    }
  }
  return { exact, prefixes }
}

/** Every `data-testid` this app puts on something a reader can click or type into. */
function interactiveTestIds(): { exact: Set<string>; prefixes: string[] } {
  const exact = new Set<string>()
  const prefixes: string[] = []
  for (const file of sources(COMPONENTS)) {
    const source = readFileSync(file, 'utf8')
    for (const tag of INTERACTIVE_TAGS) {
      for (const start of source.matchAll(new RegExp(`<${tag}(?=[\\s/>])`, 'g'))) {
        const openStart = start.index ?? -1
        if (openStart === -1) continue
        const closeAt = endOfOpeningTag(source, openStart)
        if (closeAt === -1) continue
        const found = testIdsIn(source.slice(openStart, closeAt + 1))
        found.exact.forEach((id) => exact.add(id))
        prefixes.push(...found.prefixes)
      }
    }
  }
  return { exact, prefixes }
}

describe('the INV-17 action list names real controls', () => {
  it('every declared id reaches an interactive element in the component source', () => {
    const { exact, prefixes } = interactiveTestIds()
    const missing = AGENT_SCREEN_ACTIONS.filter(
      (id) => !exact.has(id) && !prefixes.some((prefix) => id.startsWith(prefix)),
    )
    expect(missing, `declared but not found in any component: ${missing.join(', ')}`).toEqual([])
  })
})
