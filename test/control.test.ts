/** INV-8: control actions are guarded, allow-listed, and verified. */
import { describe, expect, it, vi } from 'vitest'
import {
  assertControllable,
  assertGoalCondition,
  clearGoal,
  closeAgent,
  ControlError,
  GOAL_MAX_CHARS,
  setGoal,
  setMode,
  setModel,
  type ControlDeps,
} from '../src/server/control.ts'
import type { Agent } from '../src/shared/types.ts'

const agent = (over: Partial<Agent> = {}): Agent => ({
  sessionId: 'a',
  pid: 1,
  name: 'agent',
  cwd: '/x',
  folder: 'x',
  status: 'idle',
  kind: 'interactive',
  startedAt: 0,
  paneId: '%1',
  tmuxSession: 'claude-1',
  ...over,
})

const deps = (over: Partial<ControlDeps> = {}): ControlDeps => ({
  paste: vi.fn(async () => {}),
  key: vi.fn(async () => {}),
  readMode: async () => 'default',
  readGoal: async () => undefined,
  paneAlive: async () => false,
  killSession: vi.fn(async () => {}),
  wait: async () => {},
  ...over,
})

describe('assertControllable', () => {
  it('accepts an idle agent', () => {
    expect(() => assertControllable(agent())).not.toThrow()
  })

  // A waiting agent is precisely the one you may want to redirect.
  it('accepts a waiting agent', () => {
    expect(() => assertControllable(agent({ status: 'waiting' }))).not.toThrow()
  })

  it('refuses a busy agent, whose prompt is mid-turn', () => {
    expect(() => assertControllable(agent({ status: 'busy' }))).toThrow(/busy/)
  })

  it('refuses an agent with no pane, and says why', () => {
    expect(() =>
      assertControllable(agent({ paneId: undefined, attachBlockedReason: 'not in tmux' })),
    ).toThrow(/not in tmux/)
  })

  it('refuses a vanished agent', () => {
    expect(() => assertControllable(undefined)).toThrow(ControlError)
  })
})

describe('setModel', () => {
  it('types the CLI’s own /model command', async () => {
    const d = deps()
    await setModel(agent(), 'opus', d)
    expect(d.paste).toHaveBeenCalledWith('%1', '/model opus', true)
  })

  it('refuses an alias that is not on the allow-list', async () => {
    const d = deps()
    await expect(setModel(agent(), 'gpt-9', d)).rejects.toThrow(/unknown model/)
    expect(d.paste).not.toHaveBeenCalled()
  })

  it('refuses a busy agent before typing anything', async () => {
    const d = deps()
    await expect(setModel(agent({ status: 'busy' }), 'opus', d)).rejects.toThrow(/busy/)
    expect(d.paste).not.toHaveBeenCalled()
  })
})

describe('setMode', () => {
  /** A fake session that cycles through the modes it actually supports. */
  const cycling = (cycle: string[], start = 0) => {
    let index = start
    return {
      deps: deps({
        key: vi.fn(async () => {
          index = (index + 1) % cycle.length
        }),
        readMode: async () => cycle[index],
      }),
      at: () => cycle[index],
    }
  }

  it('does nothing when already in the target mode', async () => {
    const d = deps({ readMode: async () => 'plan' })
    const result = await setMode(agent(), 'plan', d)
    expect(result).toMatchObject({ ok: true, steps: 0 })
    expect(d.key).not.toHaveBeenCalled()
  })

  it('cycles until the session reports the target', async () => {
    const c = cycling(['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto'])
    const result = await setMode(agent(), 'plan', c.deps)
    expect(result.ok).toBe(true)
    expect(result.steps).toBe(2)
    expect(c.at()).toBe('plan')
  })

  // The cycle omits bypassPermissions and auto when unavailable, which is why
  // this is verified rather than counted.
  it('still lands correctly on a session with a shortened cycle', async () => {
    const c = cycling(['default', 'acceptEdits', 'plan'])
    const result = await setMode(agent(), 'plan', c.deps)
    expect(result.ok).toBe(true)
    expect(c.at()).toBe('plan')
  })

  it('gives up and reports where it ended rather than cycling forever', async () => {
    const c = cycling(['default', 'acceptEdits', 'plan'])
    const result = await setMode(agent(), 'bypassPermissions', c.deps, 4)
    expect(result.ok).toBe(false)
    expect(result.steps).toBe(4)
    expect(result.mode).toBeDefined()
  })

  it('refuses a mode that is not in the cycle', async () => {
    await expect(setMode(agent(), 'turbo', deps())).rejects.toThrow(/unknown permission mode/)
  })

  it('refuses a busy agent', async () => {
    await expect(setMode(agent({ status: 'busy' }), 'plan', deps())).rejects.toThrow(/busy/)
  })
})

describe('closeAgent', () => {
  it('asks the session to exit and stops there when it does', async () => {
    const d = deps({ paneAlive: async () => false })
    const result = await closeAgent(agent(), d)
    expect(d.paste).toHaveBeenCalledWith('%1', '/exit', true)
    expect(result).toEqual({ closed: true, forced: false })
    expect(d.killSession).not.toHaveBeenCalled()
  })

  it('forces a session that ignores /exit', async () => {
    const d = deps({ paneAlive: async () => true })
    const result = await closeAgent(agent(), d)
    expect(result).toEqual({ closed: true, forced: true })
    expect(d.killSession).toHaveBeenCalledWith('claude-1')
  })

  it('reports rather than hanging when there is nothing left to kill', async () => {
    const d = deps({ paneAlive: async () => true })
    await expect(closeAgent(agent({ tmuxSession: undefined }), d)).rejects.toThrow(/ignored \/exit/)
  })

  it('refuses a busy agent', async () => {
    const d = deps()
    await expect(closeAgent(agent({ status: 'busy' }), d)).rejects.toThrow(/busy/)
    expect(d.paste).not.toHaveBeenCalled()
  })
})

describe('setGoal', () => {
  const record = { condition: 'the tests pass', met: false, at: 1000, fresh: true }

  /**
   * A pane that starts with `before` and only reports `after` once something
   * has actually been typed into it — which is the whole question setGoal
   * exists to answer.
   */
  const pane = (
    before: Awaited<ReturnType<ControlDeps['readGoal']>>,
    after: Awaited<ReturnType<ControlDeps['readGoal']>>,
  ): ControlDeps => {
    let typed = false
    return deps({
      paste: vi.fn(async () => {
        typed = true
      }),
      readGoal: async () => (typed ? after : before),
    })
  }

  it("types the CLI's own /goal command", async () => {
    const d = pane(undefined, record)
    await setGoal(agent(), 'the tests pass', d)
    expect(d.paste).toHaveBeenCalledWith('%1', '/goal the tests pass', true)
  })

  // INV-8: a goal is typed into the prompt like everything else here.
  it('refuses a busy agent', async () => {
    await expect(setGoal(agent({ status: 'busy' }), 'x', deps())).rejects.toThrow(/busy/)
  })

  it('confirms only once the session has written the goal down', async () => {
    await expect(setGoal(agent(), 'the tests pass', pane(undefined, record))).resolves.toMatchObject(
      { ok: true },
    )
  })

  /*
   * The condition Claude Code stores is canonicalised, so verification asks
   * "is there a newer record?" rather than "does the text match?". A run that
   * compared text would report a perfectly good goal as failed.
   */
  it('accepts a record whose text was rewritten', async () => {
    const stale = { condition: 'something older', met: false, at: 10 }
    const rewritten = { condition: 'The tests pass.', met: false, at: 1000, fresh: true }
    await expect(setGoal(agent(), 'the tests pass', pane(stale, rewritten))).resolves.toMatchObject({
      ok: true,
    })
  })

  it('reports failure when nothing is ever recorded', async () => {
    await expect(setGoal(agent(), 'the tests pass', pane(undefined, undefined), 500)).resolves.toMatchObject({
      ok: false,
    })
  })

  /*
   * The paste went nowhere — into a dialog, or a session that was not at its
   * prompt — and the goal already on the session is unchanged. Reading it back
   * must not be mistaken for the new goal landing.
   */
  it('does not mistake the previous goal for the new one', async () => {
    const stale = { condition: 'something older', met: false, at: 10 }
    await expect(setGoal(agent(), 'the tests pass', pane(stale, stale), 500)).resolves.toMatchObject(
      { ok: false },
    )
  })

  /*
   * A goal already running gets evaluated every time the session would stop.
   * One of those landing while we waited says nothing about whether the goal
   * we typed was accepted — only the set-record does.
   */
  it('does not accept an evaluation of the old goal as proof', async () => {
    const stale = { condition: 'something older', met: false, at: 10, fresh: true }
    const evaluated = { condition: 'something older', met: false, at: 2000, reason: 'Not yet.' }
    await expect(
      setGoal(agent(), 'the tests pass', pane(stale, evaluated), 500),
    ).resolves.toMatchObject({ ok: false })
  })

  it('clears with /goal clear', async () => {
    const d = deps()
    await clearGoal(agent(), d)
    expect(d.paste).toHaveBeenCalledWith('%1', '/goal clear', true)
  })
})

describe('assertGoalCondition', () => {
  it('trims and returns the condition', () => {
    expect(assertGoalCondition('  ship it  ')).toBe('ship it')
  })

  it('refuses an empty condition', () => {
    expect(() => assertGoalCondition('   ')).toThrow(ControlError)
  })

  /*
   * The one that matters: this text is pasted into a prompt and submitted, so
   * an embedded newline would submit early and send the rest as a second,
   * unreviewed instruction to a live agent.
   */
  it('refuses an embedded newline', () => {
    expect(() => assertGoalCondition('tests pass\nrm -rf /')).toThrow(/single line/)
  })

  it('refuses other control characters', () => {
    expect(() => assertGoalCondition('tests\u0007pass')).toThrow(/single line/)
  })

  it('refuses a condition that is itself a command', () => {
    expect(() => assertGoalCondition('/exit')).toThrow(/cannot start with/)
  })

  it('refuses a condition longer than the cap', () => {
    expect(() => assertGoalCondition('x'.repeat(GOAL_MAX_CHARS + 1))).toThrow(/characters or fewer/)
  })
})
