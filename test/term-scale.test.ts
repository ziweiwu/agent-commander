/**
 * Terminal scaling. This is what makes the Attach tab usable on a phone: a
 * 150-column pane shrunk to fit a 390px screen renders at about 4.6px.
 */
import { describe, expect, it } from 'vitest'
import { computeScale } from '../src/web/lib/term.ts'

// Roughly what a 150x47 pane measures at the 13px base font.
const WIDE_PANE = 1174
const NARROW_PANE = 640

describe('computeScale (readable)', () => {
  const readable = (naturalWidth: number, available: number) =>
    computeScale({ naturalWidth, available, zoom: 'readable' })

  it('leaves a pane that already fits alone', () => {
    const r = readable(NARROW_PANE, 900)
    expect(r.scale).toBe(1)
    expect(r.overflowing).toBe(false)
  })

  it('shrinks to fit on a desktop pane while staying legible', () => {
    const r = readable(WIDE_PANE, 942)
    expect(r.scale).toBeCloseTo(0.8, 1)
    expect(r.overflowing).toBe(false)
    expect(r.effectiveFont).toBeGreaterThan(9.5)
  })

  // The whole point: below the floor it pans rather than becoming unreadable.
  it('refuses to shrink below the legibility floor on a phone', () => {
    const r = readable(WIDE_PANE, 366)
    expect(r.effectiveFont).toBeGreaterThanOrEqual(9.5)
    expect(r.overflowing).toBe(true)
  })

  it('stays legible even on a very narrow screen', () => {
    for (const width of [320, 360, 390, 430]) {
      expect(readable(WIDE_PANE, width).effectiveFont).toBeGreaterThanOrEqual(9.5)
    }
  })

  it('never scales a pane up beyond its captured size', () => {
    expect(readable(400, 2000).scale).toBe(1)
  })
})

describe('computeScale (fit)', () => {
  const fit = (naturalWidth: number, available: number) =>
    computeScale({ naturalWidth, available, zoom: 'fit' })

  it('shrinks all the way so the whole pane is visible', () => {
    const r = fit(WIDE_PANE, 366)
    expect(r.overflowing).toBe(false)
    expect(r.scale).toBeCloseTo(366 / WIDE_PANE, 2)
  })

  it('accepts illegible text as the price of seeing everything', () => {
    expect(fit(WIDE_PANE, 366).effectiveFont).toBeLessThan(9.5)
  })

  it('still never scales up', () => {
    expect(fit(400, 2000).scale).toBe(1)
  })
})

describe('computeScale (degenerate input)', () => {
  // xterm reports 0 before it has laid out; scaling by 0 would blank the pane.
  it('returns a neutral scale when nothing has been measured yet', () => {
    expect(computeScale({ naturalWidth: 0, available: 500, zoom: 'readable' })).toMatchObject({
      scale: 1,
      overflowing: false,
    })
    expect(computeScale({ naturalWidth: 800, available: 0, zoom: 'fit' })).toMatchObject({
      scale: 1,
    })
  })
})

describe('computeScale (full screen)', () => {
  // In the panel the capture stays 1:1; full screen is the only place it grows,
  // because there it is the only thing on the display.
  it('never enlarges by default', () => {
    expect(computeScale({ naturalWidth: 600, available: 1400, zoom: 'readable' }).scale).toBe(1)
  })

  it('fills a large screen when allowed to', () => {
    const r = computeScale({ naturalWidth: 600, available: 1400, zoom: 'readable', maxScale: 2.5 })
    expect(r.scale).toBeCloseTo(1400 / 600, 2)
    expect(r.overflowing).toBe(false)
  })

  it('respects the ceiling rather than growing without bound', () => {
    const r = computeScale({ naturalWidth: 200, available: 2000, zoom: 'readable', maxScale: 2.5 })
    expect(r.scale).toBe(2.5)
  })

  it('still shrinks a pane that is too wide, ceiling or not', () => {
    const r = computeScale({ naturalWidth: 1174, available: 366, zoom: 'fit', maxScale: 2.5 })
    expect(r.scale).toBeLessThan(1)
  })
})
