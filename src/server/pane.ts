/**
 * tmux adapters.
 *
 * INV-1: nothing in this file may create a tmux client. We never run
 * `attach-session` or `new-session`; we only read with `capture-pane` /
 * `display-message` and write with `send-keys` / `paste-buffer`. Attaching a
 * real client would resize the user's live panes, because this machine runs
 * with `window-size latest` and `aggressive-resize on`.
 */
import { execFile } from 'node:child_process'

const TMUX = 'tmux'
const BUFFER = 'agent-commander'

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

export class PaneError extends Error {}

function run(args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      TMUX,
      args,
      { maxBuffer: 8 * 1024 * 1024, timeout: 5000 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new PaneError((stderr || err.message).trim()))
          return
        }
        resolve(stdout)
      },
    )
    if (stdin !== undefined) {
      child.stdin?.end(stdin)
    }
  })
}

function assertPane(paneId: string): void {
  if (!PANE_RE.test(paneId)) {
    throw new PaneError(`refusing to use malformed pane id: ${paneId}`)
  }
}

/** Read the pane's geometry and cursor without touching it. */
export async function meta(paneId: string): Promise<PaneMeta> {
  assertPane(paneId)
  const fmt = '#{pane_width}|#{pane_height}|#{cursor_x}|#{cursor_y}|#{alternate_on}|#{pane_dead}'
  const out = await run(['display-message', '-p', '-t', paneId, fmt])
  const parts = out.trim().split('|')
  if (parts.length < 6) {
    throw new PaneError(`unexpected display-message output: ${out.trim()}`)
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

/**
 * Capture the pane's visible content with ANSI escapes preserved.
 * Returns exactly `rows` lines: tmux trims trailing blanks, so we pad.
 */
export async function capture(paneId: string, rows: number): Promise<string[]> {
  assertPane(paneId)
  const out = await run(['capture-pane', '-e', '-p', '-t', paneId])
  // A trailing newline from tmux would otherwise become a phantom final line.
  const body = out.endsWith('\n') ? out.slice(0, -1) : out
  const lines = body.split('\n')
  if (lines.length > rows) lines.length = rows
  while (lines.length < rows) lines.push('')
  return lines
}

/**
 * Send text to the pane as a bracketed paste, so multi-line input and
 * shell-special characters arrive intact rather than being re-interpreted as
 * keypresses. `submit` presses Enter afterwards as a separate event.
 */
export async function paste(paneId: string, text: string, submit: boolean): Promise<void> {
  assertPane(paneId)
  if (text.length === 0 && !submit) return
  if (text.length > 0) {
    await run(['load-buffer', '-b', BUFFER, '-'], text)
    await run(['paste-buffer', '-b', BUFFER, '-t', paneId, '-p', '-d'])
  }
  if (submit) {
    await run(['send-keys', '-t', paneId, 'Enter'])
  }
}

/** Send a single control key. The caller must have validated it against ALLOWED_KEYS. */
export async function key(paneId: string, keyName: string): Promise<void> {
  assertPane(paneId)
  await run(['send-keys', '-t', paneId, keyName])
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

/** Diagnostic snapshot used by the INV-1 regression test. */
export async function clientSnapshot(): Promise<string> {
  const clients = await run([
    'list-clients',
    '-F',
    '#{client_name} #{client_width}x#{client_height} #{client_session}',
  ]).catch(() => '')
  const panes = await run([
    'list-panes',
    '-a',
    '-F',
    '#{pane_id} #{pane_width}x#{pane_height}',
  ]).catch(() => '')
  return `${clients}\n---\n${panes}`
}
