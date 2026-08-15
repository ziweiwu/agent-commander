import { describe, expect, it } from 'vitest'
import { buildMessages, parseInline, pendingMessage, plainText, reconcile } from '../src/web/lib/chat.ts'
import { dayMark } from '../src/web/lib/format.ts'
import { translate } from '../src/web/lib/i18n.ts'
import { formatDay } from '../src/web/lib/i18n.ts'
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

describe('day separators', () => {
  const now = new Date(2026, 7, 14, 12, 0, 0).getTime()
  const en = (at: number) => formatDay('en', dayMark(at, now))

  it('names today and yesterday', () => {
    expect(en(new Date(2026, 7, 14, 9, 0).getTime())).toBe('Today')
    expect(en(new Date(2026, 7, 13, 23, 0).getTime())).toBe('Yesterday')
  })

  it('falls back to a date further back', () => {
    expect(en(new Date(2026, 7, 1).getTime())).toMatch(/Aug/)
  })

  it('localises to Chinese', () => {
    expect(formatDay('zh-CN', dayMark(new Date(2026, 7, 14, 9, 0).getTime(), now))).toBe('今天')
    expect(formatDay('zh-CN', dayMark(new Date(2026, 7, 13, 9, 0).getTime(), now))).toBe('昨天')
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

describe('interpolated values', () => {
  // These come from user input and server errors, so they have no length bound.
  it('caps a long substituted value rather than echoing it whole', () => {
    const out = translate('en', 'emptyFilterQuery', { query: 'x'.repeat(500) })
    expect(out.length).toBeLessThan(120)
    expect(out).toContain('…')
  })

  it('leaves a short value untouched', () => {
    expect(translate('en', 'emptyFilterQuery', { query: 'lego' })).toContain('lego')
  })

  it('leaves an unknown placeholder in place rather than printing undefined', () => {
    expect(translate('en', 'emptyFilterQuery', {})).toContain('{query}')
  })
})

describe('plainText', () => {
  // The card's activity line is one row of plain text; matched markdown markers
  // there are noise the reader has to look past.
  it('renders matched markdown as its text', () => {
    expect(plainText('Repo is back to normal. `main` and `skills-find` both build.')).toBe(
      'Repo is back to normal. main and skills-find both build.',
    )
    expect(plainText('**Bug 7** was the best find')).toBe('Bug 7 was the best find')
  })

  it('leaves ordinary prose untouched', () => {
    expect(plainText('Rerun the exhaustive sweep')).toBe('Rerun the exhaustive sweep')
  })

  /*
   * These are the cases a blanket marker-strip corrupted. Deleting every `*`,
   * `_` and backtick made "5 * 3 = 15" read "5  3 = 15" and "__init__.py" read
   * "init.py" — the preview then misrepresents what the agent actually said.
   * An unpaired marker surviving is the lesser evil, and is asserted below.
   */
  it('never alters text that only looks like markdown', () => {
    expect(plainText('5 * 3 = 15')).toBe('5 * 3 = 15')
    expect(plainText('renamed __init__.py')).toBe('renamed __init__.py')
    expect(plainText('react_hig_datepicker downloads')).toBe('react_hig_datepicker downloads')
    expect(plainText('2 * 3 = 6')).toBe('2 * 3 = 6')
  })

  it('leaves an unpaired marker visible rather than guessing', () => {
    expect(plainText('**`react-hig-datepicker`, with 6,306 downloads')).toBe(
      '**react-hig-datepicker, with 6,306 downloads',
    )
  })
})

describe('parseInline: text that only looks like markdown', () => {
  const render = (t: string): string =>
    parseInline(t)
      .map((s) => (s.kind === 'text' ? s.text : `<${s.kind}>${s.text}</${s.kind}>`))
      .join('')

  /*
   * A single combined emphasis rule let `*` close with `_` and matched
   * underscores inside words, so an agent saying it renamed `__init__.py`
   * rendered "_init_.py" — the app misquoting the agent.
   */
  it('leaves intraword underscores alone', () => {
    expect(render('renamed __init__.py')).toBe('renamed __init__.py')
    expect(render('react_hig_datepicker downloads')).toBe('react_hig_datepicker downloads')
    expect(render('SCREAMING_SNAKE_CASE')).toBe('SCREAMING_SNAKE_CASE')
  })

  it('still emphasises a properly delimited underscore pair', () => {
    expect(render('an _emphatic_ point')).toBe('an <italic>emphatic</italic> point')
  })

  it('does not let one marker close with another', () => {
    expect(render('*mismatched_')).toBe('*mismatched_')
  })

  it('leaves lone asterisks in arithmetic alone', () => {
    expect(render('5 * 3 = 15')).toBe('5 * 3 = 15')
  })
})
