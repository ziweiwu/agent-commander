/**
 * The detail panel's control row: model and close, and nothing the composer
 * strip already owns.
 *
 * Mode, Goal, Clear and Compact used to be here as well as in the strip, so a
 * desktop showed two Clear buttons for one action. The strip is the surface
 * that survives every layout — it is present below 900px and in full screen,
 * where this row is not — so it is the one home (FR-CTL-12), and the sequences
 * behind Clear and Compact are tested where they live, in
 * `ChatControls.test.tsx`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AgentControls } from '../../src/web/components/AgentControls.tsx'
import { agent, answer, renderApp, resetStore } from './helpers.tsx'

const closeAgent = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true, detail: 'graceful' }) as { ok: true; detail?: string }),
)

vi.mock('../../src/web/store/transport.ts', () => ({
  closeAgent,
  setAgentModel: vi.fn(),
}))

const idle = () => agent({ sessionId: 'a', status: 'idle', paneId: '%1' })

beforeEach(() => {
  resetStore()
  closeAgent.mockClear()
})

describe('FR-CTL-12 the row keeps only what the strip has no place for', () => {
  it('offers close, and none of the five the strip owns', () => {
    renderApp(<AgentControls agent={idle()} />)
    expect(screen.getByTestId('close-agent')).toBeTruthy()
    for (const id of ['shift-tab', 'model-select', 'goal-toggle', 'clear-agent', 'compact-agent']) {
      expect(screen.queryByTestId(id), `${id} belongs to the composer strip`).toBeNull()
    }
  })
})

describe('close', () => {
  it('asks first, naming the agent, and sends nothing when refused', async () => {
    const user = userEvent.setup()
    renderApp(<AgentControls agent={idle()} />)
    await user.click(screen.getByTestId('close-agent'))
    expect(screen.getByTestId('confirm-dialog').textContent).toContain('a')
    await answer(user, 'cancel')
    expect(closeAgent).not.toHaveBeenCalled()
  })

  it('closes once the confirmation is accepted', async () => {
    const user = userEvent.setup()
    renderApp(<AgentControls agent={idle()} />)
    await user.click(screen.getByTestId('close-agent'))
    await answer(user, 'accept')
    expect(closeAgent).toHaveBeenCalledOnce()
  })

  // `/exit` is typed into the prompt, so it waits for idle (INV-8).
  it('is unavailable while the agent is busy, because it types', () => {
    renderApp(<AgentControls agent={agent({ sessionId: 'a', status: 'busy', paneId: '%1' })} />)
    expect((screen.getByTestId('close-agent') as HTMLButtonElement).disabled).toBe(true)
  })
})
