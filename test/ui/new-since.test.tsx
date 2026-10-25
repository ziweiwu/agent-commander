/**
 * F6: "new since you last opened it in this app", on the card and in Chat.
 *
 * The server keeps how far each session has been shown on a tab that was on
 * screen (`seen.rs`). The card says "new" only when an idle Claude agent has
 * done something past that; the conversation draws a divider where the news
 * begins. Neither ever says "unread": the reader may have followed the agent
 * in tmux, and all this app knows is what it showed (INV-11).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, screen, within } from '@testing-library/react'
import { Chat } from '../../src/web/components/Chat.tsx'
import { FleetList } from '../../src/web/components/FleetList.tsx'
import { useStore } from '../../src/web/store/store.ts'
import { buildMessages } from '../../src/web/lib/chat.ts'
import { CATCH_UP_MS, dividerFor, followVisit, isNewSinceOpened, visitOf } from '../../src/web/lib/newSince.ts'
import { agent, renderApp, resetStore } from './helpers.tsx'

vi.mock('../../src/web/store/transport.ts', () => ({
  sendMessage: vi.fn(),
  sendKey: vi.fn(),
  sendText: vi.fn(),
  flushText: vi.fn(),
  loadEnv: vi.fn(),
  startAgent: vi.fn(),
  focusAgent: vi.fn(),
  setAttached: vi.fn(),
  clearAgentContext: vi.fn(),
  compactAgentContext: vi.fn(),
}))

beforeEach(resetStore)

const SHOWN_AT = Date.now() - 3 * 3_600_000
const LATER = SHOWN_AT + 60_000

const fleet = (): void => {
  renderApp(<FleetList tiled selected={null} onSelect={() => {}} />)
}
const mark = (sessionId: string) =>
  screen
    .getAllByTestId('agent-entry')
    .find((el) => el.dataset.sessionId === sessionId)
    ?.querySelector('[data-testid="agent-new"]') ?? null

describe('F6 the card', () => {
  it('marks an idle Claude agent that moved past what was shown, beside its age', () => {
    useStore.setState({
      agents: [agent({ sessionId: 'moved', lastActivityAt: LATER }), agent({ sessionId: 'still', lastActivityAt: SHOWN_AT })],
      seenThrough: { moved: SHOWN_AT, still: SHOWN_AT },
    })
    fleet()
    const word = mark('moved')
    expect(word?.textContent).toBe('new')
    expect(word?.previousElementSibling?.getAttribute('data-testid')).toBe('agent-age')
    expect(mark('still')).toBeNull()
  })

  it('says it in the plain text colour, never the hand’s amber', async () => {
    const css = (await import('node:fs')).readFileSync('src/web/components/AgentCard.module.css', 'utf8')
    const rule = css.slice(css.indexOf('.newSince {'), css.indexOf('}', css.indexOf('.newSince {')))
    expect(rule).toMatch(/color: var\(--(text|dim)\)/)
    expect(rule).not.toMatch(/waiting|amber|warn/)
  })

  it.each([
    ['busy', { status: 'busy' as const }],
    ['waiting', { status: 'waiting' as const, waitingFor: 'dialog open' }],
    ['inferred', { statusInferred: true }],
    ['terminal', { agentKind: 'terminal' }],
  ])('gives a %s card no mark', (_, over) => {
    const moved = agent({ sessionId: 'x', lastActivityAt: LATER, ...over })
    expect(isNewSinceOpened(moved, { x: SHOWN_AT })).toBe(false)
  })

  it('treats a session the server has not recorded as backlog, never as new', () => {
    useStore.setState({ agents: [agent({ sessionId: 'x', lastActivityAt: LATER })], seenThrough: {} })
    fleet()
    expect(mark('x')).toBeNull()
  })

  it('puts no mark on a stale card while the socket is down', () => {
    useStore.setState({
      agents: [agent({ sessionId: 'x', lastActivityAt: LATER })],
      seenThrough: { x: SHOWN_AT },
      conn: 'closed',
    })
    fleet()
    expect(mark('x')).toBeNull()
    expect(screen.queryByTestId('group-new')).toBeNull()
  })

  it('counts the marks in the Idle heading', () => {
    useStore.setState({
      agents: [
        agent({ sessionId: 'a', lastActivityAt: LATER }),
        agent({ sessionId: 'b', lastActivityAt: LATER }),
        agent({ sessionId: 'c', lastActivityAt: SHOWN_AT }),
      ],
      seenThrough: { a: SHOWN_AT, b: SHOWN_AT, c: SHOWN_AT },
    })
    fleet()
    const head = screen.getAllByTestId('group-head')[0]!
    expect(head.textContent).toBe('Idle3· 2 new')
    expect(within(head).getByTestId('group-new').textContent).toBe('· 2 new')
  })

  it('says it in Chinese as 新', () => {
    useStore.setState({
      lang: 'zh-CN',
      agents: [agent({ sessionId: 'x', lastActivityAt: LATER })],
      seenThrough: { x: SHOWN_AT },
    })
    fleet()
    expect(mark('x')?.textContent).toBe('新')
    expect(screen.getByTestId('group-new').textContent).toBe('· 1 新')
  })
})

const conversation = () =>
  buildMessages([
    { id: 'old-q', at: SHOWN_AT - 120_000, kind: 'user', text: 'refactor the parser' },
    { id: 'old-a', at: SHOWN_AT - 60_000, kind: 'assistant', text: 'On it.' },
    { id: 'new-a', at: SHOWN_AT + 10_000, kind: 'assistant', text: 'Done with the lexer.' },
    { id: 't1', at: SHOWN_AT + 11_000, kind: 'tool', tool: 'Edit', text: 'src/lexer.ts' },
    { id: 't2', at: SHOWN_AT + 12_000, kind: 'tool', tool: 'Bash', text: 'npm test' },
    { id: 'new-b', at: LATER, kind: 'assistant', text: 'All green.' },
  ])

/** Every element this tall inside and on screen; `setup.ts` makes both writable. */
const laidOut = (content: number, view: number): void => {
  Object.assign(HTMLElement.prototype, { scrollHeight: content, clientHeight: view })
}

const openChat = (): void => {
  renderApp(<Chat agent={agent({ sessionId: 'x', lastActivityAt: LATER })} />)
}

describe('F6 the divider in Chat', () => {
  it('sits before the first message past what was shown, and counts what is new', () => {
    useStore.setState({
      messages: conversation(),
      visit: { sessionId: 'x', seenThrough: SHOWN_AT, activityAt: LATER, followUntil: 0 },
    })
    openChat()
    const line = screen.getByTestId('new-since')
    expect(line.textContent).toBe('New since you last opened this · 3h ago — 2 replies, 2 tool calls')
    expect(line.className).toMatch(/daySep/)
    const after = line.nextElementSibling
    expect(after?.textContent).toContain('Done with the lexer.')
    expect(line.previousElementSibling?.textContent).toContain('On it.')
  })

  it('goes at the top and says "at least" when the read does not reach back that far', () => {
    const tail = conversation().filter((m) => m.at > SHOWN_AT)
    useStore.setState({ messages: tail, visit: { sessionId: 'x', seenThrough: SHOWN_AT, activityAt: LATER, followUntil: 0 } })
    openChat()
    const line = screen.getByTestId('new-since')
    expect(line.textContent).toContain('at least 2 replies')
    expect(line.dataset.atLeast).toBe('true')
    const firstMessage = screen.getAllByTestId('message')[0]!
    expect(line.compareDocumentPosition(firstMessage) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('opens at the divider when what is new is taller than the view, and offers the way down', () => {
    const DIVIDER_TOP_PX = 300
    const VIEW_PX = 400
    const CONTENT_PX = 2_000
    laidOut(CONTENT_PX, VIEW_PX)
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const scrolled = document.querySelector('[data-testid="chat-scroll"]')?.scrollTop ?? 0
      const top = this.getAttribute('data-testid') === 'new-since' ? DIVIDER_TOP_PX - scrolled : 0
      return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top, toJSON: () => ({}) }
    })
    useStore.setState({ messages: conversation(), visit: { sessionId: 'x', seenThrough: SHOWN_AT, activityAt: LATER, followUntil: 0 } })
    openChat()
    expect(screen.getByTestId('chat-scroll').scrollTop).toBe(DIVIDER_TOP_PX)
    expect(screen.getByTestId('jump-to-latest')).toBeDefined()
    vi.restoreAllMocks()
    laidOut(0, 0)
  })

  it('follows the conversation to the bottom as usual when what is new fits', () => {
    const VIEW_PX = 400
    const CONTENT_PX = 500
    laidOut(CONTENT_PX, VIEW_PX)
    useStore.setState({ messages: conversation(), visit: { sessionId: 'x', seenThrough: SHOWN_AT, activityAt: LATER, followUntil: 0 } })
    openChat()
    expect(screen.getByTestId('chat-scroll').scrollTop).toBe(CONTENT_PX)
    expect(screen.queryByTestId('jump-to-latest')).toBeNull()
    vi.restoreAllMocks()
    laidOut(0, 0)
  })

  it('draws nothing when nothing is newer than what was shown', () => {
    useStore.setState({
      messages: conversation(),
      visit: { sessionId: 'x', seenThrough: LATER, activityAt: LATER, followUntil: 0 },
    })
    openChat()
    expect(screen.queryByTestId('new-since')).toBeNull()
  })

  it('draws nothing for a visit to another agent', () => {
    useStore.setState({
      messages: conversation(),
      visit: { sessionId: 'other', seenThrough: SHOWN_AT, activityAt: LATER, followUntil: 0 },
    })
    openChat()
    expect(screen.queryByTestId('new-since')).toBeNull()
  })

  it('stays where it was while the server moves the record and the agent goes on', () => {
    useStore.setState({ messages: conversation(), visit: { sessionId: 'x', seenThrough: SHOWN_AT, activityAt: LATER, followUntil: 0 } })
    openChat()
    act(() => {
      useStore.setState({
        seenThrough: { x: LATER + 5_000 },
        messages: buildMessages([
          { id: 'old-q', at: SHOWN_AT - 120_000, kind: 'user', text: 'refactor the parser' },
          { id: 'new-a', at: SHOWN_AT + 10_000, kind: 'assistant', text: 'Done with the lexer.' },
          { id: 'live', at: LATER + 5_000, kind: 'assistant', text: 'Anything else?' },
        ]),
      })
    })
    const line = screen.getByTestId('new-since')
    expect(line.nextElementSibling?.textContent).toContain('Done with the lexer.')
    expect(line.textContent).toContain('1 reply,')
  })

  it('says it in Chinese', () => {
    useStore.setState({
      lang: 'zh-CN',
      messages: conversation(),
      visit: { sessionId: 'x', seenThrough: SHOWN_AT, activityAt: LATER, followUntil: 0 },
    })
    openChat()
    expect(screen.getByTestId('new-since').textContent).toBe('上次在此打开后的新内容 · 3 小时前 — 2 条回复，2 次工具调用')
  })
})

describe('F6 a visit begun on a fleet the idle enricher left frozen', () => {
  const OPENED = SHOWN_AT + 3_600_000
  const frozen = () => visitOf('x', [agent({ sessionId: 'x', lastActivityAt: SHOWN_AT })], { x: SHOWN_AT }, OPENED)!

  it('draws the divider at the old record once the catch-up lands on a focused tab', () => {
    const visit = frozen()
    expect(dividerFor(conversation(), visit)).toBeNull()
    const caughtUp = followVisit(visit, [agent({ sessionId: 'x', lastActivityAt: LATER })], OPENED + 2_000)
    useStore.setState({ messages: conversation(), visit: caughtUp, seenThrough: { x: LATER } })
    openChat()
    const line = screen.getByTestId('new-since')
    expect(line.nextElementSibling?.textContent).toContain('Done with the lexer.')
    expect(line.textContent).toContain('2 replies, 2 tool calls')
  })

  it('takes only the first move, so what arrives after it is not news', () => {
    const once = followVisit(frozen(), [agent({ sessionId: 'x', lastActivityAt: LATER })], OPENED + 1_000)
    const again = followVisit(once, [agent({ sessionId: 'x', lastActivityAt: LATER + 9_000 })], OPENED + 2_000)
    expect(again?.activityAt).toBe(LATER)
  })

  it('stops following once a pass has had time to land, so live activity is not news', () => {
    const late = followVisit(frozen(), [agent({ sessionId: 'x', lastActivityAt: LATER })], OPENED + CATCH_UP_MS + 1)
    expect(late?.activityAt).toBe(SHOWN_AT)
  })
})

describe('F6 the divider, without a DOM', () => {
  it('leaves out a message still being sent', () => {
    const sent = { ...conversation()[0]!, id: 'p', at: LATER + 1, pending: true }
    const divider = dividerFor([...conversation(), sent], { sessionId: 'x', seenThrough: LATER, activityAt: LATER + 1, followUntil: 0 })
    expect(divider).toBeNull()
  })
})
