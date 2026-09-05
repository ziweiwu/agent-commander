import { describe, expect, it } from 'vitest'
import {
  buildMessages,
  countSaid,
  parseInline,
  pendingMessage,
  plainText,
  reconcile,
} from '../src/web/lib/chat.ts'
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

/**
 * The quick prompts are "Continue" and "Go ahead", so the same text is sent
 * over and over -- and matching a local echo on text alone reconciled the
 * second one against the first, an hour earlier. The echo vanished the instant
 * it was drawn, taking its delivery timer with it, so a message that never
 * arrived was never marked undelivered either.
 */
describe('reconcile with a message that has been sent before', () => {
  const said = (text: string, at: number) => ev({ kind: 'user', text, at })

  it('keeps the second copy of a repeated message visible', () => {
    const history = buildMessages([said('Continue', 1000)])
    // Sent again now: one copy already in the conversation.
    const local = pendingMessage('Continue', 5000, 0, 1)
    const merged = reconcile(history, [local])
    expect(merged).toHaveLength(2)
    expect(merged[1]).toMatchObject({ text: 'Continue', pending: true })
  })

  it('drops it once the transcript records the second copy too', () => {
    const history = buildMessages([said('Continue', 1000), said('Continue', 5000)])
    const local = pendingMessage('Continue', 5000, 0, 1)
    expect(reconcile(history, [local])).toHaveLength(2)
    expect(reconcile(history, [local]).every((m) => m.pending !== true)).toBe(true)
  })

  it('confirms two echoes of the same text one at a time', () => {
    const first = pendingMessage('Continue', 5000, 0, 0)
    const second = pendingMessage('Continue', 5100, 1, 1)

    const none = reconcile(buildMessages([]), [first, second])
    expect(none.filter((m) => m.pending)).toHaveLength(2)

    const one = reconcile(buildMessages([said('Continue', 5200)]), [first, second])
    expect(one.filter((m) => m.pending)).toHaveLength(1)

    const both = reconcile(buildMessages([said('Continue', 5200), said('Continue', 5300)]), [
      first,
      second,
    ])
    expect(both.filter((m) => m.pending)).toHaveLength(0)
  })

  /*
   * A failed message is one the transcript never recorded. Counting it would
   * make the *next* copy wait for a confirmation that can never come, and be
   * marked undelivered in its turn.
   */
  it('does not count an undelivered message against the next attempt', () => {
    const failed = { ...pendingMessage('Continue', 1000, 0, 0), pending: false, failed: true }
    expect(countSaid([failed], 'Continue')).toBe(0)

    const retry = pendingMessage('Continue', 5000, 1, countSaid([failed], 'Continue'))
    const merged = reconcile(buildMessages([said('Continue', 5200)]), [retry])
    expect(merged.filter((m) => m.pending)).toHaveLength(0)
  })

  it('counts an echo still in flight, so a burst does not collapse', () => {
    const inFlight = pendingMessage('Continue', 1000, 0, 0)
    expect(countSaid([inFlight], 'Continue')).toBe(1)
  })
})

/*
 * INV-18. A link is the one span that reaches outside the page, so what may
 * become an `href` is decided here and nowhere else: `http` and `https`, parsed
 * by `new URL`, or the literal text it arrived as.
 */
describe('parseInline: links (INV-18)', () => {
  const links = (text: string) => parseInline(text).filter((s) => s.kind === 'link')
  const render = (text: string): string =>
    parseInline(text)
      .map((s) => (s.kind === 'link' ? `<a ${s.href}>${s.text}</a>` : s.text))
      .join('')

  it('turns a bare URL into a link and leaves the sentence around it', () => {
    expect(render('see https://example.test/docs for more')).toBe(
      'see <a https://example.test/docs>https://example.test/docs</a> for more',
    )
  })

  it('turns a markdown link into a link with its own label', () => {
    expect(render('read the [MDN page](https://developer.mozilla.org/x) first')).toBe(
      'read the <a https://developer.mozilla.org/x>MDN page</a> first',
    )
  })

  it('does not swallow the punctuation a sentence leaves after a URL', () => {
    expect(render('done: https://example.test/a.')).toBe(
      'done: <a https://example.test/a>https://example.test/a</a>.',
    )
    expect(render('(https://example.test)')).toBe(
      '(<a https://example.test/>https://example.test</a>)',
    )
    expect(render('https://example.test/a, https://example.test/b')).toBe(
      '<a https://example.test/a>https://example.test/a</a>, <a https://example.test/b>https://example.test/b</a>',
    )
  })

  it('keeps a closing paren the URL itself opened', () => {
    const [span] = links('https://en.wikipedia.org/wiki/Bash_(Unix_shell) is it')
    expect(span?.href).toBe('https://en.wikipedia.org/wiki/Bash_(Unix_shell)')
  })

  /*
   * The rule is about brackets, not about parens: `]` and `}` were on the
   * strip list with no exemption, so a `{id}` path template lost its brace and
   * became a live link to the wrong resource, and `https://[::1]` lost its `]`
   * and then failed `new URL` altogether.
   */
  it('keeps a closing bracket or brace the URL itself opened', () => {
    expect(links('try https://api.test/v1/users/{id} next')[0]?.text).toBe(
      'https://api.test/v1/users/{id}',
    )
    expect(links('local: https://[::1]/health')[0]?.href).toBe('https://[::1]/health')
    expect(links('local: https://[::1]')[0]?.href).toBe('https://[::1]/')
  })

  it('still sheds a bracket the sentence opened, and everything after it', () => {
    expect(render('[https://example.test/a]')).toBe(
      '[<a https://example.test/a>https://example.test/a</a>]',
    )
    expect(render('{https://example.test/a}')).toBe(
      '{<a https://example.test/a>https://example.test/a</a>}',
    )
    expect(render('https://x.test/a).')).toBe('<a https://x.test/a>https://x.test/a</a>).')
  })

  // Recounting the prefix per shed character was quadratic: 20k parens took
  // seconds, on the main thread, for one message.
  it('sheds a long run of punctuation in linear time', () => {
    const text = `https://x.test/a${')'.repeat(20_000)}`
    const started = performance.now()
    const [span] = links(text)
    expect(performance.now() - started).toBeLessThan(100)
    expect(span?.href).toBe('https://x.test/a')
  })

  /*
   * A markdown link's URL may hold parens of its own, and closing at the first
   * `)` produced a valid link to the wrong page plus a stray `)` in the prose
   * — the worst shape, because nothing about it looks broken.
   */
  it('closes a markdown link at the paren that balances, not the first one', () => {
    expect(render('see [Bash](https://en.wikipedia.org/wiki/Bash_(Unix_shell)) first')).toBe(
      'see <a https://en.wikipedia.org/wiki/Bash_(Unix_shell)>Bash</a> first',
    )
  })

  it('closes a markdown link at the first paren when the URL opened none', () => {
    expect(render('[x](https://a.test) tail')).toBe('<a https://a.test/>x</a> tail')
    expect(render('[x](https://a.test).')).toBe('<a https://a.test/>x</a>.')
  })

  it('leaves a markdown link that never closes as the text it is', () => {
    expect(render('[x](https://a.test')).toBe('[x](https://a.test')
    expect(links('[x](https://a.test')).toEqual([])
  })

  it('never reads the underscores or stars in a URL as emphasis', () => {
    expect(render('https://example.test/_a_/*b*/c')).toBe(
      '<a https://example.test/_a_/*b*/c>https://example.test/_a_/*b*/c</a>',
    )
  })

  it('leaves a URL in backticks as code', () => {
    const spans = parseInline('run `curl https://example.test`')
    expect(spans.find((s) => s.kind === 'link')).toBeUndefined()
    expect(spans.find((s) => s.kind === 'code')?.text).toBe('curl https://example.test')
  })

  // The regex is a claim about the text; these are the strings that pass a
  // looser one. Each must arrive on screen as text and never as an `href`.
  it('refuses every scheme but http and https, as literal text', () => {
    for (const hostile of [
      '[click](javascript:alert(1))',
      '[click](data:text/html,<script>alert(1)</script>)',
      '[click](vbscript:msgbox)',
      '[click](file:///etc/passwd)',
      'javascript:alert(1)',
      'ftp://example.test/x',
      '[click](//example.test)',
      '[click](/api/agents)',
    ]) {
      expect(links(hostile), hostile).toEqual([])
      expect(plainText(hostile), hostile).toBe(hostile)
    }
  })

  it('refuses a URL with no host', () => {
    expect(links('https://')).toEqual([])
    expect(links('https://.')).toEqual([])
    expect(plainText('https://.')).toBe('https://.')
  })

  it('carries a normalised href and the text as written', () => {
    const [span] = links('https://Example.test/a b'.replace(' ', ''))
    expect(span?.text).toBe('https://Example.test/ab')
    expect(span?.href).toBe('https://example.test/ab')
  })

  it('takes the inner link when brackets nest, rather than a label with a bracket in it', () => {
    expect(render('[a [b](https://x.test)](https://y.test)')).toBe(
      '[a <a https://x.test/>b</a>](<a https://y.test/>https://y.test</a>)',
    )
  })

  it('renders as its label on a card, where a link cannot be followed', () => {
    expect(plainText('see [the docs](https://example.test/d) now')).toBe('see the docs now')
    expect(plainText('see https://example.test/d.')).toBe('see https://example.test/d.')
  })
})
