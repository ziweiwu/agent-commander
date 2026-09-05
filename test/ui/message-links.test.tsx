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
