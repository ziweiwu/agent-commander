import { describe, expect, it } from 'vitest'
import { buildMessages, parseInline, pendingMessage, reconcile } from '../src/web/chat.ts'
import { dayLabel } from '../src/web/format.ts'
import type { TimelineEvent } from '../src/shared/types.ts'

let seq = 0
const ev = (over: Partial<TimelineEvent> & { kind: TimelineEvent['kind'] }): TimelineEvent => ({
  id: `e${seq++}`,
  at: 1_000_000,
  text: '',
  ...over,
})

describe('buildMessages', () => {
  it('splits the log into You and Agent turns', () => {
    const messages = buildMessages([
      ev({ kind: 'user', text: 'add dark mode' }),
      ev({ kind: 'assistant', text: 'Getting oriented.' }),
    ])
    expect(messages.map((m) => [m.role, m.text])).toEqual([
      ['you', 'add dark mode'],
      ['agent', 'Getting oriented.'],
    ])
  })

  // Tool calls are what the agent did, not separate things it said.
  it('folds tool calls into the agent message that preceded them', () => {
    const messages = buildMessages([
      ev({ kind: 'assistant', text: 'Looking now.' }),
      ev({ kind: 'tool', tool: 'Read', text: 'a.ts' }),
      ev({ kind: 'tool', tool: 'Edit', text: 'b.ts' }),
    ])
    expect(messages).toHaveLength(1)
    expect(messages[0]?.tools.map((t) => t.tool)).toEqual(['Read', 'Edit'])
  })

  it('marks subagent delegations distinctly', () => {
    const messages = buildMessages([
      ev({ kind: 'assistant', text: 'Delegating.' }),
      ev({ kind: 'subagent', tool: 'Task', text: 'audit tokens' }),
    ])
    expect(messages[0]?.tools[0]).toMatchObject({ tool: 'Task', subagent: true })
  })

  it('never drops a tool call that arrives before any reply', () => {
    const messages = buildMessages([ev({ kind: 'tool', tool: 'Bash', text: 'ls' })])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ role: 'agent', text: '' })
    expect(messages[0]?.tools[0]?.tool).toBe('Bash')
  })

  it('does not attach agent tools to a user message', () => {
    const messages = buildMessages([
      ev({ kind: 'user', text: 'go' }),
      ev({ kind: 'tool', tool: 'Bash', text: 'ls' }),
    ])
    expect(messages).toHaveLength(2)
    expect(messages[0]?.tools).toEqual([])
    expect(messages[1]?.role).toBe('agent')
  })

  it('groups consecutive messages from the same speaker', () => {
    const messages = buildMessages([
      ev({ kind: 'assistant', text: 'one', at: 1000 }),
      ev({ kind: 'assistant', text: 'two', at: 2000 }),
    ])
    expect(messages[0]?.grouped).toBe(false)
    expect(messages[1]?.grouped).toBe(true)
  })

  it('starts a new group after a long gap', () => {
    const messages = buildMessages([
      ev({ kind: 'assistant', text: 'one', at: 0 }),
      ev({ kind: 'assistant', text: 'two', at: 10 * 60_000 }),
    ])
    expect(messages[1]?.grouped).toBe(false)
  })

  it('starts a new group when the speaker changes', () => {
    const messages = buildMessages([
      ev({ kind: 'user', text: 'hi', at: 1000 }),
      ev({ kind: 'assistant', text: 'hello', at: 1100 }),
    ])
    expect(messages[1]?.grouped).toBe(false)
  })

  it('returns nothing for an empty transcript', () => {
    expect(buildMessages([])).toEqual([])
  })
})

describe('reconcile', () => {
  const confirmed = buildMessages([ev({ kind: 'user', text: 'hello there', at: 1000 })])

  it('keeps a local echo the transcript has not caught up with', () => {
    const local = pendingMessage('brand new', 2000, 0)
    const merged = reconcile(confirmed, [local])
    expect(merged).toHaveLength(2)
    expect(merged[1]).toMatchObject({ text: 'brand new', pending: true })
  })

  // Otherwise the message would appear twice once the agent logged it.
  it('drops the echo once the same text arrives from the transcript', () => {
    const local = pendingMessage('hello there', 2000, 0)
    expect(reconcile(confirmed, [local])).toHaveLength(1)
  })

  it('ignores surrounding whitespace when matching', () => {
    const local = pendingMessage('  hello there \n', 2000, 0)
    expect(reconcile(confirmed, [local])).toHaveLength(1)
  })

  it('is a no-op with nothing pending', () => {
    expect(reconcile(confirmed, [])).toBe(confirmed)
  })

  it('re-derives grouping across the join', () => {
    const local = pendingMessage('second', 1500, 0)
    const merged = reconcile(confirmed, [local])
    // Same speaker, 500ms apart, so it continues the run.
    expect(merged[1]?.grouped).toBe(true)
  })
})

describe('dayLabel', () => {
  const now = new Date(2026, 7, 14, 12, 0, 0).getTime()

  it('names today and yesterday', () => {
    expect(dayLabel(new Date(2026, 7, 14, 9, 0).getTime(), now)).toBe('Today')
    expect(dayLabel(new Date(2026, 7, 13, 23, 0).getTime(), now)).toBe('Yesterday')
  })

  it('falls back to a date further back', () => {
    expect(dayLabel(new Date(2026, 7, 1).getTime(), now)).toMatch(/Aug/)
  })
})

describe('parseInline', () => {
  const render = (t: string): string =>
    parseInline(t)
      .map((s) => (s.kind === 'text' ? s.text : `<${s.kind}>${s.text}</${s.kind}>`))
      .join('')

  it('leaves plain prose untouched', () => {
    expect(render('just words here')).toBe('just words here')
  })

  it('renders inline code, bold and italic', () => {
    expect(render('use `npm test` now')).toBe('use <code>npm test</code> now')
    expect(render('**Bug 7** found')).toBe('<bold>Bug 7</bold> found')
    expect(render('a *settled* frame')).toBe('a <italic>settled</italic> frame')
    expect(render('an _emphatic_ point')).toBe('an <italic>emphatic</italic> point')
  })

  it('does not split bold into two italics', () => {
    expect(render('**both**')).toBe('<bold>both</bold>')
  })

  it('handles several markers in one message', () => {
    expect(render('`a` and **b** and *c*')).toBe(
      '<code>a</code> and <bold>b</bold> and <italic>c</italic>',
    )
  })

  it('leaves an unmatched marker as literal text', () => {
    expect(render('2 * 3 = 6')).toBe('2 * 3 = 6')
    expect(render('unclosed `code')).toBe('unclosed `code')
  })

  // Spans are turned into text nodes by the caller, so markup can never execute.
  it('treats HTML in a transcript as literal text', () => {
    const spans = parseInline('<img src=x onerror=alert(1)>')
    expect(spans).toEqual([{ kind: 'text', text: '<img src=x onerror=alert(1)>' }])
  })

  it('is reusable across calls despite the global regex', () => {
    const first = render('**a**')
    expect(render('**a**')).toBe(first)
    expect(first).toBe('<bold>a</bold>')
  })
})
