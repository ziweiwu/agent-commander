/**
 * The line that says what a session is on now (FR-CARD-7).
 *
 * A card's name is Claude Code's own `ai-title`, and that title is written
 * once and never revised — measured at one distinct value per session across
 * 236 transcripts on this machine. So a card goes on naming the first thing
 * that session was asked while the work moves somewhere else entirely.
 *
 * The line beside it is a *quotation*, never a summary: the server keeps the
 * most recent prompt a person typed that named something (`describe.rs`), and
 * the card draws it. Nothing here composes a sentence, which is what lets it
 * sit under the name without claiming to be a better reading of the work than
 * the user's own words (INV-11).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { AgentCard } from '../../src/web/components/AgentCard.tsx'
import type { Agent } from '../../src/shared/types.ts'
import { agent, renderApp, resetStore } from './helpers.tsx'

const card = (over: Partial<Agent> & { sessionId: string }) =>
  renderApp(<AgentCard agent={agent(over)} selected={false} onSelect={() => {}} />)

const line = (): HTMLElement | null => screen.queryByTestId('agent-description')

beforeEach(resetStore)

describe('FR-CARD-7 a card says what its session is on now', () => {
  it('draws the subject the server read, word for word', () => {
    card({
      sessionId: 'a',
      aiTitle: 'Under the Witch download',
      description: 'rewrite the registry discovery loop in rust',
    })
    expect(line()?.textContent).toBe('rewrite the registry discovery loop in rust')
  })

  it('draws nothing at all for an agent the server described no subject for', () => {
    card({ sessionId: 'a', aiTitle: 'Under the Witch download' })
    expect(line()).toBeNull()
  })

  /*
   * A session whose first prompt is still its subject would otherwise print
   * the same sentence twice, two lines apart. One of the two is the card's
   * name, so the other one goes.
   */
  it('withholds it where it would only repeat the name above it', () => {
    card({
      sessionId: 'a',
      derivedName: true,
      aiTitle: 'Port the registry loop',
      description: 'Port the registry loop',
    })
    expect(screen.getByTestId('agent-name').textContent).toBe('Port the registry loop')
    expect(line()).toBeNull()
  })

  /*
   * INV-11: the description is the user's text, so it arrives with whatever
   * they typed in it. It is drawn as one line of prose and never as markup —
   * the same rule the activity line follows.
   */
  it('renders a subject carrying markup as the text it is', () => {
    card({ sessionId: 'a', description: '**fix** the `parse_lines` loop' })
    const text = line()?.textContent ?? ''
    expect(text).toContain('parse_lines')
    expect(text).not.toContain('**')
    expect(line()?.querySelector('strong')).toBeNull()
  })
})
