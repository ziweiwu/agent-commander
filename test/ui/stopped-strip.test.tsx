/**
 * C1: the words the marker and the strip say, in both languages, and that the
 * strip stays a filter: read-only, with no way to send anything from it.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { AgentCard } from '../../src/web/components/AgentCard.tsx'
import { StoppedStrip } from '../../src/web/components/StoppedStrip.tsx'
import { stoppedGroup } from '../../src/web/lib/stopped.ts'
import { clock } from '../../src/web/lib/format.ts'
import type { Agent, RateLimits, StopCause } from '../../src/shared/types.ts'
import { useStore } from '../../src/web/store/store.ts'
import { agent, renderApp, resetStore } from './helpers.tsx'

const MINUTE = 60_000
const STOP_AT = Date.now() - 4 * MINUTE
const HOUR = 60 * MINUTE
const FIVE_HOUR_RESETS_IN = 80 * MINUTE

const stopped = (sessionId: string, cause: StopCause, over: Partial<Agent> = {}): Agent =>
  agent({ sessionId, status: 'idle', stoppedBy: { cause, at: STOP_AT }, ...over })

const pair = (cause: StopCause): Agent[] => [stopped('a', cause), stopped('b', cause)]

const fleet = (agents: Agent[], limits: RateLimits | null = null): void => {
  useStore.setState({ agents, conn: 'open', fleetAt: Date.now(), limits })
}

const card = (over: Partial<Agent>) =>
  renderApp(<AgentCard agent={agent({ sessionId: 'a', ...over })} selected={false} onSelect={() => {}} />)

const strip = (): HTMLElement => screen.getByTestId('stopped-strip')

beforeEach(resetStore)

describe('C1 the card says why it stopped', () => {
  const stopFor = (cause: StopCause) => ({ status: 'idle' as const, stoppedBy: { cause, at: STOP_AT } })
  const marker = (): string => screen.getByTestId('agent-stopped').textContent ?? ''

  it('reads each cause in English', () => {
    const cases: Array<[StopCause, string]> = [
      ['authentication_failed', 'Stopped · sign-in failed 4m ago'],
      ['rate_limit', 'Stopped · limit reached 4m ago'],
      ['server_error', 'Stopped · server error 4m ago'],
      ['other', 'Stopped · API error 4m ago'],
      ['billing_error', 'Stopped · API error 4m ago'],
      ['invalid_request', 'Stopped · API error 4m ago'],
    ]
    for (const [cause, words] of cases) {
      const { unmount } = card(stopFor(cause))
      expect(marker()).toBe(words)
      unmount()
    }
  })

  it('reads each cause in Chinese', () => {
    useStore.setState({ lang: 'zh-CN' })
    const cases: Array<[StopCause, string]> = [
      ['authentication_failed', '已停止 · 登录失败 4 分钟前'],
      ['rate_limit', '已停止 · 额度已用完 4 分钟前'],
      ['server_error', '已停止 · 服务器错误 4 分钟前'],
      ['other', '已停止 · API 错误 4 分钟前'],
    ]
    for (const [cause, words] of cases) {
      const { unmount } = card(stopFor(cause))
      expect(marker()).toBe(words)
      unmount()
    }
  })

  it('is named to a screen reader, and absent on a busy card', () => {
    const { unmount } = card(stopFor('rate_limit'))
    expect(screen.getByTestId('agent-card').getAttribute('aria-label')).toContain('Stopped · limit reached')
    unmount()
    card({ status: 'busy', stoppedBy: { cause: 'rate_limit', at: STOP_AT } })
    expect(screen.queryByTestId('agent-stopped')).toBeNull()
  })
})

describe('C1 the strip states one shared stop', () => {
  it('says the sentence the verdict names, and the instruction for sign-in', () => {
    fleet(pair('authentication_failed'))
    renderApp(<StoppedStrip />)
    expect(strip().textContent).toBe(
      `2 agents stopped: sign-in failed since ${clock(STOP_AT)}. Sign in again, then message them.`,
    )
    expect(stoppedGroup(pair('authentication_failed'))?.count).toBe(2)
  })

  it('says it in Chinese', () => {
    useStore.setState({ lang: 'zh-CN' })
    fleet(pair('authentication_failed'))
    renderApp(<StoppedStrip />)
    expect(strip().textContent).toBe(
      `2 个 agent 已停止：登录失败，自 ${clock(STOP_AT)} 起。请重新登录后再给它们发消息。`,
    )
  })

  it('gives no sign-in instruction for any other cause', () => {
    fleet(pair('server_error'))
    renderApp(<StoppedStrip />)
    expect(strip().textContent).toBe(`2 agents stopped: server error since ${clock(STOP_AT)}.`)
  })

  it('does not draw for a mixed fleet', () => {
    fleet([stopped('a', 'authentication_failed'), stopped('b', 'rate_limit')])
    renderApp(<StoppedStrip />)
    expect(screen.queryByTestId('stopped-strip')).toBeNull()
  })

  it('does not draw while the socket is down, because the fleet is then a memory', () => {
    useStore.setState({ agents: pair('rate_limit'), conn: 'closed', fleetAt: Date.now(), limits: null })
    renderApp(<StoppedStrip />)
    expect(screen.queryByTestId('stopped-strip')).toBeNull()
  })

  it('names the day of a stop that is not today', () => {
    const lastWeek = Date.now() - 8 * 24 * HOUR
    fleet([
      stopped('a', 'server_error', { stoppedBy: { cause: 'server_error', at: lastWeek } }),
      stopped('b', 'server_error'),
    ])
    renderApp(<StoppedStrip />)
    expect(strip().textContent).toMatch(new RegExp(`since [^.]+ ${clock(lastWeek)}\\.$`))
  })
})

describe('C1 INV-11 a limit quotes the reset only from a fresh five-hour reading', () => {
  const limits = (pct: number, ageMs = 0, resetsIn = FIVE_HOUR_RESETS_IN): RateLimits => ({
    at: Date.now() - ageMs,
    fiveHour: { pct, resetsAt: Date.now() + resetsIn },
    sevenDay: { pct: 10, resetsAt: Date.now() + 96 * HOUR },
  })

  const shown = (reading: RateLimits | null): string => {
    fleet(pair('rate_limit'), reading)
    renderApp(<StoppedStrip />)
    return strip().textContent ?? ''
  }

  it('adds the reset when the five-hour window reads spent', () => {
    expect(shown(limits(97))).toBe(`2 agents stopped: limit reached since ${clock(STOP_AT)}. Resets in 1h 20m.`)
  })

  it('omits it from a stale reading', () => {
    expect(shown(limits(97, 21 * MINUTE))).not.toContain('Resets')
  })

  it('omits it when the five-hour window is not the one that ran out', () => {
    expect(shown(limits(30))).not.toContain('Resets')
  })

  it('omits it with no reading at all', () => {
    expect(shown(null)).not.toContain('Resets')
  })

  it('omits it once the reset has passed', () => {
    expect(shown(limits(97, 0, -MINUTE))).not.toContain('Resets')
  })
})

describe('C1 INV-2 tapping the strip filters, and sends nothing', () => {
  it('narrows the fleet, clears a filter that would hide them, and toggles back', () => {
    useStore.setState({ fleet: { ...useStore.getState().fleet, filter: 'busy', query: 'x' } })
    fleet(pair('authentication_failed'))
    renderApp(<StoppedStrip />)
    fireEvent.click(strip())
    expect(useStore.getState().fleet).toMatchObject({ stopped: 'authentication_failed', filter: 'all', query: '' })
    expect(strip().getAttribute('aria-pressed')).toBe('true')
    expect(strip().textContent).toContain('Showing only these')

    fireEvent.click(strip())
    expect(useStore.getState().fleet.stopped).toBeUndefined()
    expect(strip().getAttribute('aria-pressed')).toBe('false')
  })

  it('offers no retry and nothing that reaches a pane', () => {
    fleet(pair('authentication_failed'))
    renderApp(<StoppedStrip />)
    expect(strip().querySelectorAll('button, a, input')).toHaveLength(0)
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(strip().textContent?.toLowerCase()).not.toMatch(/retry|resend/)
  })
})
