/** Wire types shared by the server and the browser client. */

export type AgentStatus = 'busy' | 'idle' | 'waiting' | 'unknown'

/** One agent CLI session, as presented to the UI. */
export interface Agent {
  sessionId: string
  pid: number
  name: string
  cwd: string
  /** Basename of cwd, precomputed for the card header. */
  folder: string
  status: AgentStatus
  /**
   * The status above was derived by this app rather than reported by the agent.
   *
   * INV-11: the dashboard never asserts more than it knows. A Claude session
   * says "waiting, dialog open" about itself; a tmux-discovered agent only ever
   * shows whether its pane has produced output lately, which is a far weaker
   * claim wearing the same word. The card labels it so the two are not read as
   * equals.
   */
  statusInferred?: boolean
  /** Why the agent is blocked, e.g. "dialog open". Only set when status is waiting. */
  waitingFor?: string
  /**
   * Which agent CLI this is — see `shared/agent-kinds.ts`.
   *
   * Required, not optional, so every construction site has to say: a silent
   * `undefined` here reaches a capability lookup and quietly denies everything.
   * Distinct from `kind` below, which is Claude Code's own word for what sort
   * of session it is (`interactive`/`background`) and means nothing elsewhere.
   */
  agentKind: string
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
  /**
   * The version of the server answering, compiled into it.
   *
   * Optional on the wire because a server built before this existed answers
   * without it, and a dashboard that showed "undefined" would be worse than one
   * that shows nothing.
   */
  version?: string
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

/** One choice in a prompt the agent is blocked on. */
export interface PromptOption {
  label: string
  description?: string
}

/**
 * A question the agent is waiting on, read out of its own transcript.
 *
 * Claude Code flushes a tool call before the dialog it raises is answered, so
 * an `AskUserQuestion` still waiting for a reply is on disk in full — question,
 * options, and whether it takes more than one. That is the only reason this app
 * may name an option at all: it is *read*, never inferred from the screen.
 *
 * The other blocked shapes are deliberately thinner. `ExitPlanMode` writes its
 * plan but not the three approval choices, which the CLI composes; a tool
 * permission request writes the tool and its input but not the numbered list.
 * There `options` is absent and the interface offers keys rather than labels it
 * would have had to invent (INV-16).
 */
export interface PendingPrompt {
  /** The tool that raised it — `AskUserQuestion`, `ExitPlanMode`, or another. */
  tool: string
  question?: string
  /** Only ever what the transcript named. Absent means "not knowable here". */
  options?: PromptOption[]
  /** True when the picker takes several answers, so one digit cannot finish it. */
  multiSelect?: boolean
  /** How many questions this one call still asks after the first. */
  moreQuestions?: number
  /** Reference text: the plan under review, or the command being asked about. */
  detail?: string
  /**
   * Identity of *this* question, echoed back on the answer.
   *
   * Derived by the server from the prompt's own content, so it survives a
   * restart and needs nothing stored. An answer carrying a stale id is refused
   * rather than typed into whatever the pane is showing by then — see
   * `PendingPrompt::fingerprint` and INV-2.
   */
  id?: string
}

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
  /**
   * For `kind === 'notice'`: which notice this is, so the client names it in
   * the reader's language rather than displaying a sentence the server wrote.
   */
  notice?: 'compacted' | 'compactedAuto'
  /** Context tokens either side of a compaction, for the notice above. */
  tokensBefore?: number
  tokensAfter?: number
}

/**
 * What a delegate is doing, and how much of that this app actually knows.
 *
 * Three states rather than two, and the third is the point (INV-13). An agent
 * that finished and an agent that died both stop writing; nothing on disk
 * separates them, so `quiet` is its own answer and is never drawn as `done`.
 * That is the same absence-of-evidence rule INV-11 already applies to an
 * inferred status on a fleet card.
 */
export type SubagentState = 'active' | 'quiet' | 'done'

/** One delegate in an agent's tree, and everything below it. */
export interface SubagentNode {
  /** Claude Code's own id for the delegate; the transcript is named after it. */
  agentId: string
  /** The subagent type, e.g. `general-purpose`, or a forked skill's name. */
  agentType: string
  /** The one-line brief the parent gave it. */
  description: string
  /** 1 for a delegate of the session itself, 2 for a delegate of a delegate. */
  depth: number
  parentAgentId?: string
  /** When its transcript was last written to. */
  lastWriteAt: number
  /** Transcript size. A coarse "how much work", never a percentage of anything. */
  bytes: number
  /**
   * Tool calls recorded in its transcript, and the span it worked over.
   *
   * What it *did*, as against `state`, which is what became of it. Both are
   * needed because `state` is almost always `quiet` — the honest answer, and an
   * uninformative one on its own (INV-13). Absent when the transcript could not
   * be read or is too large to keep re-reading; a node then renders without
   * them rather than with a zero, which would claim it did nothing.
   */
  calls?: number
  workedMs?: number
  state: SubagentState
  /**
   * The state was worked out here rather than reported (INV-11).
   *
   * Set on `active`, which is a guess from a recent write and a busy parent,
   * and never on `done`, which is only ever claimed on evidence.
   */
  stateInferred?: boolean
  /** The user stopped it. Evidence of an ending, so the state is `done`. */
  stoppedByUser?: boolean
  /**
   * Its parent id named a delegate that is not on disk, so it was raised to the
   * top of the tree rather than dropped along with everything under it.
   */
  reparented?: boolean
  children: SubagentNode[]
}

/** One agent's delegates. `children` is empty for an agent that never delegated. */
export interface AgentTree {
  sessionId: string
  children: SubagentNode[]
  /**
   * This app cannot tell whether this agent has delegated at all.
   *
   * True for a CLI that keeps no transcript: the evidence lives in files it
   * does not write, so an empty tree here is absence of evidence rather than
   * evidence of absence, and must not read as "delegated nothing".
   */
  unknown?: boolean
}

/** The whole fleet's delegation graph, as served by `GET /api/tree`. */
export interface FleetTree {
  trees: AgentTree[]
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
  /**
   * `seq` is optional and is echoed back as a `paste-ack`. The Attach view
   * uses it to keep exactly one paste in flight, so a burst of typing arrives
   * as however many chunks tmux can actually absorb rather than as one write
   * per character queueing up behind the last.
   */
  | { type: 'paste'; sessionId: string; text: string; submit: boolean; seq?: number }
  /**
   * `confirmed` is set only when the user answered a confirmation dialog for a
   * key on `DESTRUCTIVE_KEYS`. The server refuses those keys without it, so the
   * guard is a boundary rather than a UI convention (INV-6).
   */
  | { type: 'key'; sessionId: string; key: string; confirmed?: boolean }
  /**
   * Answer the prompt an agent is blocked on. `choice` indexes the options the
   * transcript named; the server composes the keystroke, and refuses outright
   * if `promptId` no longer matches the question on disk.
   */
  | { type: 'answer'; sessionId: string; promptId: string; choice: number }

/* ---- server -> client ---- */

export type ServerMessage =
  | { type: 'fleet'; agents: Agent[]; mock: boolean }
  | { type: 'limits'; limits: RateLimits | null }
  | {
      type: 'timeline'
      sessionId: string
      events: TimelineEvent[]
      reset: boolean
      /** What this agent is blocked on, when its transcript says (INV-16). */
      prompt?: PendingPrompt
    }
  | { type: 'frame'; frame: Frame }
  /**
   * A paste has finished being written to tmux, successfully or not. It is a
   * flow-control signal and nothing else: it never causes anything to be sent
   * again (INV-2), it only tells the client the pipe is free.
   */
  | { type: 'paste-ack'; sessionId: string; seq: number }
  /*
   * `kind` names the condition; `message` is only how to say it. A client that
   * has to match the prose cannot survive the prose being reworded — and the
   * pane-exit case is the one state a viewer has to react to structurally,
   * because INV-1 means there is no pty to report the exit any other way.
   */
  | { type: 'error'; sessionId?: string; message: string; kind?: 'pane-exited' }

/**
 * Control keys the server will forward. Anything else is rejected (INV-2).
 *
 * The digits are how a numbered choice is answered. Claude Code's pickers are
 * numbered, and a digit selects the option it labels wherever the cursor
 * happens to be — which is why they are here rather than arrow keys: a relative
 * move has to assume where the highlight started, and being wrong about that
 * answers a different question than the one the user read.
 */
export const ALLOWED_KEYS = [
  'Enter', 'Escape', 'Tab', 'BSpace', 'Space',
  'Up', 'Down', 'Left', 'Right',
  'Home', 'End', 'PageUp', 'PageDown',
  'C-c', 'C-d', 'C-o', 'C-r', 'C-u',
  '1', '2', '3', '4', '5', '6', '7', '8', '9',
] as const

/** Keys that can destroy work, so the UI must confirm before sending (INV-6). */
export const DESTRUCTIVE_KEYS = new Set(['C-c', 'C-d', 'Escape'])

/*
 * The option lists, in the one module both sides import.
 *
 * These lived in three places each: `server/options.ts` validated them,
 * `AgentControls.tsx` and `NewAgentDialog.tsx` offered them, and
 * `web/lib/modes.ts` labelled them. Drift between those copies is asymmetric
 * and both directions are bad — a model the server accepts but no UI offers is
 * simply invisible, and one the UI offers but the server rejects is a click
 * that turns into a toast. `ALLOWED_KEYS` above already proved the pattern.
 *
 * Only the values live here. How they are *labelled* stays in the web layer,
 * which is where translation belongs.
 */

/** Model aliases the CLI accepts, and the only ones this app will pass on. */
export const MODEL_ALIASES = ['default', 'opus', 'sonnet', 'haiku', 'fable', 'opusplan'] as const
export type ModelAlias = (typeof MODEL_ALIASES)[number]

/**
 * Permission modes in the order Shift+Tab cycles them, per the CLI's own
 * documentation: `default → acceptEdits → plan → bypassPermissions → auto`,
 * where the last two appear only when available in that session.
 */
export const MODE_CYCLE = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto'] as const
export type PermissionMode = (typeof MODE_CYCLE)[number]

/** Modes settable at spawn time. `dontAsk` is reachable by flag but never cycles. */
export const SPAWN_MODES = [...MODE_CYCLE, 'dontAsk'] as const
