/**
 * A just-spawned agent has not registered itself yet — and in a new directory
 * it stops on a trust prompt first. Without these entries it would be invisible
 * in the app, and the prompt blocking it unreachable.
 */
import { describe, expect, it } from 'vitest'
import { PendingStore } from '../src/server/pending.ts'
import type { Agent } from '../src/shared/types.ts'

const real = (over: Partial<Agent> = {}): Agent => ({
  sessionId: 'real-1',
  pid: 1,
  name: 'real',
  cwd: '/x',
  folder: 'x',
  status: 'idle',
  kind: 'interactive',
  startedAt: 0,
  ...over,
})

describe('PendingStore', () => {
  it('is empty until something is spawned', async () => {
    const store = new PendingStore()
    expect(await store.merge([])).toEqual([])
    expect(store.size).toBe(0)
  })

  // The tmux session for these tests does not exist, so merge prunes them —
  // which is itself the behaviour for a window that closed before startup.
  it('drops a session whose tmux window is gone', async () => {
    const store = new PendingStore()
    store.add({ tmuxSession: 'claude-does-not-exist', cwd: '/tmp' })
    expect(store.size).toBe(1)
    expect(await store.merge([])).toEqual([])
    expect(store.size).toBe(0)
  })

  it('drops a session once the real agent reports the same tmux session', async () => {
    const store = new PendingStore()
    store.add({ tmuxSession: 'claude-123', cwd: '/tmp' })
    const merged = await store.merge([real({ tmuxSession: 'claude-123' })])
    expect(merged).toHaveLength(1)
    expect(merged[0]?.sessionId).toBe('real-1')
    expect(store.size).toBe(0)
  })

  it('leaves unrelated agents untouched', async () => {
    const store = new PendingStore()
    const agents = [real(), real({ sessionId: 'real-2' })]
    expect(await store.merge(agents)).toEqual(agents)
  })

  it('names a session after its folder when no name was given', () => {
    const store = new PendingStore()
    store.add({ tmuxSession: 'claude-1', cwd: '/Users/me/Projects/lego-deals' })
    expect(store.size).toBe(1)
  })
})
