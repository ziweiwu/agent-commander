/**
 * INV-2, on the way out: the text that reaches an agent is the text that was
 * typed for it.
 *
 * `paste` is two tmux invocations with an await between them — load a buffer,
 * then paste that buffer into a pane — and nothing serialises the WebSocket
 * messages that drive it. With one shared buffer name, two overlapping pastes
 * interleaved as load(A) → load(B) → paste(into A) and put B's text into A's
 * agent. Two tabs on two agents is the ordinary way to use this app, and the
 * Attach view sends one paste per keystroke, so the overlap is the common case
 * rather than a rare one.
 *
 * tmux is mocked here rather than driven: INV-1 forbids this suite from
 * creating a session, and the property under test is about ordering, which a
 * recorded argv shows exactly.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface Call {
  args: string[]
  stdin?: string
}

const calls: Call[] = []
/** Per-command latency, so an interleaving is forced rather than hoped for. */
let delayFor: (args: string[]) => number = () => 0
/** Which commands tmux should refuse, for the failure paths. */
let failFor: (args: string[]) => boolean = () => false

vi.mock('node:child_process', () => ({
  execFile: (
    _bin: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    const call: Call = { args }
    calls.push(call)
    setTimeout(
      () => (failFor(args) ? cb(new Error('tmux said no'), '', 'no such pane') : cb(null, '', '')),
      delayFor(args),
    )
    return { stdin: { end: (text: string) => (call.stdin = text) } }
  },
}))

const { paste, key } = await import('../src/server/pane.ts')

/** What each buffer was loaded with, so a paste can be traced to its text. */
function bufferContents(): Map<string, string> {
  const out = new Map<string, string>()
  for (const call of calls) {
    if (call.args[0] === 'load-buffer') out.set(call.args[2] as string, call.stdin ?? '')
  }
  return out
}

/** The text each pane actually received, in the order it received it. */
function deliveredTo(paneId: string): string[] {
  const loaded = bufferContents()
  return calls
    .filter((c) => c.args[0] === 'paste-buffer' && c.args.includes(paneId))
    .map((c) => loaded.get(c.args[c.args.indexOf('-b') + 1] as string) ?? '<unknown buffer>')
}

beforeEach(() => {
  calls.length = 0
  delayFor = () => 0
  failFor = () => false
})

describe('overlapping pastes to different agents', () => {
  it('never delivers one agent the text meant for another', async () => {
    // The first load is slow, so the second overtakes it — exactly the window
    // in which a single shared buffer name was overwritten before its paste.
    delayFor = (args) => (args[0] === 'load-buffer' && calls.length === 1 ? 20 : 0)

    await Promise.all([
      paste('%76', 'deploy to staging', true),
      paste('%77', 'rm -rf the wrong thing', true),
    ])

    expect(deliveredTo('%76')).toEqual(['deploy to staging'])
    expect(deliveredTo('%77')).toEqual(['rm -rf the wrong thing'])
  })

  it('gives every paste a buffer of its own', async () => {
    await Promise.all([paste('%76', 'one', false), paste('%77', 'two', false)])
    const names = calls.filter((c) => c.args[0] === 'load-buffer').map((c) => c.args[2])
    expect(new Set(names).size).toBe(2)
  })

  it('deletes a buffer whose paste failed, rather than leaking it', async () => {
    // Per-call buffer names are not overwritten by the next paste the way one
    // shared name was, so a load whose paste never happened would sit in the
    // tmux server for as long as it runs.
    failFor = (args) => args[0] === 'paste-buffer'

    await expect(paste('%76', 'text', false)).rejects.toThrow(/no such pane/)

    const loaded = calls.find((c) => c.args[0] === 'load-buffer')?.args[2]
    const deleted = calls.find((c) => c.args[0] === 'delete-buffer')?.args[2]
    expect(deleted).toBe(loaded)
  })
})

describe('writes to one agent stay in order', () => {
  it('does not let a later keystroke overtake an earlier one', async () => {
    // Descending latency: without a queue the last call would land first.
    let n = 0
    delayFor = () => {
      n += 1
      return Math.max(0, 30 - n * 10)
    }

    await Promise.all([
      paste('%76', 'first', false),
      paste('%76', 'second', false),
      paste('%76', 'third', false),
    ])

    expect(deliveredTo('%76')).toEqual(['first', 'second', 'third'])
  })

  /*
   * The submit case: `sendText` then `sendKey('Enter')` are two messages, and
   * an Enter that overtakes its text submits an empty prompt and then leaves
   * the text sitting unsent in the composer.
   */
  it('does not let Enter overtake the text it submits', async () => {
    delayFor = (args) => (args[0] === 'load-buffer' ? 20 : 0)

    await Promise.all([paste('%76', 'the instruction', false), key('%76', 'Enter')])

    const order = calls.filter((c) => c.args.includes('%76')).map((c) => c.args[0])
    expect(order).toEqual(['paste-buffer', 'send-keys'])
  })

  it('lets the next write run after one fails', async () => {
    // A rejected write must not poison the pane's queue for everything behind it.
    failFor = (args) => args[0] === 'send-keys'
    const rejected = key('%76', 'Enter')
    const after = paste('%76', 'still works', false)

    await expect(rejected).rejects.toThrow(/no such pane/)
    await expect(after).resolves.toBeUndefined()
    expect(deliveredTo('%76')).toEqual(['still works'])
  })
})
