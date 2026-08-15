import { beforeEach, describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { UsageChips } from '../../src/web/components/UsageChips.tsx'
import { useStore } from '../../src/web/store/store.ts'
import { renderApp, resetStore } from './helpers.tsx'

beforeEach(resetStore)

const fresh = (over: Record<string, unknown> = {}) => ({
  at: Date.now(),
  fiveHour: { pct: 61.4, resetsAt: Date.now() + 2 * 3_600_000 },
  sevenDay: { pct: 34, resetsAt: Date.now() + 3 * 86_400_000 },
  ...over,
})

describe('UsageChips', () => {
  it('renders a meter per window with the percentage as text', () => {
    useStore.setState({ limits: fresh() })
    renderApp(<UsageChips />)
    expect(screen.getByTestId('usage-five-hour').textContent).toContain('61%')
    expect(screen.getByTestId('usage-seven-day').textContent).toContain('34%')
    expect(screen.getAllByRole('meter')).toHaveLength(2)
  })

  /*
   * The non-subscriber case. `rate_limits` never arrives, so a meter would sit
   * at 0% forever — a claim the user can never make true.
   */
  it('renders nothing when there is no reading at all', () => {
    useStore.setState({ limits: null })
    renderApp(<UsageChips />)
    expect(screen.queryByTestId('usage-chips')).toBeNull()
  })

  it('renders only the window it has', () => {
    useStore.setState({ limits: { at: Date.now(), fiveHour: { pct: 12 } } })
    renderApp(<UsageChips />)
    expect(screen.queryByTestId('usage-five-hour')).not.toBeNull()
    expect(screen.queryByTestId('usage-seven-day')).toBeNull()
  })

  it('names the percentage and the reset to a screen reader', () => {
    useStore.setState({ limits: fresh() })
    renderApp(<UsageChips />)
    const bar = screen.getByTestId('usage-five-hour').querySelector('[role="meter"]')
    expect(bar?.getAttribute('aria-valuenow')).toBe('61')
    expect(bar?.getAttribute('aria-label')).toMatch(/61% used/)
    expect(bar?.getAttribute('aria-label')).toMatch(/resets in/)
  })

  it('says "resetting" rather than "0m" once the window has rolled over', () => {
    useStore.setState({ limits: fresh({ fiveHour: { pct: 61, resetsAt: Date.now() - 1000 } }) })
    renderApp(<UsageChips />)
    const bar = screen.getByTestId('usage-five-hour').querySelector('[role="meter"]')
    expect(bar?.getAttribute('aria-label')).toMatch(/resetting/)
  })

  /*
   * A stale bar must not assert a current value: the number was true when it
   * was read, and the label has to say so instead of implying it is now.
   */
  it('drops aria-valuenow and dates the reading once it is stale', () => {
    useStore.setState({ limits: fresh({ at: Date.now() - 40 * 60_000 }) })
    renderApp(<UsageChips />)
    expect(screen.getByTestId('usage-chips').getAttribute('data-stale')).toBe('true')
    const bar = screen.getByTestId('usage-five-hour').querySelector('[role="meter"]')
    expect(bar?.hasAttribute('aria-valuenow')).toBe(false)
    expect(bar?.getAttribute('aria-label')).toMatch(/when last read/)
  })

  /*
   * Defence in depth: the server clamps, but the percentage becomes a CSS
   * length, and `Infinity%` renders as a silently broken bar rather than an
   * obvious error.
   */
  it('never writes a non-finite or out-of-range width', () => {
    const width = (pct: number): string | undefined => {
      resetStore()
      useStore.setState({ limits: { at: Date.now(), fiveHour: { pct } } })
      const { unmount } = renderApp(<UsageChips />)
      const el = screen.getByTestId('usage-five-hour').querySelector<HTMLElement>('[data-level]')
      const value = el?.style.inlineSize
      unmount()
      return value
    }
    expect(width(Number.POSITIVE_INFINITY)).toBe('2%')
    expect(width(Number.NaN)).toBe('2%')
    expect(width(150)).toBe('100%')
    expect(width(-20)).toBe('2%')
  })

  /*
   * The countdown used to live only in a `title`, which needs hover — and hover
   * does not exist on the widths where these chips get a row of their own.
   */
  it('renders the reset countdown as text, not only in a tooltip', () => {
    useStore.setState({ limits: fresh() })
    renderApp(<UsageChips />)
    expect(screen.getByTestId('usage-five-hour').textContent).toMatch(/2h/)
  })

  it('picks the fill level from the clamped percentage, not the raw one', () => {
    useStore.setState({ limits: { at: Date.now(), fiveHour: { pct: -300 } } })
    renderApp(<UsageChips />)
    const fill = screen.getByTestId('usage-five-hour').querySelector('[data-level]')
    expect(fill?.getAttribute('data-level')).toBe('normal')
  })

  it('steps the fill through the three levels', () => {
    const level = (pct: number): string | null | undefined => {
      resetStore()
      useStore.setState({ limits: { at: Date.now(), fiveHour: { pct } } })
      const { unmount } = renderApp(<UsageChips />)
      const value = screen
        .getByTestId('usage-five-hour')
        .querySelector('[data-level]')
        ?.getAttribute('data-level')
      unmount()
      return value
    }
    expect(level(40)).toBe('normal')
    expect(level(80)).toBe('high')
    expect(level(92)).toBe('critical')
  })
})
