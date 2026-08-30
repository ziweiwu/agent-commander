/** INV-8: control actions are guarded, allow-listed, and verified. */
import { describe, expect, it, vi } from 'vitest'
import {
  assertControllable,
  assertGoalCondition,
  clearContext,
  clearGoal,
  closeAgent,
  compactContext,
  ControlError,
  GOAL_MAX_CHARS,
  cycleMode,
  setGoal,
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
  readSessionId: async () => 'session-before',
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

describe('clearContext', () => {
  /*
   * `/clear` is verified by the session id turning over, and that is the whole
   * design: it does not edit a conversation, it replaces one. Claude Code opens
   * a fresh transcript under a new id and rewrites the session record, so the
   * old transcript simply stops growing — which is also exactly what a `/clear`
   * that never arrived looks like from here.
   */
  const rotating = (after = 1) => {
    let reads = 0
    return deps({
      readSessionId: async () => {
        reads += 1
        return reads > after ? 'session-after' : 'session-before'
      },
    })
  }

  it('types /clear and reports the id the session is running now', async () => {
    const d = rotating()

    const result = await clearContext(agent(), d)

    expect(d.paste).toHaveBeenCalledExactlyOnceWith('%1', '/clear', true)
    expect(result).toMatchObject({ ok: true, sessionId: 'session-after' })
    expect(result.unobserved).toBeUndefined()
  })

  /*
   * The id never turned over inside the window. The paste went out, so this is
   * not a failure — a large conversation clears slower than anything worth
   * blocking a request on. Saying it failed asserts something nobody read, and
   * a caller that navigated on it would land on an id that may not exist.
   */
  it('reports an unobserved clear rather than a failure', async () => {
    const d = deps({ readSessionId: async () => 'session-before' })

    const result = await clearContext(agent(), d, 400)

    expect(d.paste).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ ok: true, unobserved: true })
    expect(result.sessionId).toBeUndefined()
  })

  // A session record that cannot be read is INV-5's case, not an error: the
  // clear may well have landed, and nothing here can tell.
  it('reports unobserved when the session record cannot be read', async () => {
    const d = deps({ readSessionId: async () => undefined })

    const result = await clearContext(agent(), d, 400)

    expect(result).toMatchObject({ ok: true, unobserved: true })
  })

  it('refuses a busy agent, because it types', async () => {
    const d = deps()
    await expect(clearContext(agent({ status: 'busy' }), d)).rejects.toThrow(/busy/)
    expect(d.paste).not.toHaveBeenCalled()
  })
})

describe('compactContext', () => {
  it('types /compact and does not wait for it', async () => {
    const d = deps({
      // A compaction that never finishes. Anything that verified would hang
      // here, which is the point: the real one ran for 157 seconds.
      readSessionId: async () => 'session-before',
    })

    await compactContext(agent(), d)

    expect(d.paste).toHaveBeenCalledExactlyOnceWith('%1', '/compact', true)
  })

  it('refuses a busy agent, because it types', async () => {
    const d = deps()
    await expect(compactContext(agent({ status: 'busy' }), d)).rejects.toThrow(/busy/)
    expect(d.paste).not.toHaveBeenCalled()
  })
})

describe('cycleMode', () => {
  /*
   * One press, and the reading is reported rather than chased.
   *
   * The suite this replaced tested a `setMode(target)` that pressed `BTab` up
   * to six times until the session reported the mode a `<select>` had asked
   * for. Every one of those cases was about a failure mode a target creates:
   * reaching a mode that the cycle silently omits, giving up part-way, landing
   * somewhere nobody asked for. There is no target now, so there is nothing to
   * miss — see `cycleMode` for why that was the fix rather than more polling.
   */

  it('presses Shift+Tab exactly once and reports where it landed', async () => {
    let mode = 'default'
    const d = deps({
      key: vi.fn(async () => {
        mode = 'acceptEdits'
      }),
      readMode: async () => mode,
    })

    const result = await cycleMode(agent(), d)

    expect(result).toMatchObject({ ok: true, mode: 'acceptEdits' })
    expect(result.unobserved).toBeUndefined()
    expect(d.key).toHaveBeenCalledExactlyOnceWith('%1', 'BTab')
  })

  /*
   * The mode is observed by reading a record the session writes to its own
   * transcript, and that write is not instant. A single read at a fixed delay
   * made a record that landed a few hundred ms late look like a press that had
   * done nothing. Polling makes a slow write cost latency instead of an answer.
   */
  it('waits for a session that reports the press late', async () => {
    let reads = 0
    let mode = 'default'
    const d = deps({
      key: vi.fn(async () => {
        mode = 'plan'
      }),
      readMode: async () => {
        reads += 1
        return reads <= 4 ? 'default' : mode
      },
    })

    const result = await cycleMode(agent(), d)

    expect(result).toMatchObject({ ok: true, mode: 'plan' })
    expect(d.key).toHaveBeenCalledTimes(1)
  })

  /*
   * The reading never moved. That is not a failed switch — the key reached the
   * pane — so it is reported as a success this app could not observe (INV-11),
   * and critically it does *not* press again. Pressing again is what used to
   * leave a live session in a mode nobody asked for.
   */
  it('reports an unobserved press rather than pressing again', async () => {
    const d = deps({ readMode: async () => 'auto' })

    const result = await cycleMode(agent(), d)

    expect(d.key).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ ok: true, mode: 'auto', unobserved: true })
  })

  it('reports an unobserved press when the session reports no mode at all', async () => {
    const d = deps({ readMode: async () => undefined })

    const result = await cycleMode(agent(), d)

    expect(d.key).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ ok: true, unobserved: true })
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

    const result = await cycleMode(agent({ status: 'busy' }), d)

    expect(result).toMatchObject({ ok: true, mode: 'plan' })
    expect(d.key).toHaveBeenCalledWith('%1', 'BTab')
    // And it still never types: text is what the busy refusal exists to stop.
    expect(d.paste).not.toHaveBeenCalled()
  })

  it('still refuses an agent it cannot reach', async () => {
    const noPane = agent({ status: 'busy' })
    delete (noPane as { paneId?: string }).paneId
    await expect(cycleMode(noPane, deps())).rejects.toThrow(/attachable/)
  })

  /*
   * Mode and model are the exceptions; goal and close are not. Both of those
   * submit an instruction that changes what the session does next, and one
   * arriving mid-turn acts on a state nobody chose.
   */
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
    await expect(cycleMode(kiro, d)).rejects.toBeInstanceOf(ControlError)
    expect(d.key).not.toHaveBeenCalled()
  })

  it('refuses /clear and /compact, and types nothing', async () => {
    const d = deps()
    await expect(clearContext(kiro, d)).rejects.toBeInstanceOf(ControlError)
    await expect(compactContext(kiro, d)).rejects.toBeInstanceOf(ControlError)
    expect(d.paste).not.toHaveBeenCalled()
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
