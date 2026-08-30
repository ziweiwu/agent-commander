/**
 * Clear and Compact: the two control actions that act on an agent's memory.
 *
 * They look like a pair and are guarded like one — both type into the prompt,
 * so both wait for idle (INV-8), and both are Claude Code slash commands, so
 * neither is offered for another CLI (INV-7). What separates them is what the
 * app can honestly say afterwards, and that is what most of this file is about.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AgentControls } from '../../src/web/components/AgentControls.tsx'
import { agent, renderApp, resetStore } from './helpers.tsx'
import { useStore } from '../../src/web/store/store.ts'

const clearAgentContext = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true, detail: 'session-after' }) as { ok: true; detail?: string }),
)
const compactAgentContext = vi.hoisted(() => vi.fn(async () => ({ ok: true }) as { ok: true }))
const navigate = vi.hoisted(() => vi.fn())

/**
 * Answer the confirmation the way a person does.
 *
 * These actions used to be guarded by `window.confirm`, which a test could
 * stub. They are now guarded by a real dialog — because `confirm()` cannot
 * name the specific agent or the specific loss, is unthemed and untranslatable,
 * and is the least reliable dialog surface on a phone. So the tests click the
 * verb, which is also what pins that the guard is still there at all.
 */
async function answer(user: ReturnType<typeof userEvent.setup>, verb: 'accept' | 'cancel') {
  await user.click(await screen.findByTestId(`confirm-${verb}`))
}

vi.mock('../../src/web/store/transport.ts', () => ({
  clearAgentContext,
  compactAgentContext,
  closeAgent: vi.fn(),
  cycleAgentMode: vi.fn(),
  setAgentModel: vi.fn(),
}))
vi.mock('../../src/web/hooks/useTokenNavigate.ts', () => ({
  useTokenNavigate: () => navigate,
}))

const idle = () => agent({ sessionId: 'session-before', status: 'idle', paneId: '%1' })

beforeEach(() => {
  resetStore()
  clearAgentContext.mockClear()
  compactAgentContext.mockClear()
  navigate.mockClear()
  clearAgentContext.mockResolvedValue({ ok: true, detail: 'session-after' })
})

describe('clear', () => {
  it('asks before discarding a conversation there is no way to get back', async () => {
    const user = userEvent.setup()
    renderApp(<AgentControls agent={idle()} />)

    await user.click(screen.getByTestId('clear-agent'))
    await answer(user, 'cancel')

    expect(clearAgentContext).not.toHaveBeenCalled()
  })

  /*
   * The reason this needs a test of its own: `/clear` does not edit a session,
   * it replaces one. The id the user is looking at stops existing, so without
   * following it `focusAgent` points at nothing, the route bails to the fleet,
   * and the agent reappears further down the page as a stranger. From the
   * user's side the panel closed itself.
   */
  it('follows the agent to the session id it is now running', async () => {
    const user = userEvent.setup()
    renderApp(<AgentControls agent={idle()} />)

    await user.click(screen.getByTestId('clear-agent'))
    await answer(user, 'accept')

    expect(navigate).toHaveBeenCalledWith('/agent/session-after', { replace: true })
  })

  /*
   * No new session appeared inside the window. Navigating on that would send
   * the browser to an id that may not exist, and calling it done would claim
   * something nobody read (INV-11).
   */
  it('says so and stays put when no new session appeared', async () => {
    const user = userEvent.setup()
    clearAgentContext.mockResolvedValue({ ok: true, detail: 'unverified' })
    renderApp(<AgentControls agent={idle()} />)

    await user.click(screen.getByTestId('clear-agent'))
    await answer(user, 'accept')

    expect(navigate).not.toHaveBeenCalled()
    expect(useStore.getState().toast).toBeTruthy()
  })

  /*
   * INV-2's "exactly once", and the stakes are higher here than anywhere else
   * it applies: a second clear would discard the fresh session the first one
   * had just created.
   */
  it('sends one clear from a double click', async () => {
    const user = userEvent.setup()
    clearAgentContext.mockReturnValue(new Promise(() => {}) as never)
    renderApp(<AgentControls agent={idle()} />)

    await user.click(screen.getByTestId('clear-agent'))
    // Two answers to one question: the second must not start a second clear,
    // which would discard the fresh session the first one just created.
    const accept = await screen.findByTestId('confirm-accept')
    await user.click(accept)
    await user.click(accept)

    expect(clearAgentContext).toHaveBeenCalledOnce()
  })

  it('is unavailable while the agent is busy, because it types', () => {
    renderApp(<AgentControls agent={agent({ sessionId: 'a', status: 'busy', paneId: '%1' })} />)
    expect((screen.getByTestId('clear-agent') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('compact', () => {
  // Compaction shortens the context rather than discarding it, and Claude Code
  // does it unprompted when the window fills. There is nothing to warn about.
  it('does not ask first', async () => {
    const user = userEvent.setup()
    renderApp(<AgentControls agent={idle()} />)

    await user.click(screen.getByTestId('compact-agent'))

    // Asserted against the real guard rather than a stubbed `window.confirm`:
    // no dialog is raised at all, and the action goes straight through.
    expect(screen.queryByTestId('confirm-dialog')).toBeNull()
    expect(compactAgentContext).toHaveBeenCalledOnce()
  })

  /*
   * The real sample ran for 157 seconds. Nothing waits for it, so the only
   * honest thing to say is that it was asked for — the result arrives later, on
   * its own, as a mark in the conversation.
   */
  it('reports the request rather than a finished compaction', async () => {
    const user = userEvent.setup()
    renderApp(<AgentControls agent={idle()} />)

    await user.click(screen.getByTestId('compact-agent'))

    expect(useStore.getState().toast).toMatch(/requested/i)
  })

  it('is unavailable while the agent is busy, because it types', () => {
    renderApp(<AgentControls agent={agent({ sessionId: 'a', status: 'busy', paneId: '%1' })} />)
    expect((screen.getByTestId('compact-agent') as HTMLButtonElement).disabled).toBe(true)
  })
})
