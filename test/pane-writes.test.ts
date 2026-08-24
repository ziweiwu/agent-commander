/**
 * INV-2, on the way out: the text that reaches an agent is the text that was
 * typed for it.
 *
 * A paste is a `load-buffer` and a `paste-buffer`. They are now issued as one
 * tmux command sequence rather than two invocations with an await between
 * them, because the cost of a tmux command is almost entirely the cost of
 * reaching tmux — but batching them does not make the ordering properties
 * below free, and this file is what says so.
 *
 * With one shared buffer name, two overlapping pastes interleaved as load(A) →
 * load(B) → paste(into A) and put B's text into A's agent. Two tabs on two
 * agents is the ordinary way to use this app, so the overlap is the common
 * case rather than a rare one.
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
/**
 * Which invocations should fail the way a machine out of process slots does.
 *
 * EAGAIN arrives as an `error` event rather than through the callback, which
 * is why the fake child has to emit one — and why `runOnce` listens for it.
 */
let eagainFor: (args: string[], attempt: number) => boolean = () => false
const attempts = new Map<string, number>()

vi.mock('node:child_process', () => ({
  execFile: (
    _bin: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    const call: Call = { args }
    const key = args.join(' ')
    const attempt = attempts.get(key) ?? 0
    attempts.set(key, attempt + 1)
    const handlers = new Map<string, (err: Error) => void>()
    if (eagainFor(args, attempt)) {
      // A spawn refused for want of a process slot never started tmux, so it
      // ran no commands. Recording it would credit the retry with delivering
      // the text twice, which is the opposite of what is being tested.
      setTimeout(() => {
        const err = new Error('spawn tmux EAGAIN') as NodeJS.ErrnoException
        err.code = 'EAGAIN'
        handlers.get('error')?.(err)
      }, delayFor(args))
    } else {
      calls.push(call)
      setTimeout(
        () => (failFor(args) ? cb(new Error('tmux said no'), '', 'no such pane') : cb(null, '', '')),
        delayFor(args),
      )
    }
    return {
      stdin: { end: (text: string) => (call.stdin = text) },
      on: (event: string, fn: (err: Error) => void) => handlers.set(event, fn),
    }
  },
}))

const { paste, key } = await import('../src/server/pane.ts')

/**
 * The individual tmux commands an invocation carried.
 *
 * One invocation is now a command *sequence* joined by `;`, so a test that
 * looks only at `args[0]` would see a paste-buffer that is plainly there and
 * report it missing.
 */
function commandsIn(args: string[]): string[][] {
  const out: string[][] = [[]]
  for (const arg of args) {
    if (arg === ';') out.push([])
    else (out[out.length - 1] as string[]).push(arg)
  }
  return out.filter((cmd) => cmd.length > 0)
}

/** Every tmux command run, across every invocation, in order. */
function allCommands(): string[][] {
  return calls.flatMap((c) => commandsIn(c.args))
}

/** What each buffer was loaded with, so a paste can be traced to its text. */
function bufferContents(): Map<string, string> {
  const out = new Map<string, string>()
  for (const call of calls) {
    for (const cmd of commandsIn(call.args)) {
      if (cmd[0] === 'load-buffer') out.set(cmd[2] as string, call.stdin ?? '')
    }
  }
  return out
}

/** The text each pane actually received, in the order it received it. */
function deliveredTo(paneId: string): string[] {
  const loaded = bufferContents()
  return allCommands()
    .filter((cmd) => cmd[0] === 'paste-buffer' && cmd.includes(paneId))
    .map((cmd) => loaded.get(cmd[cmd.indexOf('-b') + 1] as string) ?? '<unknown buffer>')
}

beforeEach(() => {
  calls.length = 0
  attempts.clear()
  delayFor = () => 0
  failFor = () => false
  eagainFor = () => false
})

describe('one round trip per write', () => {
  /*
   * The reason the batching exists: `display-message -p ok` measured p50
   * 72.8ms against a bare fork+exec at 3.0ms, so what a write costs is how
   * many times it reaches tmux, not what it asks for.
   */
  it('loads and pastes a buffer in a single tmux invocation', async () => {
    await paste('%76', 'hello', false)
    expect(calls).toHaveLength(1)
    expect(commandsIn(calls[0]?.args ?? []).map((c) => c[0])).toEqual([
      'load-buffer',
      'paste-buffer',
    ])
  })

  it('submits in that same invocation rather than a second one', async () => {
    await paste('%76', 'hello', true)
    expect(calls).toHaveLength(1)
    expect(commandsIn(calls[0]?.args ?? []).map((c) => c[0])).toEqual([
      'load-buffer',
      'paste-buffer',
      'send-keys',
    ])
  })
})

describe('overlapping pastes to different agents', () => {
  it('never delivers one agent the text meant for another', async () => {
    // The first invocation is slow, so the second overtakes it — exactly the
    // window in which a single shared buffer name was overwritten before its
    // paste. Sequencing the two commands together narrows that window; it does
    // not close it, because the two *sequences* still interleave at the server.
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
    const names = allCommands()
      .filter((cmd) => cmd[0] === 'load-buffer')
      .map((cmd) => cmd[2])
    expect(new Set(names).size).toBe(2)
  })

  it('deletes a buffer whose paste failed, rather than leaking it', async () => {
    // Per-call buffer names are not overwritten by the next paste the way one
    // shared name was, so a load whose paste never happened would sit in the
    // tmux server for as long as it runs. Batching makes this more important,
    // not less: a sequence that fails part-way has already loaded its buffer.
    failFor = (args) => args.includes('paste-buffer')

    await expect(paste('%76', 'text', false)).rejects.toThrow(/no such pane/)

    const loaded = allCommands().find((cmd) => cmd[0] === 'load-buffer')?.[2]
    const deleted = allCommands().find((cmd) => cmd[0] === 'delete-buffer')?.[2]
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

    const order = allCommands()
      .filter((cmd) => cmd.includes('%76'))
      .map((cmd) => cmd[0])
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

describe('a machine out of process slots', () => {
  /*
   * Not hypothetical: measured on a machine sitting at 2840 processes against
   * a `kern.maxprocperuid` of 2666 — 109 tmux panes and 33 Claude sessions
   * will do it — `spawn tmux` returned EAGAIN twice during one benchmark run.
   * Before the retry, that dropped the character the user had just typed and
   * reported it as a toast, which is the one thing INV-2 cares about.
   */
  it('retries a spawn refused for want of a process slot', async () => {
    eagainFor = (args, attempt) => args[0] === 'load-buffer' && attempt === 0

    await expect(paste('%76', 'not lost', false)).resolves.toBeUndefined()
    expect(deliveredTo('%76')).toEqual(['not lost'])
  })

  it('gives up rather than retrying for ever', async () => {
    eagainFor = (args) => args[0] === 'load-buffer'
    await expect(paste('%76', 'doomed', false)).rejects.toThrow(/EAGAIN/)
  })

  it('does not retry a refusal that is not about process slots', async () => {
    failFor = (args) => args[0] === 'load-buffer'
    await expect(paste('%76', 'text', false)).rejects.toThrow(/no such pane/)
    // One attempt, plus the delete-buffer cleanup. A pane that does not exist
    // will not start existing because it was asked again.
    expect(allCommands().filter((cmd) => cmd[0] === 'load-buffer')).toHaveLength(1)
  })
})
