/** Wire types shared by the server and the browser client. */

export type AgentStatus = 'busy' | 'idle' | 'waiting' | 'unknown'

/** One Claude Code session, as presented to the UI. */
export interface Agent {
  sessionId: string
  pid: number
  name: string
  cwd: string
  /** Basename of cwd, precomputed for the card header. */
  folder: string
  status: AgentStatus
  /** Why the agent is blocked, e.g. "dialog open". Only set when status is waiting. */
  waitingFor?: string
  kind: string
  startedAt: number
  version?: string
  gitBranch?: string
  /** tmux pane id (e.g. "%77"). Absent means the agent cannot be attached to. */
  paneId?: string
  /** tmux session name, kept for display only — never attached to (INV-1). */
  tmuxSession?: string
  /** Why attach is unavailable, when it is. */
  attachBlockedReason?: string
  /** One-line summary of what the agent is doing right now. */
  activity?: string
  /** Epoch ms of the most recent transcript event. */
  lastActivityAt?: number
  /** Cumulative output tokens seen in this session's transcript. */
  tokens?: number
  /** Number of subagent (sidechain) events seen recently. */
  subagents?: number
  /**
   * The agent has handed work to a subagent and is doing nothing itself until
   * it returns.
   *
   * Worth its own field because it is indistinguishable from "stalled" on the
   * evidence the card otherwise has: the main transcript stops growing the
   * moment the work is delegated, so the last-activity clock ticks up and the
   * card reads as an agent that has quietly died. The subagent's own transcript
   * is the thing still moving.
   */
  delegating?: boolean
  /** Title the agent generated for its own conversation; beats a derived name. */
  aiTitle?: string
  /** The most recent thing the user asked it, used when there is no title yet. */
  lastPrompt?: string
  /** True when Claude Code invented the name (`nameSource: "derived"`). */
  derivedName?: boolean
  /** Permission mode the session is currently running in. */
  permissionMode?: string
  /** Model id the session most recently used, e.g. "claude-opus-5". */
  model?: string
  /** The session goal set with `/goal`, as last recorded in the transcript. */
  goal?: GoalState
}

/**
 * A Claude Code session goal.
 *
 * `/goal <condition>` installs a Stop hook: the session keeps working until a
 * separate evaluator agrees the condition is met. Claude Code writes each
 * verdict into the transcript as a `goal_status` attachment, which is the only
 * place this state is observable from outside the session — the session file
 * does not carry it and neither does the statusLine payload.
 *
 * Three record shapes exist, and the newest one is the current state:
 *   - `sentinel`, `met: false` — written the moment the goal is set
 *   - `met: false` with a reason — evaluated and rejected; still running
 *   - `met: true` with a reason — achieved, and the goal is over
 *
 * Clearing a goal writes nothing at all, which is why the server drops its own
 * copy when it sends `/goal clear` rather than waiting for evidence that will
 * never arrive.
 */
export interface GoalState {
  /** The condition the session is working towards, as the user typed it. */
  condition: string
  /** True once the evaluator confirmed it. A met goal is finished, not running. */
  met: boolean
  /** Epoch ms of the record this was read from. */
  at: number
  /** The evaluator's reasoning, when it has ruled at all. */
  reason?: string
  /** True when this is the set-record, so nothing has evaluated it yet. */
  fresh?: boolean
}

/** One quota window, as a percentage used and when it refills. */
export interface UsageWindow {
  /** 0-100. */
  pct: number
  /** Epoch ms when the window resets. Absent when Claude Code did not report it. */
  resetsAt?: number
}

/**
 * Account-level subscription usage, bridged out of Claude Code's statusLine by
 * `scripts/statusline-bridge.mjs`.
 *
 * This does not come from the transcripts. `~/.claude/projects/*.jsonl` carries
 * per-request token counts only; the 5-hour and 7-day windows exist nowhere on
 * disk until a statusLine command writes them down.
 */
export interface RateLimits {
  fiveHour?: UsageWindow
  sevenDay?: UsageWindow
  /** Epoch ms the bridge last wrote. The UI dims the meters once this is old. */
  at: number
}

/** Facts about the host machine, used by the help page. */
export interface ServerEnv {
  tailscale: {
    cliPath: string
    dnsName: string
    ip: string
    running: boolean
  } | null
  /** False when no tmux server is reachable, which disables attach and spawning. */
  tmux: boolean
  port: number
  platform: string
}

export interface NewAgentRequest {
  cwd: string
  name?: string
  model?: string
  permissionMode?: string
}

export interface DirEntryDto {
  name: string
  path: string
  hidden: boolean
}

export interface DirListing {
  path: string
  parent: string | null
  root: string
  entries: DirEntryDto[]
}

export type ControlResponse =
  | { ok: true; detail?: string }
  | { ok: false; error: string }

export type NewAgentResponse =
  | { ok: true; tmuxSession: string; cwd: string }
  | { ok: false; error: string }

export type TimelineKind =
  | 'user'
  | 'assistant'
  | 'tool'
  | 'subagent'
  | 'notice'

export interface TimelineEvent {
  id: string
  at: number
  kind: TimelineKind
  /** Primary line of text. */
  text: string
  /** Tool name, for kind === 'tool'. */
  tool?: string
  /** True when this event came from a subagent sidechain. */
  sidechain?: boolean
}

/** A rendered snapshot of a tmux pane. */
export interface Frame {
  sessionId: string
  cols: number
  rows: number
  cursorX: number
  cursorY: number
  /** Full frame: every line, padded to `rows`. Sent on first paint and resync. */
  lines?: string[]
  /** Sparse update: only the rows that changed since the last frame. */
  changed?: Array<{ row: number; text: string }>
}

/* ---- client -> server ---- */

export type ClientMessage =
  | { type: 'focus'; sessionId: string | null }
  | { type: 'attach'; sessionId: string; on: boolean }
  | { type: 'paste'; sessionId: string; text: string; submit: boolean }
  | { type: 'key'; sessionId: string; key: string }

/* ---- server -> client ---- */

export type ServerMessage =
  | { type: 'fleet'; agents: Agent[]; mock: boolean }
  | { type: 'limits'; limits: RateLimits | null }
  | { type: 'timeline'; sessionId: string; events: TimelineEvent[]; reset: boolean }
  | { type: 'frame'; frame: Frame }
  | { type: 'error'; sessionId?: string; message: string }

/** Control keys the server will forward. Anything else is rejected (INV-2). */
export const ALLOWED_KEYS = [
  'Enter', 'Escape', 'Tab', 'BSpace', 'Space',
  'Up', 'Down', 'Left', 'Right',
  'Home', 'End', 'PageUp', 'PageDown',
  'C-c', 'C-d', 'C-o', 'C-r', 'C-u',
] as const

/** Keys that can destroy work, so the UI must confirm before sending (INV-6). */
export const DESTRUCTIVE_KEYS = new Set(['C-c', 'C-d', 'Escape'])
