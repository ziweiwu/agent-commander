/**
 * Pruning, from the button to the closes it issues.
 *
 * This is the only control in the app that acts on several agents at once, and
 * every one of those acts is irreversible — so what is asserted here is mostly
 * restraint: it appears only when there is something to close, it closes only
 * what it named, it closes nothing at all if the confirmation is declined, and
 * it never fires while the fleet view is stale.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FleetList } from '../../src/web/components/FleetList.tsx'
import { useStore } from '../../src/web/store/store.ts'
import { agent, renderApp, resetStore } from './helpers.tsx'

interface ControlResult {
  ok: boolean
  error?: string
}

const closeAgentById = vi.fn<(id: string) => Promise<ControlResult>>(async () => ({ ok: true }))

vi.mock('../../src/web/store/transport.ts', () => ({
  closeAgentById: (id: string) => closeAgentById(id),
  focusAgent: vi.fn(),
  sendMessage: vi.fn(),
}))

const unused = (sessionId: string) => agent({ sessionId, status: 'idle' })
const working = (sessionId: string) =>
  agent({ sessionId, status: 'busy', tokens: 4_000, activity: 'Bash: npm test' })

const list = () => <FleetList tiled={false} selected={null} onSelect={() => {}} />

beforeEach(() => {
  resetStore()
  closeAgentById.mockClear()
  closeAgentById.mockResolvedValue({ ok: true })
  // Cleared as well as stubbed: `spyOn` hands back the same mock every time, so
  // without this a test reads the previous test's confirmation as its own.
  vi.spyOn(window, 'confirm').mockClear().mockReturnValue(true)
})

describe('prune', () => {
  it('is absent when every session has been used', () => {
    useStore.setState({ agents: [working('a')] })
    renderApp(list())

    expect(screen.queryByTestId('prune-button')).toBeNull()
  })

  it('counts what it will close', () => {
    useStore.setState({ agents: [unused('a'), working('b'), unused('c')] })
    renderApp(list())

    expect(screen.getByTestId('prune-button').textContent).toContain('2')
  })

  it('closes exactly the unused sessions, and nothing else', async () => {
    const user = userEvent.setup()
    useStore.setState({ agents: [unused('a'), working('b'), unused('c')] })
    renderApp(list())

    await user.click(screen.getByTestId('prune-button'))

    expect(closeAgentById.mock.calls.map((c) => c[0])).toEqual(['a', 'c'])
  })

  // The confirmation is the whole guard; declining it must leave every session alone.
  it('closes nothing when the confirmation is declined', async () => {
    const user = userEvent.setup()
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    useStore.setState({ agents: [unused('a')] })
    renderApp(list())

    await user.click(screen.getByTestId('prune-button'))

    expect(closeAgentById).not.toHaveBeenCalled()
  })

  // INV-11: with the socket down the cards are memories. "Idle and never
  // prompted" ten minutes ago is not a claim about now.
  it('is unavailable while the fleet view is not live', () => {
    useStore.setState({ agents: [unused('a')], conn: 'closed' })
    renderApp(list())

    expect((screen.getByTestId('prune-button') as HTMLButtonElement).disabled).toBe(true)
  })

  it('names the sessions in the confirmation', async () => {
    const user = userEvent.setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    useStore.setState({ agents: [unused('projects-04')] })
    renderApp(list())

    await user.click(screen.getByTestId('prune-button'))

    expect(confirm.mock.calls[0]?.[0]).toContain('projects-04')
  })

  /*
   * One session refusing to exit is not a reason to abandon the rest, and the
   * report has to be what happened rather than what was attempted.
   */
  it('keeps going when one refuses, and says so', async () => {
    const user = userEvent.setup()
    closeAgentById
      .mockResolvedValueOnce({ ok: false, error: 'pane has exited' })
      .mockResolvedValueOnce({ ok: true })
    useStore.setState({ agents: [unused('a'), unused('b')] })
    renderApp(list())

    await user.click(screen.getByTestId('prune-button'))

    expect(closeAgentById).toHaveBeenCalledTimes(2)
    expect(useStore.getState().toast).toContain('1')
  })
})
