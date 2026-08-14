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
}

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
