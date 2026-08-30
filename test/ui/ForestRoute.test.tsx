/**
 * The forest's polling, and what it does with an answer that has not moved.
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
import { ForestRoute } from '../../src/web/components/ForestRoute.tsx'
import { fetchTree } from '../../src/web/store/transport.ts'
import { agent, renderApp, resetStore } from './helpers.tsx'
import { useStore } from '../../src/web/store/store.ts'
import type { AgentTree } from '../../src/shared/types.ts'

vi.mock('../../src/web/store/transport.ts', () => ({ fetchTree: vi.fn() }))

const asMock = vi.mocked(fetchTree)

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

/** The delegate's lane, distinguishable from the session's own at depth 0. */
const delegateLane = () => document.querySelector('[data-testid="forest-lane"][data-depth="1"]')

beforeEach(() => {
  resetStore()
  asMock.mockReset()
  useStore.setState({ agents: [agent({ sessionId: 'a', status: 'busy' })] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('INV-4 the forest does not re-read what it already has', () => {
  it('sends no tag on the first poll and the served tag on the next', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    asMock
      .mockResolvedValueOnce({ changed: true, trees: [tree('a')], etag: '"v1"' })
      .mockResolvedValue({ changed: false })

    renderApp(<ForestRoute />)

    await waitFor(() => expect(asMock).toHaveBeenCalledTimes(1))
    expect(asMock.mock.calls[0]?.[0]).toBeNull()

    await vi.advanceTimersByTimeAsync(3_000)

    await waitFor(() => expect(asMock).toHaveBeenCalledTimes(2))
    expect(asMock.mock.calls[1]?.[0]).toBe('"v1"')
  })

  it('does not blank the graph when the answer is unchanged', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    asMock
      .mockResolvedValueOnce({ changed: true, trees: [tree('a')], etag: '"v1"' })
      .mockResolvedValue({ changed: false })

    renderApp(<ForestRoute />)
    await waitFor(() => expect(delegateLane()).toBeTruthy())

    await vi.advanceTimersByTimeAsync(3_000)
    await waitFor(() => expect(asMock).toHaveBeenCalledTimes(2))

    // `getByText` throws when absent, so these are the assertion.
    expect(delegateLane()).toBeTruthy()
    expect(screen.getByText('Explore')).toBeTruthy()
  })

  it('replaces the graph when the server says it changed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    asMock
      .mockResolvedValueOnce({ changed: true, trees: [tree('a')], etag: '"v1"' })
      .mockResolvedValue({ changed: true, trees: [tree('b')], etag: '"v2"' })

    renderApp(<ForestRoute />)
    await waitFor(() => expect(delegateLane()).toBeTruthy())

    await vi.advanceTimersByTimeAsync(3_000)

    await waitFor(() => expect(asMock).toHaveBeenCalledTimes(2))
    // The new tag is what the poll after that carries.
    await vi.advanceTimersByTimeAsync(3_000)
    await waitFor(() => expect(asMock.mock.calls[2]?.[0]).toBe('"v2"'))
  })
})
