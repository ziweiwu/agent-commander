/**
 * The fleet list's polling, and what it does with an answer that has not moved.
 *
 * The server stopped re-sending an unchanged graph (`test/tree-routes.test.ts`).
 * This is the half that makes that worth anything: the browser has to send the
 * tag back, and it has to leave its existing trees alone when the answer is a
 * 304. `useFleetTrees` holds the tag in a ref and a `{ changed: false }` answer
 * never reaches `setTrees`, so identity churn is impossible by construction —
 * what a reader would notice, and what is asserted here, is the consequence:
 * an unchanged answer is not an empty one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import type { AgentTree } from '../../src/shared/types.ts'
import { FleetList } from '../../src/web/components/FleetList.tsx'
import { fetchTree } from '../../src/web/store/transport.ts'
import { useStore } from '../../src/web/store/store.ts'
import { agent, renderApp, resetStore } from './helpers.tsx'

vi.mock('../../src/web/store/transport.ts', () => ({
  fetchTree: vi.fn(),
  closeAgentById: vi.fn(),
}))

const asMock = vi.mocked(fetchTree)

const POLL_MS = 3_000

const tree = (agentId: string): AgentTree => ({
  sessionId: 'a',
  children: [
    {
      agentId,
      agentType: 'Explore',
      description: 'look at something',
      depth: 1,
      lastWriteAt: Date.now() - 5_000,
      bytes: 40_000,
      state: 'quiet',
      children: [],
    },
  ],
})

const list = () =>
  renderApp(<FleetList tiled={false} selected={null} onSelect={() => {}} />)

const delegateLine = () => screen.queryByTestId('agent-delegates')

beforeEach(() => {
  resetStore()
  asMock.mockReset()
  useStore.setState({ agents: [agent({ sessionId: 'a', status: 'busy' })] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('INV-4 the fleet does not re-read the graph it already has', () => {
  it('sends no tag on the first poll and the served tag on the next', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    asMock
      .mockResolvedValueOnce({ changed: true, trees: [tree('a')], etag: '"v1"' })
      .mockResolvedValue({ changed: false })

    list()

    await waitFor(() => expect(asMock).toHaveBeenCalledTimes(1))
    expect(asMock.mock.calls[0]?.[0]).toBeNull()

    await vi.advanceTimersByTimeAsync(POLL_MS)

    await waitFor(() => expect(asMock).toHaveBeenCalledTimes(2))
    expect(asMock.mock.calls[1]?.[0]).toBe('"v1"')
  })

  /*
   * The failure this guards is quiet and would read as an answer: a card that
   * said "1 delegate" going back to saying nothing, three seconds later, on a
   * poll where the server reported that nothing had changed.
   */
  it('does not blank a card\u2019s delegates when the answer is unchanged', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    asMock
      .mockResolvedValueOnce({ changed: true, trees: [tree('a')], etag: '"v1"' })
      .mockResolvedValue({ changed: false })

    list()
    await waitFor(() => expect(delegateLine()).toBeTruthy())

    await vi.advanceTimersByTimeAsync(POLL_MS)
    await waitFor(() => expect(asMock).toHaveBeenCalledTimes(2))

    expect(delegateLine()?.textContent).toContain('1 delegate')
  })

  it('carries the new tag once the server says the graph changed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    asMock
      .mockResolvedValueOnce({ changed: true, trees: [tree('a')], etag: '"v1"' })
      .mockResolvedValue({ changed: true, trees: [tree('b')], etag: '"v2"' })

    list()
    await waitFor(() => expect(delegateLine()).toBeTruthy())

    await vi.advanceTimersByTimeAsync(POLL_MS)
    await waitFor(() => expect(asMock).toHaveBeenCalledTimes(2))

    await vi.advanceTimersByTimeAsync(POLL_MS)
    await waitFor(() => expect(asMock.mock.calls[2]?.[0]).toBe('"v2"'))
  })

  /*
   * A read that throws on the way in rather than rejecting used to escape the
   * promise and leave no next pass armed, so the graph froze on whatever it
   * last held with nothing saying it had stopped — an old reading that still
   * looks like an answer, which INV-5 rates worse than a blank one.
   */
  it('keeps polling after a read that throws', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    asMock.mockImplementationOnce(() => {
      throw new Error('transport gone')
    })
    asMock.mockResolvedValue({ changed: true, trees: [tree('a')], etag: '"v1"' })

    list()
    await waitFor(() => expect(asMock).toHaveBeenCalledTimes(1))

    await vi.advanceTimersByTimeAsync(POLL_MS)
    await waitFor(() => expect(delegateLine()).toBeTruthy())
  })

  // INV-4's first rule. Nothing polls what nobody is watching.
  it('stops polling once the list is gone', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    asMock.mockResolvedValue({ changed: false })

    const { unmount } = list()
    await waitFor(() => expect(asMock).toHaveBeenCalledTimes(1))

    unmount()
    await vi.advanceTimersByTimeAsync(POLL_MS * 3)
    expect(asMock).toHaveBeenCalledTimes(1)
  })
})
