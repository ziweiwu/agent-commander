/**
 * A just-spawned agent has not registered itself yet — and in a new directory
 * it stops on a trust prompt first. Without these entries it would be invisible
 * in the app, and the prompt blocking it unreachable.
 */
import { describe, expect, it, vi } from 'vitest'
import { PendingStore, type PendingDeps } from '../src/server/pending.ts'
import { isMissingTarget } from '../src/server/pane.ts'
import type { Agent } from '../src/shared/types.ts'

/** A tmux that answers however the test needs, without a tmux server. */
const deps = (listPanes: PendingDeps['listPanes']): PendingDeps => ({
  listPanes,
  isMissingTarget,
})

const errWith = (message: string, code?: string): Error => {
  const err = new Error(message)
  if (code) (err as NodeJS.ErrnoException).code = code
  return err
}

const real = (over: Partial<Agent> = {}): Agent => ({
  sessionId: 'real-1',
  pid: 1,
  name: 'real',
  cwd: '/x',
  folder: 'x',
  status: 'idle',
  agentKind: 'claude',
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

/**
 * INV-5: "a failure to read a pane and a pane that has ended are not the same
 * thing."
 *
 * This store used to spawn its own `tmux` and resolve null on any error, then
 * read null as "the window closed before the agent ever came up" and delete the
 * entry. `spawn tmux EAGAIN` is such an error, and `pane.ts` documents it as
 * ordinary on a machine at its process cap — which is exactly a machine where a
 * new agent takes a while to start. So the agent most in need of being visible,
 * one stuck on a trust prompt, was the one that disappeared.
 */
describe('INV-5 a tmux that could not answer is not a session that has gone', () => {
  it('keeps a pending session when the spawn was refused for want of a slot', async () => {
    const store = new PendingStore(
      deps(async () => {
        throw errWith('spawn tmux EAGAIN', 'EAGAIN')
      }),
    )
    store.add({ tmuxSession: 'claude-1', cwd: '/tmp' })

    // Not listed this pass — there is no pane id to attach to — but not
    // forgotten either: the next pass can still find it.
    expect(await store.merge([])).toEqual([])
    expect(store.size).toBe(1)
  })

  it('shows it as soon as tmux can answer again', async () => {
    let refuse = true
    const store = new PendingStore(
      deps(async () => {
        if (refuse) throw errWith('spawn tmux EAGAIN', 'EAGAIN')
        return ['%42']
      }),
    )
    store.add({ tmuxSession: 'claude-1', cwd: '/tmp/lego' })

    await store.merge([])
    refuse = false
    const merged = await store.merge([])

    expect(merged).toHaveLength(1)
    expect(merged[0]?.paneId).toBe('%42')
    expect(merged[0]?.sessionId).toBe('pending:claude-1')
  })

  it('keeps it for any other failure to ask, too', async () => {
    const store = new PendingStore(
      deps(async () => {
        throw errWith('control client timed out')
      }),
    )
    store.add({ tmuxSession: 'claude-1', cwd: '/tmp' })
    await store.merge([])
    expect(store.size).toBe(1)
  })

  it('drops it when tmux positively says the session is not there', async () => {
    const store = new PendingStore(
      deps(async () => {
        throw errWith("can't find session: claude-1")
      }),
    )
    store.add({ tmuxSession: 'claude-1', cwd: '/tmp' })
    await store.merge([])
    expect(store.size).toBe(0)
  })

  it('drops it when tmux answers with no panes at all', async () => {
    const store = new PendingStore(deps(async () => []))
    store.add({ tmuxSession: 'claude-1', cwd: '/tmp' })
    await store.merge([])
    expect(store.size).toBe(0)
  })

  it('still gives up eventually rather than holding a ghost for ever', async () => {
    // Keeping an entry through a failure is only safe because something else
    // ends it. A tmux that never answers again must not leave a phantom agent
    // in the fleet for the life of the process.
    vi.useFakeTimers()
    try {
      const store = new PendingStore(
        deps(async () => {
          throw errWith('spawn tmux EAGAIN', 'EAGAIN')
        }),
      )
      store.add({ tmuxSession: 'claude-1', cwd: '/tmp' })
      await store.merge([])
      expect(store.size).toBe(1)

      vi.setSystemTime(Date.now() + 6 * 60_000)
      await store.merge([])
      expect(store.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('isMissingTarget', () => {
  it('reads tmux own wording for a target that does not exist', () => {
    expect(isMissingTarget(errWith("can't find session: claude-1"))).toBe(true)
    expect(isMissingTarget(errWith('session not found: claude-1'))).toBe(true)
    expect(isMissingTarget(errWith('no server running on /tmp/tmux-501/default'))).toBe(true)
  })

  it('treats a missing tmux binary as nothing to find', () => {
    expect(isMissingTarget(errWith('spawn tmux ENOENT', 'ENOENT'))).toBe(true)
  })

  it('never reads a refused spawn as an answer', () => {
    // The one that mattered: the process never started, so nothing was said.
    expect(isMissingTarget(errWith('spawn tmux EAGAIN', 'EAGAIN'))).toBe(false)
    expect(isMissingTarget(errWith('timed out'))).toBe(false)
    expect(isMissingTarget(errWith(''))).toBe(false)
  })
})
