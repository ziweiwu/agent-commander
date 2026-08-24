/**
 * One long-lived tmux control-mode client, shared by every pane read and write.
 *
 * Why this exists: every `tmux <command>` starts a *new* tmux client process,
 * and that handshake — not the fork, and not the amount of data moved — is
 * what the Attach view spends its time on. Measured against a tmux server
 * running 109 panes:
 *
 *     /bin/echo (bare fork+exec)          p50   3.0 ms
 *     tmux display-message -p ok          p50  72.8 ms   ← no work at all
 *     tmux capture-pane (274 B result)    p50  36.9 ms
 *
 * The work is not the cost; the client is. A control-mode client is spawned
 * once and then answers commands over a pipe, which brings the same commands
 * to p50 7-24 ms and — just as importantly — stops forking altogether. That
 * second part is not a nicety: at 2840 processes against a `kern.maxprocperuid`
 * of 2666, `spawn tmux` returns EAGAIN, and a single transient EAGAIN used to
 * stop the terminal for good (see the failure counting in routes.ts).
 *
 * INV-1: this *is* a tmux client, which INV-1 flatly forbade before. It is
 * attached with `-f ignore-size`, which tmux documents as "the client does not
 * affect the size of other clients" — so the thing INV-1 exists to prevent, a
 * browser-shaped client reflowing a working agent's pane under `window-size
 * latest` and `aggressive-resize on`, cannot happen through it. INVARIANTS.md
 * records the amendment and `npm run verify:inv1` proves it against a live
 * server rather than by assertion.
 *
 * Nothing here is required. Every caller falls back to spawning a one-shot
 * tmux client when `ready` is false, so a tmux too old for `ignore-size`, a
 * machine with no session to attach to, or a client that dies mid-run costs
 * latency and nothing else.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'

/**
 * The flags that make attaching safe, and one that makes it durable.
 *
 * `ignore-size` is the INV-1 guarantee. `no-output` declines the pane-output
 * firehose we would otherwise be sent for every pane on the server — this
 * client asks questions, it does not want a stream. `no-detach-on-destroy`
 * keeps it alive when the session it happened to attach to is killed, which
 * for this app is routine: sessions here *are* agents, and closing one is a
 * button in the UI.
 */
const ATTACH_FLAGS = 'ignore-size,no-output,no-detach-on-destroy'

/** How long a single command may take before it is treated as lost. */
const COMMAND_TIMEOUT_MS = 5_000

/** How commands are joined into one line. tmux reads this as a sequence. */
const SEPARATOR = ' ; '

/** How long the handshake probe may take before control mode is written off. */
const PROBE_TIMEOUT_MS = 3_000

const RESTART_BASE_MS = 1_000
const RESTART_MAX_MS = 30_000

/** tmux control mode opens every reply block with this. */
const BEGIN_PREFIX = '%begin '

export class TmuxControlError extends Error {}

interface Waiter {
  resolve: (output: string) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
  /** How many reply blocks this command line will produce; see `run`. */
  expected: number
  parts: string[]
}

/** Ask the tmux server for any session name, or null if it has none. */
function firstSession(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('tmux', ['list-sessions', '-F', '#{session_name}'], { timeout: 5_000 }, (err, out) => {
      if (err) {
        resolve(null)
        return
      }
      const name = out.split('\n').find((line) => line.trim().length > 0)
      resolve(name?.trim() ?? null)
    })
  })
}

/**
 * The line framing of tmux control mode, on its own so it can be tested.
 *
 * Every reply is bracketed by `%begin <ts> <num>` and `%end <ts> <num>`, and
 * tmux does *not* escape the command output in between. A captured pane can
 * therefore contain a line that looks exactly like a terminator — `capture-pane`
 * on a terminal showing this very protocol is the obvious way to produce one —
 * so the closing line is matched against the exact id the block was opened
 * with rather than against `%end` alone. This is what iTerm2's tmux integration
 * does, and it is why the id is carried at all.
 */
export class ControlStream {
  #buf = ''
  #block: { id: string; lines: string[] } | null = null

  constructor(private readonly onBlock: (output: string, error: Error | null) => void) {}

  reset(): void {
    this.#buf = ''
    this.#block = null
  }

  push(chunk: string): void {
    this.#buf += chunk
    for (;;) {
      const nl = this.#buf.indexOf('\n')
      if (nl < 0) break
      const line = this.#buf.slice(0, nl).replace(/\r$/, '')
      this.#buf = this.#buf.slice(nl + 1)
      this.#line(line)
    }
  }

  #line(line: string): void {
    const block = this.#block
    if (block) {
      if (closes(line, '%end', block.id)) {
        this.#block = null
        this.onBlock(block.lines.join('\n'), null)
        return
      }
      if (closes(line, '%error', block.id)) {
        this.#block = null
        this.onBlock('', new TmuxControlError(block.lines.join('\n').trim() || 'tmux error'))
        return
      }
      block.lines.push(line)
      return
    }
    if (line.startsWith(BEGIN_PREFIX)) {
      const [ts, num] = line.slice(BEGIN_PREFIX.length).split(' ')
      this.#block = { id: `${ts} ${num}`, lines: [] }
    }
    // Every other `%notification` — %session-changed, %window-add, %exit — is
    // state this client does not model. It asks questions and reads answers.
  }
}

function closes(line: string, marker: string, id: string): boolean {
  const head = `${marker} ${id}`
  return line === head || line.startsWith(`${head} `)
}

/**
 * How the client reaches tmux. Injected so the framing and the restart
 * behaviour can be tested against a fake tmux rather than only against a real
 * one — the reply accounting is the part of this file that fails silently, so
 * it is the part that most needs a test that can force the awkward cases.
 */
export interface TmuxControlDeps {
  spawn: (args: string[]) => ChildProcess
  firstSession: () => Promise<string | null>
}

const liveDeps: TmuxControlDeps = {
  spawn: (args) => spawn('tmux', args, { stdio: ['pipe', 'pipe', 'pipe'] }),
  firstSession,
}

export class TmuxControl {
  #child: ChildProcess | null = null
  #ready = false
  #stopped = false
  #stream = new ControlStream((output, err) => this.#finish(output, err))
  #waiters: Waiter[] = []
  #restartDelay = RESTART_BASE_MS
  #restartTimer: NodeJS.Timeout | null = null
  #starting = false

  /** Counters the benchmark script and the tests read. */
  readonly stats = { commands: 0, restarts: 0, failures: 0 }

  constructor(private readonly deps: TmuxControlDeps = liveDeps) {}

  /** How long to ignore tmux's own startup chatter before probing. */
  settleMs = 150

  /** True when a command can be sent right now. Callers spawn instead if not. */
  get ready(): boolean {
    return this.#ready && this.#child !== null
  }

  /**
   * Bring the client up in the background.
   *
   * Deliberately not awaited by callers. Starting costs a `list-sessions` and
   * a handshake, and making the first pane read wait for that would put the
   * slowest tmux call of the whole session directly in front of the user. The
   * first few reads spawn as before and the client takes over once it answers.
   */
  start(): void {
    if (this.#stopped || this.#child || this.#starting) return
    this.#starting = true
    void this.#spawnClient().finally(() => {
      this.#starting = false
    })
  }

  async #spawnClient(): Promise<void> {
    const session = await this.deps.firstSession()
    if (this.#stopped) return
    if (!session) {
      // No session means nothing to attach to *and* nothing to read, so there
      // is no work being missed. A later restart picks one up when it appears.
      this.#scheduleRestart()
      return
    }

    let child: ChildProcess
    try {
      child = this.deps.spawn(['-C', 'attach', '-t', session, '-f', ATTACH_FLAGS])
    } catch {
      this.#scheduleRestart()
      return
    }

    this.#child = child
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.#stream.push(chunk))
    // stderr is drained rather than read: an unread pipe fills and blocks the
    // child, and control mode reports its errors in-band as `%error`.
    child.stderr?.resume()
    child.on('error', () => this.#onExit())
    child.on('exit', () => this.#onExit())

    // Anything tmux says before the probe belongs to the attach, not to us.
    // Waiting a beat and then clearing is what keeps a startup notification
    // from being handed to the first real command as its reply.
    await new Promise((resolve) => setTimeout(resolve, this.settleMs))
    if (this.#stopped || this.#child !== child) return
    this.#stream.reset()

    try {
      const out = await this.#send(['display-message -p ok'], PROBE_TIMEOUT_MS)
      if (out.trim() !== 'ok') throw new TmuxControlError(`unexpected probe reply: ${out.trim()}`)
      this.#ready = true
      this.#restartDelay = RESTART_BASE_MS
    } catch {
      // A tmux without `ignore-size` (< 3.2) fails here rather than silently
      // attaching a client that would resize the user's panes. Falling back is
      // the correct outcome, not a degraded one.
      child.kill()
      this.#onExit()
    }
  }

  #onExit(): void {
    const child = this.#child
    this.#child = null
    this.#ready = false
    child?.removeAllListeners()
    const err = new TmuxControlError('tmux control client exited')
    for (const waiter of this.#waiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.reject(err)
    }
    this.#stream.reset()
    this.#scheduleRestart()
  }

  #scheduleRestart(): void {
    if (this.#stopped || this.#restartTimer) return
    this.stats.restarts += 1
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null
      this.#starting = true
      void this.#spawnClient().finally(() => {
        this.#starting = false
      })
    }, this.#restartDelay)
    this.#restartTimer.unref?.()
    this.#restartDelay = Math.min(this.#restartDelay * 2, RESTART_MAX_MS)
  }

  stop(): void {
    this.#stopped = true
    this.#ready = false
    if (this.#restartTimer) clearTimeout(this.#restartTimer)
    this.#restartTimer = null
    for (const waiter of this.#waiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.reject(new TmuxControlError('stopped'))
    }
    this.#child?.kill()
    this.#child = null
  }

  /**
   * Attribute one reply block to the command line waiting for it.
   *
   * A command *line* is not one block. tmux replies once per command in the
   * sequence, so `a ; b ; c` comes back as three `%begin`/`%end` pairs — which
   * is the whole reason this counts rather than shifting a waiter per block.
   * Getting that wrong does not fail loudly: the first block resolves the
   * call, the other two are then handed to whatever is asked next, and every
   * reply from there on is shifted by one. In practice that means the Attach
   * view drawing a pane's contents into another pane's geometry.
   *
   * An error ends the line. Measured against tmux 3.6a: a sequence that fails
   * to resolve a target (`paste-buffer` of a buffer that is gone, `send-keys`
   * to a pane that has exited) and a sequence that fails to parse both produce
   * exactly one `%error` block and run nothing further, so there is never a
   * remainder left to skip.
   */
  #finish(output: string, err: Error | null): void {
    const waiter = this.#waiters[0]
    // No waiter means tmux volunteered a block nobody asked for. Dropping it
    // is right: handing it to the next command would answer that command with
    // someone else's output.
    if (!waiter) return

    if (err) {
      this.#waiters.shift()
      clearTimeout(waiter.timer)
      waiter.reject(err)
      return
    }

    waiter.parts.push(output)
    if (waiter.parts.length < waiter.expected) return
    this.#waiters.shift()
    clearTimeout(waiter.timer)
    // Commands that say nothing -- `load-buffer`, `send-keys` -- contribute no
    // lines, so their empty replies are not joined in as blank ones. A read
    // that is genuinely empty is padded by the caller from the geometry it
    // asked for in the same breath.
    waiter.resolve(waiter.parts.filter((part) => part.length > 0).join('\n'))
  }

  #send(commands: string[], timeoutMs: number): Promise<string> {
    const child = this.#child
    if (!child?.stdin?.writable) {
      return Promise.reject(new TmuxControlError('no tmux control client'))
    }
    const line = commands.join(SEPARATOR)
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        // A reply that never came means the queue no longer lines up with the
        // server's replies, and every later command would be answered by the
        // one before it. Restarting is the only way back to a known position.
        this.stats.failures += 1
        this.#child?.kill()
        reject(new TmuxControlError(`tmux control command timed out: ${line}`))
      }, timeoutMs)
      timer.unref?.()
      this.#waiters.push({ resolve, reject, timer, expected: commands.length, parts: [] })
      this.stats.commands += commands.length
      child.stdin?.write(`${line}\n`)
    })
  }

  /**
   * Run a sequence of tmux commands as one line, and return their output.
   *
   * Taken as an array rather than a joined string on purpose: the number of
   * commands is what says how many reply blocks to expect, and recovering that
   * by splitting a string on `;` would be one stray semicolon away from
   * silently desynchronising every later reply.
   *
   * Callers must only ever build these from validated pane ids, generated
   * buffer names and constant format strings. No text a user typed is ever
   * spelled out here — it travels through a file, so tmux's own argument lexer
   * never sees it. See `pane.ts`.
   */
  run(commands: string[]): Promise<string> {
    if (!this.ready) return Promise.reject(new TmuxControlError('control client not ready'))
    return this.#send(commands, COMMAND_TIMEOUT_MS)
  }
}

/** The process-wide client. Mock mode never starts it. */
export const tmuxControl = new TmuxControl()
