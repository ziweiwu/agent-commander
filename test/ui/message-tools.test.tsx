/**
 * What a reply's tool calls show, and what the run hides.
 *
 * The chat's whole job on this surface is saying what the agent did, and a
 * long run is where there is most of it to say. The collapse used to take all
 * of it: `VISIBLE_TOOLS` reads "how many tool calls show before the run
 * collapses", and the code showed *none* of them once a run was long enough
 * to collapse — five calls rendered in full and six rendered as the words
 * "6 actions". These pin the constant's own promise.
 */
import { readFileSync } from 'node:fs'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen } from '@testing-library/react'
import type { ClientMessage, ToolOutcome } from '../../src/shared/types.ts'
import { Message } from '../../src/web/components/Message.tsx'
import type { ChatMessage, ToolCall } from '../../src/web/lib/chat.ts'
import { clock } from '../../src/web/lib/format.ts'
import { useStore } from '../../src/web/store/store.ts'
import { connect } from '../../src/web/store/transport.ts'
import { renderApp, resetStore } from './helpers.tsx'

/** The same number `Message.tsx` shows before it collapses the remainder. */
const VISIBLE = 4

const withTools = (count: number): ChatMessage => ({
  id: 'm1',
  role: 'agent',
  at: 1_786_000_000_000,
  text: 'On it.',
  grouped: false,
  tools: Array.from({ length: count }, (_, i) => ({
    id: `t${i}`,
    tool: 'Read',
    text: `src/file-${i}.ts`,
    subagent: false,
  })),
})

const rows = () => screen.queryAllByTestId('tool-call')

beforeEach(resetStore)

describe('a reply’s tool calls', () => {
  it('shows a short run in full, with nothing to expand', () => {
    renderApp(<Message message={withTools(VISIBLE)} />)
    expect(rows()).toHaveLength(VISIBLE)
    expect(screen.queryByTestId('tools-toggle')).toBeNull()
  })

  /*
   * One hidden row is not worth a control: the press costs the reader more
   * than the line it saves.
   */
  it('does not collapse a run that would hide a single call', () => {
    renderApp(<Message message={withTools(VISIBLE + 1)} />)
    expect(rows()).toHaveLength(VISIBLE + 1)
    expect(screen.queryByTestId('tools-toggle')).toBeNull()
  })

  it('keeps the first calls on screen and collapses only the rest', () => {
    const total = VISIBLE + 5
    renderApp(<Message message={withTools(total)} />)
    expect(rows()).toHaveLength(VISIBLE)
    const toggle = screen.getByTestId('tools-toggle')
    // The count is what is hidden, not the size of the run: the run is on
    // screen above it.
    expect(toggle.textContent).toContain(String(total - VISIBLE))
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(toggle)
    expect(rows()).toHaveLength(total)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(toggle)
    expect(rows()).toHaveLength(VISIBLE)
  })
})

/**
 * The run as a ruled list (U7): one rule down the left of the whole run, and
 * each call a row of a grid — name, argument, and a third column kept for the
 * call's outcome. It used to be a 2px rule per row, so "› 4 more" on a phone
 * was a 44px stub of rule with nothing in it, and the name was drawn in the
 * working hue as if every past call were still running.
 */
const CSS_COMMENT = new RegExp('/\\*[\\s\\S]*?\\*/', 'g')
const SHEET = readFileSync('src/web/components/Message.module.css', 'utf8').replace(CSS_COMMENT, '')

/** The declarations of the first top-level rule written exactly as `selector`. */
function rule(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(SHEET)
  expect(match, `no rule for ${selector}`).not.toBeNull()
  return Object.fromEntries(
    (match?.[1] ?? '')
      .split(';')
      .map((line) => line.split(':').map((part) => part.trim()))
      .filter((pair) => pair.length >= 2 && pair[0])
      .map(([property, ...value]) => [property, value.join(':')]),
  )
}

describe('the run is one ruled list', () => {
  it('draws one rule down the run instead of one per row', () => {
    expect(rule('.tools')['border-left']).toBe('2px solid var(--line)')
    expect(rule('.tool').border).toBe('0')
    expect(rule('.toggle')['border-left']).toBeUndefined()
  })

  it('lays each call on a three-column grid, the third kept for its outcome', () => {
    const tool = rule('.tool')
    expect(tool.display).toBe('grid')
    const tracks = tool['grid-template-columns']?.match(/minmax\([^)]*\)|max-content|auto|\S+/g)
    expect(tracks).toEqual(['minmax(5ch, max-content)', 'minmax(0, 1fr)', 'auto'])
  })

  it('names the tool in the text colour, and a subagent in its accent', () => {
    expect(rule('.toolName').color).toBe('var(--text)')
    expect(rule('.toolName')['font-weight']).toBe('var(--weight-strong)')
    expect(rule('.subagent .toolName').color).toBe('var(--accent)')
  })

  it('puts the name in the first column and the argument in the second', () => {
    renderApp(<Message message={withTools(2)} />)
    for (const row of rows()) {
      const cells = Array.from(row.children)
      expect(cells).toHaveLength(2)
      expect(cells[0]?.textContent).toBe('Read')
      expect(cells[1]?.textContent).toMatch(/^src\/file-\d\.ts$/)
    }
  })
})

describe('a message says what language it is in', () => {
  const said = (text: string): ChatMessage => ({ ...withTools(0), text })

  it('marks Chinese prose zh-CN, so it gets the taller Chinese line', () => {
    renderApp(<Message message={said('好的，我先看一下现在的代码结构。')} />)
    expect(screen.getByTestId('message-text').getAttribute('lang')).toBe('zh-CN')
  })

  it('marks English prose en, even under a Chinese interface', () => {
    renderApp(<Message message={said('Getting oriented in the codebase.')} />)
    expect(screen.getByTestId('message-text').getAttribute('lang')).toBe('en')
  })
})

const sent: ClientMessage[] = []
const sockets: FakeSocket[] = []

class FakeSocket {
  static readonly OPEN = 1
  readyState = 1
  readonly listeners = new Map<string, Array<(e: unknown) => void>>()
  constructor(readonly url: unknown) {
    sockets.push(this)
  }
  send(raw: string): void {
    const parsed = JSON.parse(raw) as ClientMessage
    if (parsed.type === 'toolResult') sent.push(parsed)
  }
  addEventListener(type: string, fn: (e: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
  }
  fire(type: string, event: unknown = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event)
  }
}

function arrives(msg: object): void {
  act(() => sockets[sockets.length - 1]?.fire('message', { data: JSON.stringify(msg) }))
}

const RECORDED_AT = 1_786_000_000_000

const ok = (id: string, added?: number, removed?: number): ToolOutcome => ({
  toolUseId: id,
  outcome: 'ok',
  ...(added === undefined ? {} : { added, removed }),
})

const calls = (...list: Array<[string, string, ToolOutcome | undefined]>): ChatMessage => ({
  ...withTools(0),
  tools: list.map(([tool, text, outcome], i): ToolCall => ({
    id: `c${i}`,
    tool,
    text,
    subagent: false,
    toolUseId: outcome?.toolUseId ?? `toolu_${i}`,
    ...(outcome ? { outcome } : {}),
  })),
})

const anEdit = calls(['Edit', 'src/app.ts', ok('toolu_e', 12, 3)])

beforeAll(() => {
  vi.stubGlobal('WebSocket', FakeSocket)
  connect()
  sockets[sockets.length - 1]?.fire('open')
})

describe('a call says what happened, in words', () => {
  beforeEach(() => {
    sent.length = 0
    useStore.setState({ selected: 'a' })
  })

  it('reads an edit as its counts, a refusal by whom and why, and a failure', () => {
    renderApp(
      <Message
        message={calls(
          ['Edit', 'src/app.ts', ok('toolu_e', 12, 3)],
          [
            'Bash',
            'rm -rf dist',
            { toolUseId: 'toolu_r', outcome: 'refused', by: 'autoMode', category: 'irreversible_local_destruction' },
          ],
          ['Bash', 'npm run build', { toolUseId: 'toolu_f', outcome: 'failed' }],
          ['Read', 'README.md', ok('toolu_o')],
          ['Grep', 'still running', undefined],
        )}
      />,
    )
    const said = screen.getAllByTestId('tool-outcome').map((cell) => [cell.dataset.kind, cell.textContent])
    expect(said).toEqual([
      ['ok', '+12 −3'],
      ['refused', 'refused · auto mode · irreversible local destruction'],
      ['failed', 'failed'],
    ])
    const [, , , read, running] = rows()
    expect(read?.children).toHaveLength(2)
    expect(read?.querySelector('[data-testid="tool-expand"]')).not.toBeNull()
    expect(running?.querySelector('[data-testid="tool-expand"]')).toBeNull()
  })

  it('names nobody where the decision names nobody this app has a word for', () => {
    renderApp(<Message message={calls(['Bash', 'ls', { toolUseId: 'toolu_x', outcome: 'refused' }])} />)
    expect(screen.getByTestId('tool-outcome').textContent).toBe('refused')
  })

  it('keeps the outcome in the third column, its words in the danger hue', () => {
    expect(rule('.outcome')['grid-column']).toBe('3')
    expect(rule('.outcome')['font-variant-numeric']).toBe('tabular-nums')
    expect(rule('.outcome').color).toBe('var(--dim)')
    const danger = /\.outcome\[data-kind='refused'\],\s*\.outcome\[data-kind='failed'\]\s*\{\s*color: var\(--danger\);/
    expect(SHEET).toMatch(danger)
  })
})

describe('INV-4 a row opens on a tap, with what was recorded', () => {
  beforeEach(() => {
    sent.length = 0
    useStore.setState({ selected: 'a', toolResults: {} })
  })

  it('asks once, for the focused agent, and shows the hunks in a box of their own', () => {
    renderApp(<Message message={anEdit} />)
    fireEvent.click(screen.getByTestId('tool-expand'))
    expect(sent).toEqual([{ type: 'toolResult', sessionId: 'a', toolUseId: 'toolu_e' }])
    expect(screen.getByTestId('tool-result-status').textContent).toBe('Reading the record…')

    arrives({
      type: 'toolResult',
      sessionId: 'a',
      toolUseId: 'toolu_e',
      result: { at: RECORDED_AT, hunks: [{ oldStart: 4, newStart: 4, lines: ['-old', '+new'] }], omitted: 0 },
    })
    expect(screen.getByTestId('tool-result-body').textContent).toBe('@@ -4 +4 @@\n-old\n+new\n')
    expect(screen.getByTestId('tool-result-caption').textContent).toBe(
      `as recorded at ${clock(RECORDED_AT)} — the file may have changed since`,
    )
    expect(rule('.resultBody').overflow).toBe('auto')

    fireEvent.click(screen.getByTestId('tool-expand'))
    fireEvent.click(screen.getByTestId('tool-expand'))
    expect(sent).toHaveLength(1)
  })

  it('says when you changed the edit before it was applied', () => {
    renderApp(<Message message={anEdit} />)
    fireEvent.click(screen.getByTestId('tool-expand'))
    arrives({
      type: 'toolResult',
      sessionId: 'a',
      toolUseId: 'toolu_e',
      result: { at: RECORDED_AT, hunks: [{ oldStart: 1, newStart: 1, lines: ['+x'] }], omitted: 0, userModified: true },
    })
    expect(screen.getByTestId('tool-result-caption').textContent).toBe(
      `as recorded at ${clock(RECORDED_AT)} — the file may have changed since · you changed this before it was applied`,
    )
  })

  it('captions an output without the file clause, and says how much came before it', () => {
    renderApp(<Message message={calls(['Bash', 'npm run build', { toolUseId: 'toolu_f', outcome: 'failed' }])} />)
    fireEvent.click(screen.getByTestId('tool-expand'))
    arrives({
      type: 'toolResult',
      sessionId: 'a',
      toolUseId: 'toolu_f',
      result: { at: RECORDED_AT, output: 'Build failed.', omitted: 2048 },
    })
    expect(screen.getByTestId('tool-result-caption').textContent).toBe(`as recorded at ${clock(RECORDED_AT)}`)
    expect(screen.getByTestId('tool-result-body').textContent).toBe('Build failed.')
    expect(screen.getByTestId('tool-result').textContent).toContain('2 KB before this not shown')
  })

  it('says a record it could not find was not found, and drops another agent\'s reply', () => {
    renderApp(<Message message={anEdit} />)
    fireEvent.click(screen.getByTestId('tool-expand'))
    arrives({ type: 'toolResult', sessionId: 'b', toolUseId: 'toolu_e', result: { at: 0, output: 'x', omitted: 0 } })
    expect(screen.getByTestId('tool-result-status').textContent).toBe('Reading the record…')
    arrives({ type: 'toolResult', sessionId: 'a', toolUseId: 'toolu_e' })
    expect(screen.getByTestId('tool-result-status').textContent).toMatch(/^Not found near the end/)
  })
})

/**
 * INV-3: what a call returned is the agent's work, and browser storage never
 * holds that. A snapshot of everything the page wrote to either store, taken
 * after a diff was opened and a fleet frame was remembered, has none of it.
 */
describe('INV-3 a result is held in memory and nowhere else', () => {
  const stores = { local: new Map<string, string>(), session: new Map<string, string>() }
  const storage = (held: Map<string, string>) => ({
    getItem: (k: string) => held.get(k) ?? null,
    setItem: (k: string, v: string) => void held.set(k, v),
    removeItem: (k: string) => void held.delete(k),
    clear: () => held.clear(),
    key: (i: number) => [...held.keys()][i] ?? null,
    get length() {
      return held.size
    },
  })

  beforeEach(() => {
    stores.local.clear()
    stores.session.clear()
    vi.stubGlobal('localStorage', storage(stores.local))
    vi.stubGlobal('sessionStorage', storage(stores.session))
    useStore.setState({ selected: 'a', toolResults: {} })
  })
  afterEach(() => {
    vi.stubGlobal('localStorage', undefined)
    vi.stubGlobal('sessionStorage', undefined)
  })

  it('writes no hunk, no output and no outcome to either store', () => {
    renderApp(<Message message={anEdit} />)
    fireEvent.click(screen.getByTestId('tool-expand'))
    arrives({
      type: 'toolResult',
      sessionId: 'a',
      toolUseId: 'toolu_e',
      result: { at: RECORDED_AT, hunks: [{ oldStart: 1, newStart: 1, lines: ['+a-private-line'] }], omitted: 0 },
    })
    arrives({
      type: 'fleet',
      mock: false,
      agents: [
        {
          sessionId: 'a',
          pid: 1,
          name: 'a',
          cwd: '/x',
          folder: 'x',
          status: 'idle',
          agentKind: 'claude',
          kind: 'interactive',
          startedAt: 1,
          refusals: { count: 2, lastAt: 2, since: 1 },
        },
      ],
    })
    expect(screen.getByTestId('tool-result-body').textContent).toContain('+a-private-line')
    const snapshot = JSON.stringify({ local: [...stores.local], session: [...stores.session] })
    expect(stores.local.size + stores.session.size).toBeGreaterThan(0)
    expect(snapshot).not.toMatch(/a-private-line|hunks|toolu_e|refusals/)
  })
})

