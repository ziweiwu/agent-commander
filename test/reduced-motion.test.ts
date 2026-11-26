import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const GLOBAL = readFileSync('src/web/styles/global.css', 'utf8')

function reducedMotionRule(): string {
  const start = GLOBAL.indexOf('@media (prefers-reduced-motion: reduce)')
  expect(start).toBeGreaterThan(-1)
  return GLOBAL.slice(start, GLOBAL.indexOf('\n}\n', start))
}

describe('reduced motion', () => {
  it('ends transitions and animations at zero, not at a hundredth of a millisecond', () => {
    const rule = reducedMotionRule()
    expect(rule).toMatch(/transition-duration:\s*0s !important/)
    expect(rule).toMatch(/animation-duration:\s*0s !important/)
    expect(rule).not.toMatch(/0\.01ms/)
  })
})
