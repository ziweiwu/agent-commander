/**
 * A container that scrolls says so at the edge it scrolls past.
 *
 * jsdom lays nothing out, so what is tested here is the decision the hook
 * makes from a box's measurements; the e2e spec measures the real thing.
 */
import { describe, expect, it } from 'vitest'
import { edgesOf } from '../../src/web/hooks/useOverflowEdge.ts'

const box = (over: Partial<Parameters<typeof edgesOf>[0]>) => ({
  scrollTop: 0,
  scrollLeft: 0,
  scrollHeight: 100,
  scrollWidth: 100,
  clientHeight: 100,
  clientWidth: 100,
  ...over,
})

describe('the overflow edge', () => {
  it('is none for a box that holds all of its content', () => {
    expect(edgesOf(box({}))).toBe('none')
  })

  it('is the bottom while content is below the fold', () => {
    expect(edgesOf(box({ scrollHeight: 300 }))).toBe('bottom')
  })

  it('lifts once the end has been scrolled into view', () => {
    expect(edgesOf(box({ scrollHeight: 300, scrollTop: 200 }))).toBe('none')
  })

  it('is the right edge for a sideways scroller', () => {
    expect(edgesOf(box({ scrollWidth: 800 }))).toBe('right')
  })

  it('names both edges when both have content past them', () => {
    expect(edgesOf(box({ scrollHeight: 300, scrollWidth: 800 }))).toBe('bottom right')
  })

  // Fractional layout leaves scrollHeight a hair over clientHeight on a box
  // that does not scroll at all; a fade there would suggest content that is
  // not there.
  it('ignores a sub-pixel difference', () => {
    expect(edgesOf(box({ scrollHeight: 100.6 }))).toBe('none')
  })
})
