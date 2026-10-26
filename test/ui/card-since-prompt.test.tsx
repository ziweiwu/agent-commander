/**
 * F8: a busy card's age, counted from the last prompt a person typed.
 *
 * A working agent writes every few seconds, so its card's age read about now
 * whether it had ground on one request for two hours or just begun. The server
 * now keeps when the person last typed a prompt and the agent's own tool calls
 * since; these hold what the card may say of them (INV-11): a clock and a count
 * when the prompt was read, "at least" and no clock when it is older than the
 * backfill, and the old age when no prompt was read at all.
 */
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { AgentCard } from '../../src/web/components/AgentCard.tsx'
import type { Agent } from '../../src/shared/types.ts'
import { useStore } from '../../src/web/store/store.ts'
import { agent, renderApp, resetStore } from './helpers.tsx'

const MINUTE = 60_000
const PROMPTED_MINUTES_AGO = 47
const CALLS = 214

const card = (over: Partial<Agent>) =>
  renderApp(
    <AgentCard
      agent={agent({ sessionId: 'a', lastActivityAt: Date.now() - MINUTE, ...over })}
      selected={false}
      onSelect={() => {}}
    />,
  )

const prompted = { at: Date.now() - PROMPTED_MINUTES_AGO * MINUTE, calls: CALLS }
const age = (): HTMLElement => screen.getByTestId('agent-age')

beforeEach(resetStore)

describe('F8 INV-11 a busy card counts from the last prompt', () => {
  it('reads how long since the prompt and how many calls, in the whole sentence and the short one', () => {
    card({ status: 'busy', sincePrompt: prompted })
    expect(age().dataset.since).toBe('prompt')
    expect(screen.getByTestId('agent-since').textContent).toBe('47m since your prompt · 214 calls')
    expect(screen.getByTestId('agent-since-short').textContent).toBe('47m · 214 calls')
    expect(age().title).toContain('47m since your prompt · 214 calls')
    expect(age().title).toContain('delegates’ calls are not counted')
  })

  it('says it in Chinese too', () => {
    useStore.setState({ lang: 'zh-CN' })
    card({ status: 'busy', sincePrompt: prompted })
    expect(screen.getByTestId('agent-since').textContent).toBe('距你的提示 47 分钟 · 214 次调用')
    expect(screen.getByTestId('agent-since-short').textContent).toBe('47 分钟 · 214 次调用')
  })

  it('says "at least" and shows no clock when the prompt is older than what was read', () => {
    card({ status: 'busy', sincePrompt: { calls: CALLS } })
    expect(age().dataset.floor).toBe('true')
    expect(screen.getByTestId('agent-since').textContent).toBe('at least 214 calls in what was read')
    expect(screen.getByTestId('agent-since-short').textContent).toBe('≥214 calls')
    expect(age().textContent).not.toMatch(/since your prompt|\dm\b/)
  })

  it('keeps "at least" in Chinese', () => {
    useStore.setState({ lang: 'zh-CN' })
    card({ status: 'busy', sincePrompt: { calls: CALLS } })
    expect(screen.getByTestId('agent-since').textContent).toBe('已读部分中至少 214 次调用')
    expect(screen.getByTestId('agent-since-short').textContent).toBe('≥214 次调用')
  })

  it('falls back to the old age when no prompt was read', () => {
    const { unmount } = card({ status: 'busy', sincePrompt: prompted })
    expect(screen.getByTestId('agent-since')).toBeTruthy()
    unmount()

    card({ status: 'busy' })
    expect(screen.queryByTestId('agent-since')).toBeNull()
    expect(age().dataset.since).toBe('activity')
    expect(age().textContent).toBe('1m ago')
  })

  it('is on busy Claude cards only', () => {
    const { unmount } = card({ status: 'busy', sincePrompt: prompted })
    expect(screen.getByTestId('agent-since')).toBeTruthy()
    unmount()

    const others: Partial<Agent>[] = [
      { status: 'idle', sincePrompt: prompted },
      { status: 'waiting', waitingFor: 'dialog open', sincePrompt: prompted },
      { status: 'busy', agentKind: 'codex', sincePrompt: prompted },
    ]
    for (const over of others) {
      const other = card(over)
      expect(screen.queryByTestId('agent-since'), JSON.stringify(over)).toBeNull()
      expect(age().textContent).toBe('1m ago')
      other.unmount()
    }
  })

  it('adds no row to the face', () => {
    const { unmount } = card({ status: 'busy' })
    const rows = screen.getByTestId('agent-card').querySelectorAll(':scope > div > *').length
    unmount()

    card({ status: 'busy', sincePrompt: prompted })
    expect(screen.getByTestId('agent-card').querySelectorAll(':scope > div > *').length).toBe(rows)
    expect(screen.getByTestId('agent-name').parentElement?.contains(screen.getByTestId('agent-since'))).toBe(true)
  })

  it('shows the whole sentence only where the top line has room for it beside the name', () => {
    const sheet = readFileSync('src/web/components/AgentCard.module.css', 'utf8')
    expect(sheet).toMatch(/\.top \{[^}]*container: card-top \/ inline-size;/)
    expect(sheet).toMatch(/\.since \.sinceFull \{\s*display: none;\s*\}/)
    expect(sheet).toMatch(
      /@container card-top \(min-width: \d+px\) \{\s*\.since \.sinceFull \{\s*display: inline;\s*\}\s*\.since \.sinceShort \{\s*display: none;\s*\}/,
    )
  })
})
