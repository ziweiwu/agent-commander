/**
 * Every translucent colour the app draws is a generated token.
 *
 * Washes and edges used to be written in place, `color-mix(in srgb,
 * var(--waiting) 14%, transparent)`, eleven different percentages across eleven
 * stylesheets. `audit-contrast.py` measures the tokens `gen-themes.py` writes,
 * so a mix written in a module was a surface nobody measured: that is how faint
 * text on the user's own bubble sat at 4.497:1 in the default scheme with the
 * audit green. The generator now emits them as `--tint-*` and `--edge-*`, the
 * audit reads their strength from `tokens.css`, and this holds every module to
 * using them, the way the font stacks went into `--font-ui` and `--font-mono`.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const WEB = 'src/web'
const TOKENS = join(WEB, 'styles', 'tokens.css')
const SOURCE = /\.(css|ts|tsx|html)$/

/** Every source file under `src/web`, with the generated stylesheet left out. */
function sources(dir = WEB): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return SOURCE.test(entry.name) && path !== TOKENS ? [path] : []
  })
}

/** The `--tint-*` and `--edge-*` names `tokens.css` defines. */
function definedOverlays(): Set<string> {
  const css = readFileSync(TOKENS, 'utf8')
  return new Set([...css.matchAll(/--((?:tint|edge)-[a-z0-9-]+):\s*color-mix\(/g)].map((m) => m[1] ?? ''))
}

describe('washes and edges come from the generator', () => {
  it('finds the stylesheets it guards, so an empty sweep cannot pass for a clean one', () => {
    const files = sources()
    expect(files).toContain(join(WEB, 'components', 'AgentCard.module.css'))
    expect(files).not.toContain(TOKENS)
  })

  it('writes no raw color-mix( outside the generated tokens.css', () => {
    const raw = sources().flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, index) => (line.includes('color-mix(') ? [`${file}:${index + 1}`] : [])),
    )
    expect(raw, 'use a --tint-* or --edge-* token from gen-themes.py, so the audit can measure it').toEqual(
      [],
    )
  })

  /**
   * A misspelt custom property is not an error in CSS: `var(--tint-wating)`
   * computes to nothing, and the box simply loses its fill with every gate
   * green.
   */
  it('uses only overlay tokens the generator defines', () => {
    const defined = definedOverlays()
    expect(defined.size).toBeGreaterThan(0)
    const unknown = sources().flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/var\(--((?:tint|edge)-[a-z0-9-]+)\)/g)]
        .map((m) => m[1] ?? '')
        .filter((name) => !defined.has(name))
        .map((name) => `${file}: --${name}`),
    )
    expect(unknown).toEqual([])
  })
})
