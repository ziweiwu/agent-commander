/**
 * INV-18 at the element: a link in a message is an `<a>` whose `href` is the
 * vetted one, opened in a new tab with no opener and no referrer. The parser
 * tests prove what may become an href; this proves the attributes the browser
 * acts on are the ones the invariant names, since a `target` or `rel` dropped
 * in a refactor fails nothing else.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Message } from '../../src/web/components/Message.tsx'
import type { ChatMessage } from '../../src/web/lib/chat.ts'

function message(text: string): ChatMessage {
  return { id: 'm1', role: 'agent', at: 0, text, tools: [], grouped: false }
}

describe('links in a message (INV-18)', () => {
  it('draws a URL as a link that opens elsewhere and hands nothing back', () => {
    render(<Message message={message('see https://example.test/a, then stop')} />)
    const link = screen.getByTestId('message-link')
    expect(link.tagName).toBe('A')
    expect(link.getAttribute('href')).toBe('https://example.test/a')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')?.split(' ')).toEqual(
      expect.arrayContaining(['noopener', 'noreferrer']),
    )
    expect(link.textContent).toBe('https://example.test/a')
    // The comma is prose and stays outside the link.
    expect(screen.getByTestId('message-text').textContent).toBe(
      'see https://example.test/a, then stop',
    )
  })

  it('labels a markdown link with its own text', () => {
    render(<Message message={message('read [the docs](https://example.test/d)')} />)
    const link = screen.getByTestId('message-link')
    expect(link.textContent).toBe('the docs')
    expect(link.getAttribute('href')).toBe('https://example.test/d')
  })

  it('carries a paren the URL opened all the way to the href', () => {
    render(
      <Message message={message('[Bash](https://en.wikipedia.org/wiki/Bash_(Unix_shell)) is it')} />,
    )
    const link = screen.getByTestId('message-link')
    expect(link.textContent).toBe('Bash')
    expect(link.getAttribute('href')).toBe('https://en.wikipedia.org/wiki/Bash_(Unix_shell)')
    // No stray paren left in the prose after the link.
    expect(screen.getByTestId('message-text').textContent).toBe('Bash is it')
  })

  it('renders a hostile scheme as text with no anchor at all', () => {
    render(<Message message={message('[click](javascript:alert(1))')} />)
    expect(screen.queryByTestId('message-link')).toBeNull()
    expect(screen.getByTestId('message-text').textContent).toBe('[click](javascript:alert(1))')
    expect(document.querySelector('a')).toBeNull()
  })
})

/*
 * The two surfaces a link reaches that prose does not, added because both were
 * places a URL sat in the conversation and could not be clicked.
 */
describe('links outside the prose (INV-18)', () => {
  const withTool = (tool: string, text: string): ChatMessage => ({
    id: 'm1',
    role: 'agent',
    at: 0,
    text: '',
    tools: [{ id: 't1', tool, text, subagent: false }],
    grouped: false,
  })

  /*
   * A `WebFetch` argument is usually nothing but a URL, and the tool row drew
   * it as flat text — so the one line in a conversation that is *entirely* a
   * link was the one place you could not follow it.
   */
  it('makes a URL in a tool argument a link, like one in a sentence', () => {
    render(<Message message={withTool('WebFetch', 'https://example.test/feed.xml')} />)
    const link = screen.getByTestId('message-link')
    expect(link.getAttribute('href')).toBe('https://example.test/feed.xml')
    expect(link.getAttribute('target')).toBe('_blank')
  })

  it('leaves a tool argument that is not a URL as text', () => {
    render(<Message message={withTool('Read', 'src/web/lib/chat.ts')} />)
    expect(screen.queryByTestId('message-link')).toBeNull()
    expect(screen.getByTestId('tool-call').textContent).toContain('src/web/lib/chat.ts')
  })

  /*
   * One gate, not two. A table cell runs through the same parser the prose
   * does, so a `javascript:` URL in a cell is refused for the same reason it
   * is refused in a sentence — there is no second path to an href.
   */
  it('makes a link inside a table cell, and refuses what the gate refuses', () => {
    render(
      <Message
        message={message(
          '| where | link |\n| --- | --- |\n| good | https://example.test/x |\n| bad | javascript:alert(1) |',
        )}
      />,
    )
    const links = screen.getAllByTestId('message-link')
    expect(links).toHaveLength(1)
    expect(links[0]?.getAttribute('href')).toBe('https://example.test/x')
    expect(screen.getByTestId('message-table').textContent).toContain('javascript:alert(1)')
  })
})

describe('tables in a message', () => {
  it('draws a grid with a header, and scrolls itself rather than the page', () => {
    render(<Message message={message('| Port | Use |\n| --- | --- |\n| 4317 | Production |')} />)
    const wrap = screen.getByTestId('message-table')
    expect(wrap.querySelectorAll('th')).toHaveLength(2)
    expect(wrap.querySelectorAll('tbody tr')).toHaveLength(1)
    expect(wrap.querySelectorAll('td')[0]?.textContent).toBe('4317')
  })

  it('leaves a sentence containing a pipe as a sentence', () => {
    render(<Message message={message('run ps | grep node')} />)
    expect(screen.queryByTestId('message-table')).toBeNull()
    expect(screen.getByTestId('message-text').textContent).toBe('run ps | grep node')
  })
})

/*
 * A tool argument is not prose.
 *
 * It is a glob, a command, a path — and markdown's emphasis markers are
 * ordinary characters in a shell. Running one through the prose parser
 * rewrote it silently: `**\/*.ts` rendered as `*\/.ts`, `rm -rf build/* dist/*`
 * lost both stars, and backticks were eaten. The row then showed a command
 * that was not the command that ran, while the `title` beside it still
 * carried the truth — which is the INV-11 over-claim wearing a rendering
 * bug's clothes.
 */
describe('a tool argument reaches the row unrewritten', () => {
  const withTool = (text: string): ChatMessage => ({
    id: 'm1',
    role: 'agent',
    at: 0,
    text: '',
    tools: [{ id: 't1', tool: 'Bash', text, subagent: false }],
    grouped: false,
  })

  it.each([
    ['**/*.ts'],
    ['rm -rf build/* dist/*'],
    ['`date`'],
    ['foo.*bar.*baz'],
    ['grep -r _init_ src/'],
  ])('keeps %j exactly', (arg) => {
    render(<Message message={withTool(arg)} />)
    expect(screen.getByTestId('tool-call').textContent).toContain(arg)
  })

  it('still linkifies a URL, which is the only thing the row wanted', () => {
    render(<Message message={withTool('https://example.test/feed.xml')} />)
    expect(screen.getByTestId('message-link').getAttribute('href')).toBe(
      'https://example.test/feed.xml',
    )
  })
})
