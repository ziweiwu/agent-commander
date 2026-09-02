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

/*
 * Height only started mattering when the ceiling rose above 1.
 *
 * While a capture could only shrink, fitting the width fitted the height too,
 * so `computeScale` never measured it. Enlarging breaks that: growing a wide
 * short container's pane on width alone pushes rows off the bottom, and a
 * terminal you cannot see the last line of is worse than one that is small.
 */
describe('computeScale (height)', () => {
  it('is limited by height when that is the tighter fit', () => {
    const r = computeScale({
      naturalWidth: 600,
      available: 1800, // 3x on width alone
      naturalHeight: 400,
      availableHeight: 600, // but only 1.5x on height
      zoom: 'readable',
      maxScale: 2.5,
    })
    expect(r.scale).toBeCloseTo(1.5)
  })

  it('is limited by width when that is the tighter fit', () => {
    const r = computeScale({
      naturalWidth: 600,
      available: 900,
      naturalHeight: 400,
      availableHeight: 4000,
      zoom: 'readable',
      maxScale: 2.5,
    })
    expect(r.scale).toBeCloseTo(1.5)
  })

  it('still obeys the ceiling when both axes have room to spare', () => {
    const r = computeScale({
      naturalWidth: 200,
      available: 2000,
      naturalHeight: 100,
      availableHeight: 2000,
      zoom: 'readable',
      maxScale: 2,
    })
    expect(r.scale).toBe(2)
  })

  // A caller that measured no height is left exactly where it was, which is
  // what keeps every existing call site honest.
  it('ignores height when it was not measured', () => {
    const r = computeScale({
      naturalWidth: 600,
      available: 1800,
      naturalHeight: 0,
      availableHeight: 0,
      zoom: 'readable',
      maxScale: 2,
    })
    expect(r.scale).toBe(2)
  })

  /*
   * The box the pane lives in also holds the key bar — and, once the pane has
   * ended, a notice and a caption above it. Budgeting the whole box for the
   * capture enlarged it into room the key bar was standing in, and pushed the
   * Enter / Esc / Ctrl-C row out of the panel: on a phone, the row that answers
   * a blocked agent.
   */
  it('does not budget for the room the key bar is standing in', () => {
    const shared = {
      naturalWidth: 600,
      available: 1800,
      naturalHeight: 400,
      availableHeight: 600,
      zoom: 'readable' as const,
      maxScale: 2.5,
    }
    // Alone in the box, the capture may take all of it.
    expect(computeScale(shared).scale).toBeCloseTo(1.5)
    // Sharing it with a 200px key bar, only what is left.
    expect(computeScale({ ...shared, reservedHeight: 200 }).scale).toBeCloseTo(1.0)
  })

  it('never yields a scale that needs the whole box when something else is in it', () => {
    for (const reserved of [1, 50, 120, 300]) {
      const r = computeScale({
        naturalWidth: 600,
        available: 3000,
        naturalHeight: 400,
        availableHeight: 800,
        reservedHeight: reserved,
        zoom: 'readable',
        maxScale: 4,
      })
      expect(r.scale * 400 + reserved).toBeLessThanOrEqual(800 + 1e-9)
    }
  })

  // A box already filled by everything else has no height budget to offer, and
  // that must read as "unconstrained", not as "shrink to nothing".
  it('ignores height when the rest of the box has already used it up', () => {
    const r = computeScale({
      naturalWidth: 600,
      available: 900,
      naturalHeight: 400,
      availableHeight: 300,
      reservedHeight: 300,
      zoom: 'readable',
      maxScale: 2,
    })
    expect(r.scale).toBeCloseTo(1.5)
  })

  // Shrinking was always height-safe; adding the constraint must not make a
  // pane that has to be panned suddenly smaller than it was.
  it('does not shrink a panned pane any further for height', () => {
    const r = computeScale({
      naturalWidth: 1174,
      available: 366,
      naturalHeight: 400,
      availableHeight: 4000,
      zoom: 'fit',
      maxScale: 2.5,
    })
    expect(r.scale).toBeCloseTo(366 / 1174)
  })
})
