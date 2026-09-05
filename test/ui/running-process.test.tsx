/**
 * INV-11: what a busy agent is running is read from the process table, and
 * the card says so. It is the one activity signal a CLI with no transcript has,
 * so it stands in for the activity line there; a Claude card keeps the
 * transcript's line on its face and carries the process in its fold.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { AgentCard } from '../../src/web/components/AgentCard.tsx'
import type { Agent } from '../../src/shared/types.ts'
import { agent, renderApp, resetStore } from './helpers.tsx'
import { matches } from '../../src/web/lib/format.ts'

const FOUR_MINUTES = 4 * 60_000

const running = { pid: 84_639, command: 'npm test', since: Date.now() - FOUR_MINUTES }

const kiro = (over: Partial<Agent> = {}): Agent =>
  agent({
    sessionId: 'tmux:kiro-1787832510',
    agentKind: 'kiro',
    status: 'busy',
    statusInferred: true,
    lastActivityAt: Date.now() - 4_000,
    running,
    ...over,
  })

const card = (subject: Agent) =>
  renderApp(<AgentCard agent={subject} tree={undefined} selected={false} onSelect={() => {}} />)

beforeEach(resetStore)

describe('INV-11 a card names the process a busy agent is running', () => {
  it('stands in for the activity line on a card with no transcript', () => {
    card(kiro())
    const line = screen.getByTestId('agent-activity')
    expect(line.textContent).toContain('running npm test')
    expect(line.textContent).toContain('4m')
    expect(line.dataset.running).toBe('true')
    expect(line.title).toMatch(/process table/i)
    // Still no trail: a process start is not a transcript write.
    expect(screen.queryByTestId('agent-trail')).toBeNull()
  })

  it('keeps the transcript on the face of a Claude card and folds the process', () => {
    card(agent({ sessionId: 'c', status: 'busy', activity: 'Bash: cargo test', running }))
    expect(screen.getByTestId('agent-activity').textContent).toContain('Bash: cargo test')
    expect(screen.queryByTestId('agent-running')).toBeNull()

    fireEvent.click(screen.getByTestId('details-toggle'))
    const fold = screen.getByTestId('agent-running')
    expect(fold.textContent).toContain('npm test')
    expect(fold.textContent).toContain('4m')
    expect(fold.textContent).toMatch(/process table/i)
  })

  it('says nothing when the server sent nothing', () => {
    card(kiro({ running: undefined }))
    expect(screen.getByTestId('agent-activity').dataset.running).toBeUndefined()
    fireEvent.click(screen.getByTestId('details-toggle'))
    expect(screen.queryByTestId('agent-running')).toBeNull()
  })

  it('is searchable', () => {
    expect(matches(kiro(), 'npm')).toBe(true)
    expect(matches(kiro({ running: undefined }), 'npm')).toBe(false)
  })
})
