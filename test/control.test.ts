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
  agentKind: 'claude',
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

  /*
   * Allowed mid-turn, and the reason is consistency rather than safety: this
   * pastes through the same primitive the message composer uses, and that has
   * never had a busy guard — sending "use opus instead" as a chat message to a
   * working agent is a designed feature. Refusing `/model opus` forbade through
   * one door exactly what the app permits through the other.
   */
  it('switches a busy agent, and says the change is queued', async () => {
    const d = deps()
    const result = await setModel(agent({ status: 'busy' }), 'opus', d)
    expect(result).toEqual({ queued: true })
    expect(d.paste).toHaveBeenCalledWith('%1', '/model opus', true)
  })

  it('is not queued for an idle agent', async () => {
    const result = await setModel(agent(), 'opus', deps())
    expect(result).toEqual({ queued: false })
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

  /*
   * INV-8's one exception. Mode sends `BTab`, a control key the agent handles
   * wherever it is, rather than typing into its prompt — so unlike every other
   * control action it is allowed mid-run. That is the only time it matters:
   * deciding the next step needs plan mode happens while the agent is working.
   */
  it('switches a busy agent, because it sends a key rather than typing', async () => {
    let mode = 'default'
    const d = deps({
      key: vi.fn(async () => {
        mode = 'plan'
      }),
      readMode: async () => mode,
    })
    const result = await setMode(agent({ status: 'busy' }), 'plan', d)
    expect(result).toMatchObject({ ok: true, mode: 'plan' })
    expect(d.key).toHaveBeenCalledWith('%1', 'BTab')
    // And it still never types: text is what the busy refusal exists to stop.
    expect(d.paste).not.toHaveBeenCalled()
  })

  it('still refuses an agent it cannot reach', async () => {
    const noPane = agent({ status: 'busy' })
    delete (noPane as { paneId?: string }).paneId
    await expect(setMode(noPane, 'plan', deps())).rejects.toThrow(/attachable/)
  })

  /*
   * Mode and model are the exceptions; goal and close are not. Both of those
   * submit an instruction that changes what the session does next, and one
   * arriving mid-turn acts on a state nobody chose.
   */
  /*
   * The bug this guards, and it was doing real damage: `setMode` verifies by
   * re-reading the mode after each press, so when that reading cannot move it
   * pressed again — six Shift+Tabs into a live session, leaving it wherever
   * that landed and then reporting "could not reach plan" for the privilege.
   *
   * Two real causes, neither helped by pressing again: a session that reports
   * no permission mode at all (there is one in this user's own fleet), and a
   * busy agent that has not yet written the record where this app can read it.
   */
  /*
   * The flakiness this replaced.
   *
   * The mode is observed by reading a record the session writes to its own
   * transcript, and that write is not instant. With a single read at a fixed
   * 250ms, a record that landed at 400ms looked like a press that had done
   * nothing: the loop stopped, correctly refusing to press blind, and left the
   * session one step from where it started rather than at the target. Whether
   * the switch worked came down to whether the write beat the timer.
   *
   * Polling makes a slow write cost latency instead of an answer.
   */
  it('reaches the target when the session reports the press late', async () => {
    let reads = 0
    const d = deps({
      // Reports the old mode for the first few looks, then the new one — the
      // shape of a transcript record that lands a few hundred ms after the key.
      readMode: async () => {
        reads += 1
        return reads <= 4 ? 'default' : 'plan'
      },
    })

    const result = await setMode(agent(), 'plan', d)

    expect(result).toMatchObject({ ok: true, mode: 'plan' })
    // One press, not a second one fired because the first looked ignored.
    expect(d.key).toHaveBeenCalledTimes(1)
  })

  it('presses once, not six times, when the mode never changes', async () => {
    const d = deps({ readMode: async () => 'auto' })
    const result = await setMode(agent(), 'plan', d)

    expect(d.key).toHaveBeenCalledTimes(1)
    expect(result.unobserved).toBe(true)
    expect(result.ok).toBe(false)
  })

  it('presses once when the session reports no mode at all', async () => {
    const d = deps({ readMode: async () => undefined })
    const result = await setMode(agent(), 'plan', d)

    expect(d.key).toHaveBeenCalledTimes(1)
    expect(result.unobserved).toBe(true)
  })

  // A reading that is moving is still being followed, up to the bound.
  it('keeps cycling while the mode is actually changing', async () => {
    const seen = ['acceptEdits', 'plan']
    let at = 0
    const d = deps({ readMode: async () => (at === 0 ? 'default' : seen[at - 1]) })
    const key = vi.fn(async () => {
      at += 1
    })
    const result = await setMode(agent(), 'plan', { ...d, key })

    expect(result).toMatchObject({ ok: true, mode: 'plan' })
    expect(key).toHaveBeenCalledTimes(2)
  })

  it('leaves the busy refusal on goal and close', async () => {
    const busy = agent({ status: 'busy' })
    await expect(setGoal(busy, 'the tests pass', deps())).rejects.toThrow(/busy/)
    await expect(clearGoal(busy, deps())).rejects.toThrow(/busy/)
    await expect(closeAgent(busy, deps())).rejects.toThrow(/busy/)
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

/**
 * A Claude Code slash command is not a feature that degrades on another CLI.
 *
 * Every one of these works by typing `/model`, `/goal` or `/exit` into a live
 * pane and pressing return. Against Kiro that is not a disabled control — it is
 * this app typing a sentence of its own into somebody's prompt. The browser
 * hides the controls; this is the boundary that makes it true, because a UI is
 * not one (INV-6).
 */
describe('INV-7 refuses Claude commands for other agent CLIs', () => {
  const kiro = agent({ agentKind: 'kiro', sessionId: 'tmux:kiro-1', tmuxSession: 'kiro-1' })

  it('refuses /model, and types nothing', async () => {
    const d = deps()
    await expect(setModel(kiro, 'opus', d)).rejects.toBeInstanceOf(ControlError)
    expect(d.paste).not.toHaveBeenCalled()
  })

  it('refuses the permission-mode cycle', async () => {
    const d = deps()
    await expect(setMode(kiro, 'plan', d)).rejects.toBeInstanceOf(ControlError)
    expect(d.key).not.toHaveBeenCalled()
  })

  it('refuses /goal, set and cleared', async () => {
    const d = deps()
    await expect(setGoal(kiro, 'the tests pass', d)).rejects.toBeInstanceOf(ControlError)
    await expect(clearGoal(kiro, d)).rejects.toBeInstanceOf(ControlError)
    expect(d.paste).not.toHaveBeenCalled()
  })

  it('still allows all of them for Claude', async () => {
    const d = deps()
    await setModel(agent(), 'opus', d)
    expect(d.paste).toHaveBeenCalledWith('%1', '/model opus', true)
  })

  /*
   * Close is the exception, because tmux can do it without the agent's help.
   * Typing `/exit` first would leave a stray line in the prompt of a session
   * the user asked to close, then force-kill it six seconds later anyway.
   */
  it('closes by killing the tmux session rather than typing /exit', async () => {
    const d = deps()
    const result = await closeAgent(kiro, d)
    expect(d.paste).not.toHaveBeenCalled()
    expect(d.killSession).toHaveBeenCalledWith('kiro-1')
    expect(result).toEqual({ closed: true, forced: true })
  })
})
