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
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { Message } from '../../src/web/components/Message.tsx'
import type { ChatMessage } from '../../src/web/lib/chat.ts'
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
