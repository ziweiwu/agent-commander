/**
 * tmux adapters.
 *
 * INV-1: nothing in this file may create an interactive tmux client. We never
 * run `new-session`, and the only client this app attaches is the control-mode
 * one in `tmux-client.ts`, which carries `ignore-size` precisely so it cannot
 * resize the user's live panes — this machine runs with `window-size latest`
 * and `aggressive-resize on`, and a browser-shaped client would reflow a TUI
 * that a working agent is drawing into.
 *
 * Every operation here is *one* tmux round trip. It used to be two — a paste
 * was `load-buffer` then `paste-buffer`, and a frame was `display-message`
 * then `capture-pane` — and since the cost of a tmux command is almost
 * entirely the cost of *reaching* tmux rather than of the work asked for
 * (`display-message -p ok` measured p50 72.8ms against a bare fork+exec at
 * 3.0ms), halving the number of round trips halved the latency. Commands are
 * joined with `;`, which tmux reads as a command sequence.
 *
 * Each round trip prefers the persistent control client and falls back to
 * spawning a one-shot tmux. The fallback is not a rare path to be tolerated:
 * it is what runs for the first second of every session, and whenever the
 * control client is restarting.
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tmuxControl } from './tmux-client.ts'

const TMUX = 'tmux'

/**
 * Prefix for the paste buffers this app creates. Never used on its own: see
 * `bufferName` for why one shared name was a way to type into the wrong agent.
 */
const BUFFER_PREFIX = 'agent-commander'

let bufferSeq = 0

/**
 * A fresh buffer name for every paste.
 *
 * `load-buffer` and `paste-buffer` are now issued as a single tmux command
 * sequence, which removes the await that used to sit between them — but it
 * does not make one shared name safe. Two sequences still interleave at the
 * server, and with one name the second load could still land between the
 * first load and the first paste. The name stays per-paste for the same reason
 * it always did: with a shared one, two overlapping pastes interleaved as
 * load(A) → load(B) → paste(A's pane) and the first paste put *B's text* into
 * A's agent.
 *
 * The pid is in the name because a second agent-commander on the same machine
 * shares the tmux server, and therefore its buffer namespace.
 */
function bufferName(): string {
  bufferSeq += 1
  return `${BUFFER_PREFIX}-${process.pid}-${bufferSeq}`
}

/**
 * One in-flight tmux write per pane, in the order the user asked for them.
 *
 * Unique buffer names stop two pastes from swapping payloads, but they do not
 * order them: a `sendText` followed by `sendKey('Enter')` must not have the
 * Enter overtake the text it submits. Reads (`meta`, `capture`, `sample`) stay
 * off this chain — they touch nothing, and they run several times a second.
 */
const writeQueues = new Map<string, Promise<void>>()

function enqueue<T>(paneId: string, task: () => Promise<T>): Promise<T> {
  const prior = writeQueues.get(paneId) ?? Promise.resolve()
  const result = prior.then(task)
  // A failed write must not poison the pane's queue for every later one.
  const settled = result.then(
    () => {},
    () => {},
  )
  writeQueues.set(paneId, settled)
  void settled.then(() => {
    if (writeQueues.get(paneId) === settled) writeQueues.delete(paneId)
  })
  return result
}

/** tmux pane ids look like `%77`. Reject anything else before it reaches argv. */
const PANE_RE = /^%\d+$/

export interface PaneMeta {
  cols: number
  rows: number
  cursorX: number
  cursorY: number
  alternate: boolean
  dead: boolean
}

/** One pane read: its geometry and its visible content, from one round trip. */
export interface PaneSample {
  meta: PaneMeta
  lines: string[]
}

export class PaneError extends Error {}

const META_FORMAT =
  '#{pane_width}|#{pane_height}|#{cursor_x}|#{cursor_y}|#{alternate_on}|#{pane_dead}'

/**
 * How many times a spawn refused for want of a process slot is retried.
 *
 * This is not defensive padding. On a machine sitting at 2840 processes
 * against a `kern.maxprocperuid` of 2666 — 109 tmux panes and 33 Claude
 * sessions will do it — `spawn` returns EAGAIN readily, and it did so twice
 * while this path was being measured. Before this, one EAGAIN dropped the
 * character the user had just typed, or stopped their terminal outright.
 */
const SPAWN_RETRIES = 4
const SPAWN_RETRY_BASE_MS = 20

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

/** Spawn a one-shot tmux client. The fallback path, and the writer of stdin. */
function runOnce(args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      TMUX,
      args,
      { maxBuffer: 8 * 1024 * 1024, timeout: 5000 },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code
          const error = new PaneError((stderr || err.message).trim())
          // Carried through so the retry loop can tell "no process slots" from
          // "no such pane", which must not be retried.
          ;(error as NodeJS.ErrnoException).code = code
          reject(error)
          return
        }
        resolve(stdout)
      },
    )
    child.on('error', (err) => {
      const error = new PaneError(err.message)
      ;(error as NodeJS.ErrnoException).code = (err as NodeJS.ErrnoException).code
      reject(error)
    })
    if (stdin !== undefined) {
      child.stdin?.end(stdin)
    }
  })
}

async function run(args: string[], stdin?: string): Promise<string> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await runOnce(args, stdin)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EAGAIN' || attempt >= SPAWN_RETRIES) throw err
      await sleep(SPAWN_RETRY_BASE_MS * (attempt + 1))
    }
  }
}

/**
 * Run a read, through the control client when it is up.
 *
 * `args` is the spawn form; `commands` is the same sequence already spelled
 * for control mode, one string per command. They are passed separately rather
 * than derived from each other because the two have different quoting rules,
 * and deriving one from the other is exactly the kind of cleverness that would
 * put a `'` somewhere surprising. The array is not cosmetic either: its length
 * is how the client knows how many reply blocks the line will produce.
 *
 * A failed read is retried down the other path, because reading a pane twice
 * costs a round trip and changes nothing. Writes must not do this.
 */
async function execRead(args: string[], commands: string[]): Promise<string> {
  if (tmuxControl.ready) {
    try {
      return await tmuxControl.run(commands)
    } catch {
      // The client died, timed out, or tmux refused. It restarts itself; this
      // call still has a user waiting on it, so it is tried the old way rather
      // than failed.
      return run(args)
    }
  }
  return run(args)
}

/**
 * Run a write, through the control client when it is up — and only once.
 *
 * The difference from `execRead` is the entire point of this function. A write
 * that fails *after* it reached tmux has an unknown outcome: a sequence of
 * `load-buffer ; paste-buffer ; send-keys` that reports an error at the last
 * step has already put the text into the pane, and a client that timed out may
 * well have delivered everything. Retrying that down the spawn path would type
 * the user's text into a live agent a second time — which is exactly what
 * INV-2 forbids: re-sending is the user's decision, not the app's.
 *
 * So the path is chosen *before* anything is sent, and a failure after that is
 * reported rather than retried. The one retry that remains is inside `run`,
 * for `EAGAIN`, and it is safe for the same reason it is needed: the process
 * never started, so nothing was written.
 */
async function execWrite(args: string[], commands: string[]): Promise<string> {
  if (tmuxControl.ready) {
    try {
      return await tmuxControl.run(commands)
    } catch (err) {
      throw err instanceof PaneError ? err : new PaneError(reasonOf(err))
    }
  }
  return run(args)
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function assertPane(paneId: string): void {
  if (!PANE_RE.test(paneId)) {
    throw new PaneError(`refusing to use malformed pane id: ${paneId}`)
  }
}

function parseMeta(line: string): PaneMeta {
  const parts = line.trim().split('|')
  if (parts.length < 6) {
    throw new PaneError(`unexpected display-message output: ${line.trim()}`)
  }
  const num = (i: number): number => {
    const n = Number.parseInt(parts[i] ?? '', 10)
    return Number.isFinite(n) ? n : 0
  }
  return {
    cols: num(0),
    rows: num(1),
    cursorX: num(2),
    cursorY: num(3),
    alternate: parts[4] === '1',
    dead: parts[5] === '1',
  }
}

/** tmux trims trailing blank lines, so pad back out to the pane's height. */
function padCapture(body: string[], rows: number): string[] {
  const lines = [...body]
  if (lines.length > rows) lines.length = rows
  while (lines.length < rows) lines.push('')
  return lines
}

function splitLines(out: string): string[] {
  // A trailing newline from tmux would otherwise become a phantom final line.
  const body = out.endsWith('\n') ? out.slice(0, -1) : out
  return body.split('\n')
}

/** Read the pane's geometry and cursor without touching it. */
export async function meta(paneId: string): Promise<PaneMeta> {
  assertPane(paneId)
  const out = await execRead(
    ['display-message', '-p', '-t', paneId, META_FORMAT],
    [`display-message -p -t ${paneId} '${META_FORMAT}'`],
  )
  return parseMeta(out.split('\n')[0] ?? '')
}

/**
 * Capture the pane's visible content with ANSI escapes preserved.
 * Returns exactly `rows` lines: tmux trims trailing blanks, so we pad.
 */
export async function capture(paneId: string, rows: number): Promise<string[]> {
  assertPane(paneId)
  const out = await execRead(
    ['capture-pane', '-e', '-p', '-t', paneId],
    [`capture-pane -e -p -t ${paneId}`],
  )
  return padCapture(splitLines(out), rows)
}

/**
 * Geometry and content in a single round trip.
 *
 * This is what the Attach view actually polls. As two calls it cost p50 141ms
 * against a 140ms frame budget — the poll could not keep up with its own
 * timer, and every missed tick was a frame the user did not see. As one call
 * it is p50 69ms spawned and roughly 20ms through the control client.
 *
 * The format string is single-quoted for control mode so that tmux's argument
 * lexer hands `#{pane_width}` to display-message *unexpanded*. Double quotes
 * would have tmux expand it first, against whichever pane the control client
 * considers current — which is never the pane being asked about, so the
 * terminal would have been sized from another agent's window.
 */
export async function sample(paneId: string): Promise<PaneSample> {
  assertPane(paneId)
  const out = await execRead(
    ['display-message', '-p', '-t', paneId, META_FORMAT, ';', 'capture-pane', '-e', '-p', '-t', paneId],
    [
      `display-message -p -t ${paneId} '${META_FORMAT}'`,
      `capture-pane -e -p -t ${paneId}`,
    ],
  )
  const lines = splitLines(out)
  const head = lines.shift() ?? ''
  const geometry = parseMeta(head)
  return { meta: geometry, lines: padCapture(lines, geometry.rows) }
}

/**
 * Where a paste's text is staged for tmux to read.
 *
 * The text goes through a file rather than onto the command line because the
 * control client has no stdin to pipe it down — stdin *is* the command
 * channel. Putting it in the command instead would mean quoting arbitrary user
 * text for tmux's lexer, where a stray quote is not a rendering bug but a
 * command boundary. INV-2 says what reaches an agent is what was typed for it;
 * a file keeps that true without a quoting rule to get wrong.
 */
let stageDir: string | null = null
let stageDirPromise: Promise<string> | null = null

/**
 * `mkdtemp`, not a predictable name in the shared temp root.
 *
 * The buffer names this would otherwise use are predictable — pid and a
 * counter — and the temp root is world-writable, so another local user could
 * pre-create a symlink at the path we are about to write and have the user's
 * prompt text land wherever they pointed it. A 0700 directory with a random
 * name is what closes that; the pid in the prefix is only so a later run can
 * tell its own leftovers from a live instance's.
 */
const STAGE_PREFIX = 'agent-commander-paste-'

async function stagingDir(): Promise<string> {
  if (stageDir) return stageDir
  stageDirPromise ??= mkdtemp(join(tmpdir(), `${STAGE_PREFIX}${process.pid}-`)).then((dir) => {
    stageDir = dir
    return dir
  })
  return stageDirPromise
}

/**
 * Remove staging directories left by runs that did not get to shut down.
 *
 * `cleanup` runs on SIGINT and SIGTERM, which covers quitting the app. It does
 * not cover SIGKILL, a crash, or a reboot — and this directory is created once
 * per run, so without a sweep those leftovers accumulate in the temp root for
 * as long as the machine goes without clearing it. They are empty in the
 * ordinary case, because each paste unlinks its own file in a `finally`; a run
 * killed mid-paste can leave one 0600 file behind, which is the better reason
 * to clear them out rather than to leave them lying around.
 *
 * Directories belonging to a live pid are left alone: a second
 * agent-commander on the same machine is a supported arrangement, and its
 * staging directory is none of this one's business.
 */
export async function sweepStaleStaging(root = tmpdir()): Promise<number> {
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    if (!name.startsWith(STAGE_PREFIX)) continue
    const pid = Number.parseInt(name.slice(STAGE_PREFIX.length).split('-')[0] ?? '', 10)
    // An unparseable pid means a directory from before this naming; it cannot
    // be attributed to a live process, so it is safe to drop.
    if (Number.isFinite(pid) && pid > 0 && pidAlive(pid)) continue
    await rm(join(root, name), { recursive: true, force: true }).catch(() => {})
    removed += 1
  }
  return removed
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means it exists and belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Write a paste's text where tmux can read it, or return null to say it could
 * not be done — in which case nothing has been sent and the caller is free to
 * take the other path.
 */
async function stage(buffer: string, text: string): Promise<string | null> {
  try {
    const dir = await stagingDir()
    const file = join(dir, buffer)
    // A quote or a backslash in the path would break out of the argument when
    // the command line is built. Nothing this app generates has one, but the
    // temp root belongs to the system, so it is checked rather than assumed.
    if (file.includes("'") || file.includes('\\')) return null
    // 0600: this is the user's prompt text sitting in a shared temp root.
    await writeFile(file, text, { mode: 0o600 })
    return file
  } catch {
    return null
  }
}

/** Clean up the staging directory on shutdown. Best effort by design. */
export async function cleanup(): Promise<void> {
  if (!stageDir) return
  await rm(stageDir, { recursive: true, force: true }).catch(() => {})
  stageDir = null
  stageDirPromise = null
}

/**
 * Send text to the pane as a bracketed paste, so multi-line input and
 * shell-special characters arrive intact rather than being re-interpreted as
 * keypresses. `submit` presses Enter afterwards, in the same command sequence.
 */
export async function paste(paneId: string, text: string, submit: boolean): Promise<void> {
  assertPane(paneId)
  if (text.length === 0 && !submit) return
  await enqueue(paneId, async () => {
    if (text.length === 0) {
      await execWrite(['send-keys', '-t', paneId, 'Enter'], [`send-keys -t ${paneId} Enter`])
      return
    }

    const buffer = bufferName()
    const tail = submit ? [';', 'send-keys', '-t', paneId, 'Enter'] : []
    const tailCmd = submit ? [`send-keys -t ${paneId} Enter`] : []

    // `-d` deletes the buffer once it has been pasted.
    //
    // Staging happens first and completely, so the choice between the two
    // paths is made before a single byte reaches tmux. Anything that goes
    // wrong here -- no temp dir, a full disk, a temp root with a quote in its
    // name -- has written nothing, so taking the spawn path instead carries
    // none of the double-delivery risk `execWrite` exists to avoid.
    const file = tmuxControl.ready ? await stage(buffer, text) : null
    if (!file) return spawnedPaste(buffer, paneId, text, tail)
    return controlPaste(buffer, paneId, file, tailCmd)
  })
}

/**
 * The control-client half of a paste: tell tmux to read the staged file.
 *
 * Never retried down the other path. The sequence may have delivered the text
 * before it reported an error, and trying again would type the user's
 * instruction into a live agent a second time — INV-2's one prohibition.
 */
async function controlPaste(
  buffer: string,
  paneId: string,
  file: string,
  tailCmd: string[],
): Promise<void> {
  try {
    await tmuxControl.run([
      `load-buffer -b ${buffer} '${file}'`,
      `paste-buffer -b ${buffer} -t ${paneId} -p -d`,
      ...tailCmd,
    ])
  } catch (err) {
    // The buffer may have been loaded before the sequence stopped, and these
    // names are per-paste, so it would sit in the tmux server for as long as it
    // runs. Deleting a buffer cannot deliver anything to an agent, so unlike
    // the paste itself this is safe to issue blindly.
    await tmuxControl.run([`delete-buffer -b ${buffer}`]).catch(() => {})
    throw err instanceof PaneError ? err : new PaneError(reasonOf(err))
  } finally {
    await rm(file, { force: true }).catch(() => {})
  }
}

/** Send a single control key. The caller must have validated it against ALLOWED_KEYS. */
/**
 * The spawned half of a paste: load a buffer and paste it in one invocation.
 *
 * Split out so `paste` reads as the two paths it chooses between rather than
 * as one of them nested inside the other.
 */
async function spawnedPaste(
  buffer: string,
  paneId: string,
  text: string,
  tail: string[],
): Promise<void> {
  try {
    await run(
      ['load-buffer', '-b', buffer, '-', ';', 'paste-buffer', '-b', buffer, '-t', paneId, '-p', '-d', ...tail],
      text,
    )
  } catch (err) {
    // A sequence that failed part-way can leave its buffer behind, and these
    // are per-call, so they would accumulate for the life of the tmux server
    // rather than being overwritten by the next paste.
    await run(['delete-buffer', '-b', buffer]).catch(() => {})
    throw err
  }
}

export async function key(paneId: string, keyName: string): Promise<void> {
  assertPane(paneId)
  // Same queue as paste: an Enter must not overtake the text it submits.
  await enqueue(paneId, () =>
    execWrite(['send-keys', '-t', paneId, keyName], [`send-keys -t ${paneId} ${keyName}`]),
  )
}

/**
 * The pane ids in a session, oldest first.
 *
 * Used by `PendingStore` to find the pane a just-spawned agent is drawing
 * into, before it has written a session file of its own. It lives here rather
 * than in a private `execFile` there so it gets what every other tmux read in
 * this app gets: the control client when one is up, and the `EAGAIN` retry
 * when one is not. Without those, a machine at its process cap answered "no
 * panes" for a session that was perfectly alive.
 *
 * Throws rather than returning empty when tmux could not be asked. The
 * difference between "this session has no panes" and "this question could not
 * be put" is the whole reason this function exists (INV-5).
 */
export async function listPanes(session: string): Promise<string[]> {
  if (!/^[A-Za-z0-9_.-]+$/.test(session)) {
    throw new PaneError(`refusing to use malformed session name: ${session}`)
  }
  const out = await execRead(
    ['list-panes', '-t', session, '-F', '#{pane_id}'],
    [`list-panes -t ${session} -F '#{pane_id}'`],
  )
  return splitLines(out)
    .map((line) => line.trim())
    .filter((line) => PANE_RE.test(line))
}

/**
 * Whether tmux said a target does not exist, as opposed to failing to answer.
 *
 * tmux's wording for a missing target has been stable for a very long time
 * (`can't find session: name`, `session not found: name`), and matching it is
 * the only way to tell that answer from a spawn that never happened. Anything
 * unrecognised is treated as "could not ask", which is the safe direction: it
 * keeps a pending agent visible for its expiry rather than making a live one
 * disappear.
 */
export function isMissingTarget(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  // The process never started for want of a slot: the question was not put, so
  // nothing was answered. This is the case that used to be read as "gone".
  if (code === 'EAGAIN') return false
  // No tmux binary on this machine at all. Then there is no session either,
  // and waiting five minutes to say so helps nobody.
  if (code === 'ENOENT') return true
  const message = reasonOf(err).toLowerCase()
  return /can't find|cannot find|no such|not found|no server running/.test(message)
}

/**
 * End a whole tmux session. Used only as the forced fallback when an agent has
 * ignored `/exit`; this creates no client, so INV-1 is unaffected.
 */
export async function killSession(session: string): Promise<void> {
  if (!/^[A-Za-z0-9_.-]+$/.test(session)) {
    throw new PaneError(`refusing to use malformed session name: ${session}`)
  }
  await run(['kill-session', '-t', session])
}

/** True when a tmux server is reachable at all. */
export async function available(): Promise<boolean> {
  try {
    await run(['display-message', '-p', 'ok'])
    return true
  } catch {
    return false
  }
}

/**
 * Diagnostic snapshot used by the INV-1 regression test.
 *
 * `client_flags` is in there deliberately: the control client is allowed to
 * exist only because it carries `ignore-size`, so a change that dropped the
 * flag has to show up as a difference rather than as a quiet resize.
 */
export async function clientSnapshot(): Promise<string> {
  const clients = await run([
    'list-clients',
    '-F',
    '#{client_name} #{client_width}x#{client_height} #{client_session} #{client_flags}',
  ]).catch(() => '')
  const panes = await run([
    'list-panes',
    '-a',
    '-F',
    '#{pane_id} #{pane_width}x#{pane_height}',
  ]).catch(() => '')
  return `${clients}\n---\n${panes}`
}
