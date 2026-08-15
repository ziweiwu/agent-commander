/**
 * Starting a new agent.
 *
 * INV-7: this is the only place the app creates a process. It runs exactly one
 * command shape — `tmux new-session -d -s <generated> -c <validated dir> claude`
 * — with the directory validated first and every value passed as a separate
 * argv entry, never through a shell. The session name is generated here, so
 * nothing user-supplied reaches tmux's argument parser.
 */
import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { isModelAlias, isPermissionMode, SpawnOptionError } from './options.ts'

/** Same shape Claude Code uses for its own tmux sessions. */
const SESSION_PREFIX = 'claude'

export class SpawnError extends Error {}

export interface SpawnRequest {
  cwd: string
  /** Passed to claude as `-n`, and used to suffix the tmux session name. */
  name?: string | undefined
  /** Validated against the allow-list in control.ts before it reaches argv. */
  model?: string | undefined
  permissionMode?: string | undefined
}

export interface SpawnResult {
  tmuxSession: string
  cwd: string
}

export { SpawnOptionError }

/** Expand a leading `~` and make the path absolute. */
export function normalizeDir(input: string, home = homedir()): string {
  const trimmed = input.trim()
  if (trimmed.length === 0) throw new SpawnError('a directory is required')
  const expanded =
    trimmed === '~' ? home : trimmed.startsWith('~/') ? resolve(home, trimmed.slice(2)) : trimmed
  if (!isAbsolute(expanded)) {
    throw new SpawnError('the directory must be an absolute path')
  }
  return resolve(expanded)
}

/** Reject anything that is not an existing directory before spawning. */
export async function validateDir(input: string, home = homedir()): Promise<string> {
  const dir = normalizeDir(input, home)
  let info
  try {
    info = await stat(dir)
  } catch {
    throw new SpawnError(`no such directory: ${dir}`)
  }
  if (!info.isDirectory()) throw new SpawnError(`not a directory: ${dir}`)
  return dir
}

/**
 * Generated, not user-supplied. A tmux session name containing `:` or `.`
 * would collide with tmux's own target syntax.
 */
export function sessionName(now: number, suffix = ''): string {
  const clean = suffix.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 24)
  return clean ? `${SESSION_PREFIX}-${now}-${clean}` : `${SESSION_PREFIX}-${now}`
}

function tmux(args: string[]): Promise<string> {
  return new Promise((ok, fail) => {
    execFile('tmux', args, { timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) fail(new SpawnError((stderr || err.message).trim()))
      else ok(stdout)
    })
  })
}

/**
 * Create a detached tmux session running `claude` in the chosen directory.
 *
 * The new process registers itself in ~/.claude/sessions, so it appears in the
 * fleet on the next refresh without this module having to tell anyone.
 */
export async function startAgent(
  req: SpawnRequest,
  deps: { now: number; claudeBin?: string } = { now: Date.now() },
): Promise<SpawnResult> {
  const cwd = await validateDir(req.cwd)
  const session = sessionName(deps.now, req.name ?? '')

  // INV-7: every value is its own argv entry, and model and mode are checked
  // against fixed allow-lists so nothing free-text becomes a flag.
  const argv = [deps.claudeBin ?? 'claude']
  if (req.name?.trim()) argv.push('-n', req.name.trim())
  if (req.model) {
    if (!isModelAlias(req.model)) throw new SpawnOptionError(`unknown model: ${req.model}`)
    argv.push('--model', req.model)
  }
  if (req.permissionMode) {
    if (!isPermissionMode(req.permissionMode)) {
      throw new SpawnOptionError(`unknown permission mode: ${req.permissionMode}`)
    }
    argv.push('--permission-mode', req.permissionMode)
  }

  await tmux(['new-session', '-d', '-s', session, '-c', cwd, ...argv])
  return { tmuxSession: session, cwd }
}
