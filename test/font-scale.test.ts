/**
 * Every type size comes from the scale in `tokens.css`.
 *
 * Seventeen `font:` shorthands carried a literal pixel size — 11px five times,
 * 12px seven, 13px four, 14px once, and a lone 10px — so a size could drift off
 * the six-step scale without anything comparing it to anything, which is how
 * nine monospace sizes once accumulated. A size is a token now.
 *
 * The one exception is a requirement rather than a scale step: iOS zooms the
 * page when a focused field renders under 16px, so `font-size: 16px` is allowed
 * where it lives, inside a `pointer: coarse` query, and nowhere else.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = 'src/web'

/** The generated token sheet defines the scale; every other sheet spends it. */
const SCALE_SHEET = 'tokens.css'

const COARSE = /@media[^{]*pointer:\s*coarse/
const PX = /\d(\.\d+)?px/
const FONT_DECLARATION = /^\s*(font|font-size)\s*:\s*([^;]+)/

function sheets(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sheets(path)
    return entry.name.endsWith('.css') && entry.name !== SCALE_SHEET ? [path] : []
  })
}

/** A literal-px font declaration, with the block preludes it sits inside. */
interface Finding {
  where: string
  property: string
  value: string
  preludes: string[]
}

const CSS_COMMENT = new RegExp('/\\*[\\s\\S]*?\\*/', 'g')

/** Comments blanked to their newlines, so line numbers still point at the file. */
function withoutComments(css: string): string {
  return css.replace(CSS_COMMENT, (comment) => comment.replace(/[^\n]/g, ''))
}

/** The px font declaration in one `prop: value` chunk, if that is what it is. */
function pxFont(chunk: string, where: string, preludes: string[]): Finding | null {
  const match = FONT_DECLARATION.exec(chunk)
  if (!match || !PX.test(match[2] ?? '')) return null
  return { where, property: match[1] ?? '', value: (match[2] ?? '').trim(), preludes: [...preludes] }
}

/**
 * Walk a stylesheet brace by brace, so a declaration knows which `@media`
 * block it is in. Comments go first: their prose mentions `16px` and braces.
 */
function fontDeclarations(file: string): Finding[] {
  const css = withoutComments(readFileSync(file, 'utf8'))
  const found: Finding[] = []
  const stack: string[] = []
  let chunk = ''
  let line = 1
  for (const char of css) {
    if (char === '\n') line += 1
    if (char === '{') {
      stack.push(chunk.trim())
      chunk = ''
    } else if (char === ';' || char === '}') {
      const finding = pxFont(chunk, `${file}:${line}`, stack)
      if (finding) found.push(finding)
      chunk = ''
      if (char === '}') stack.pop()
    } else {
      chunk += char
    }
  }
  return found
}

function isIosZoomFloor(finding: Finding): boolean {
  return (
    finding.property === 'font-size' &&
    finding.value === '16px' &&
    finding.preludes.some((prelude) => COARSE.test(prelude))
  )
}

describe('type sizes come from the scale', () => {
  it('no stylesheet writes a px size into font or font-size', () => {
    const offenders = sheets(ROOT)
      .flatMap(fontDeclarations)
      .filter((finding) => !isIosZoomFloor(finding))
      .map((finding) => `${finding.where} ${finding.property}: ${finding.value}`)
    expect(offenders, `literal px font sizes:\n${offenders.join('\n')}`).toEqual([])
  })

  it('still finds the iOS 16px floor, so the exception is not vacuous', () => {
    const floors = sheets(ROOT).flatMap(fontDeclarations).filter(isIosZoomFloor)
    expect(floors.length).toBeGreaterThan(0)
  })
})
