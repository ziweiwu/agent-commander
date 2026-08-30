/**
 * The tree view's polling, and what it does with an answer that has not moved.
 *
 * The server stopped re-sending an unchanged graph (`test/tree-routes.test.ts`).
 * This is the half that makes that worth anything: the browser has to send the
 * tag back, and — the part that was actually broken — it has to leave its
 * existing trees alone when the answer is 304. Calling `setTrees` with a freshly
 * parsed copy of identical data gave every `tree` prop a new identity every
 * three seconds, so the `memo` on `TreeRoot` could never hit and all of it
 * re-rendered for data nobody had changed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { TreeRoute } from '../../src/web/components/TreeRoute.tsx'
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

beforeEach(() => {
  resetStore()
  asMock.mockReset()
  useStore.setState({ agents: [agent({ sessionId: 'a', status: 'busy' })] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('INV-4 the tree view does not re-read what it already has', () => {
  it('sends no tag on the first poll and the served tag on the next', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    asMock
      .mockResolvedValueOnce({ changed: true, trees: [tree('a')], etag: '"v1"' })
      .mockResolvedValue({ changed: false })

    renderApp(<TreeRoute />)

    await waitFor(() => expect(asMock).toHaveBeenCalledTimes(1))
    expect(asMock.mock.calls[0]?.[0]).toBeNull()

    await vi.advanceTimersByTimeAsync(3_000)

    await waitFor(() => expect(asMock).toHaveBeenCalledTimes(2))
    expect(asMock.mock.calls[1]?.[0]).toBe('"v1"')
  })

  /*
   * The identity churn itself is now impossible by construction rather than by
   * assertion: a 304 comes back as `{ changed: false }`, which carries no trees
   * for `setTrees` to be handed. What is worth testing is the consequence a
   * reader would notice — an unchanged answer is not an empty one.
   *
   * Deliberately not asserted here: that no re-render happened. React reuses a
   * DOM node across re-renders whenever the element type and key match, so
   * comparing element identity would pass either way and prove nothing.
   */
  it('does not blank the graph when the answer is unchanged', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    asMock
      .mockResolvedValueOnce({ changed: true, trees: [tree('a')], etag: '"v1"' })
      .mockResolvedValue({ changed: false })

    renderApp(<TreeRoute />)
    await screen.findByTestId('tree-root')

    await vi.advanceTimersByTimeAsync(3_000)
    await waitFor(() => expect(asMock).toHaveBeenCalledTimes(2))

    // `getByTestId` throws when absent, so these are the assertion.
    expect(screen.getByTestId('tree-node')).toBeTruthy()
    expect(screen.getByText('Explore')).toBeTruthy()
  })

  it('replaces the graph when the server says it changed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    asMock
      .mockResolvedValueOnce({ changed: true, trees: [tree('a')], etag: '"v1"' })
      .mockResolvedValue({ changed: true, trees: [tree('b')], etag: '"v2"' })

    renderApp(<TreeRoute />)
    await screen.findByTestId('tree-root')

    await vi.advanceTimersByTimeAsync(3_000)

    await waitFor(() => expect(asMock).toHaveBeenCalledTimes(2))
    // The new tag is what the poll after that carries.
    await vi.advanceTimersByTimeAsync(3_000)
    await waitFor(() => expect(asMock.mock.calls[2]?.[0]).toBe('"v2"'))
  })
})
