/**
 * Turns a session's JSONL transcript into a readable timeline.
 *
 * INV-4: reads are incremental. The file is opened once and tailed by byte
 * offset; a live transcript is already 1.6 MB after a few hours, so re-reading
 * it on every tick would be the single most expensive thing this app does.
 */
import { open, readdir, stat } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Agent, GoalState, TimelineEvent } from '../shared/types.ts'

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')

/** On first read, only this much history is loaded. */
const BACKFILL_BYTES = 256 * 1024

/** Record types that carry no timeline meaning. */
const META_TYPES = new Set([
  'attachment',
  'mode',
  'file-history-delta',
  'file-history-snapshot',
  'summary',
  'system',
])

/**
 * Records that are not conversation, but do carry session state the fleet view
 * needs: which permission mode the agent is in, and the title it generated for
 * itself — far more use than an auto-derived name like `ziweiwu-35`.
 */
const STATE_TYPES = new Set(['permission-mode', 'ai-title', 'last-prompt'])

interface Block {
  type?: string
  text?: string
  name?: string
  input?: Record<string, unknown>
}

interface Record_ {
  type?: string
  subtype?: string
  compactMetadata?: { trigger?: string; preTokens?: number; postTokens?: number }
  timestamp?: string
  uuid?: string
  isSidechain?: boolean
  gitBranch?: string
  cwd?: string
  permissionMode?: string
  aiTitle?: string
  lastPrompt?: string
  message?: { content?: string | Block[]; usage?: { output_tokens?: number }; model?: string }
  attachment?: GoalAttachment
}

/**
 * The `goal_status` attachment Claude Code writes for `/goal`.
 *
 * `sentinel` marks the record written when the goal is set, before anything has
 * evaluated it; the later records carry the evaluator's `reason` instead.
 */
interface GoalAttachment {
  type?: string
  met?: boolean
  sentinel?: boolean
  condition?: string
  reason?: string
}

/**
 * Locate a session's transcript by scanning project directories for the
 * session id, rather than deriving the directory name from cwd — a session
 * that changed directory still resolves correctly.
 */
export async function findTranscript(
  sessionId: string,
  root = PROJECTS_DIR,
): Promise<string | null> {
  let dirs: string[]
  try {
    dirs = await readdir(root)
  } catch {
    return null
  }
  const file = `${sessionId}.jsonl`
  for (const dir of dirs) {
    const candidate = join(root, dir, file)
    try {
      await stat(candidate)
      return candidate
    } catch {
      // not in this project directory
    }
  }
  return null
}

/**
 * When a subagent of this session last wrote, or null if none is running.
 *
 * A delegated run writes to `<project>/<sessionId>/subagents/*.jsonl` while the
 * session's own transcript sits still, so this is the only evidence that the
 * agent is working rather than stuck.
 *
 * The directory is stat-ed before it is read: most agents never delegate, and
 * that keeps the common case at one syscall per poll (INV-4).
 */
export async function subagentActivityAt(
  transcriptPath: string,
  sessionId: string,
): Promise<number | null> {
  const dir = join(dirname(transcriptPath), sessionId, 'subagents')
  try {
    await stat(dir)
  } catch {
    return null
  }
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return null
  }
  let newest = 0
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    try {
      const info = await stat(join(dir, name))
      if (info.mtimeMs > newest) newest = info.mtimeMs
    } catch {
      // Vanished between readdir and stat; nothing to learn from it.
    }
  }
  return newest > 0 ? newest : null
}

/** One-line description of a tool call, chosen per tool. */
export function summarizeTool(name: string, input: Record<string, unknown> | undefined): string {
  const str = (key: string): string | undefined => {
    const value = input?.[key]
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }
  const firstLine = (value: string): string => (value.split('\n')[0] ?? '').trim()
  switch (name) {
    case 'Bash':
      return str('description') ?? firstLine(str('command') ?? '')
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return str('file_path') ?? ''
    case 'Grep':
      return str('pattern') ?? ''
    case 'Glob':
      return str('pattern') ?? ''
    case 'Task':
    case 'Agent':
      return str('description') ?? firstLine(str('prompt') ?? '')
    case 'WebFetch':
    case 'WebSearch':
      return str('url') ?? str('query') ?? ''
    default: {
      const desc = str('description') ?? str('file_path') ?? str('pattern') ?? str('command')
      return desc ? firstLine(desc) : ''
    }
  }
}

/** Tools that mean this agent has delegated work to subagents. */
const SUBAGENT_TOOLS = new Set(['Task', 'Agent', 'Workflow'])

/**
 * Read a goal record, if this line is one.
 *
 * Returned rather than assigned so both the tailer and the one-shot reader
 * below agree on what a `goal_status` record means, down to the timestamp.
 */
export function goalFromRecord(rec: {
  type?: string
  timestamp?: string
  attachment?: GoalAttachment
}): GoalState | null {
  const att = rec.attachment
  if (rec.type !== 'attachment' || att?.type !== 'goal_status') return null
  const condition = typeof att.condition === 'string' ? att.condition : ''
  if (condition.length === 0) return null
  const at = rec.timestamp ? Date.parse(rec.timestamp) : Number.NaN
  const goal: GoalState = {
    condition,
    met: att.met === true,
    at: Number.isFinite(at) ? at : Date.now(),
  }
  if (typeof att.reason === 'string' && att.reason.length > 0) goal.reason = att.reason
  if (att.sentinel === true) goal.fresh = true
  return goal
}

export interface ParseResult {
  events: TimelineEvent[]
  patch: Partial<Agent>
}

/** A record's own timestamp, falling back to now when it has none or it is junk. */
function stamp(raw: string | undefined): number {
  const at = raw ? Date.parse(raw) : Number.NaN
  return Number.isFinite(at) ? at : Date.now()
}

/** Convert raw JSONL lines into timeline events plus a fleet-card patch. */
export function parseLines(lines: string[], seq: () => string): ParseResult {
  const events: TimelineEvent[] = []
  const patch: Partial<Agent> = {}
  let tokens = 0
  let subagents = 0

  for (const line of lines) {
    if (line.trim().length === 0) continue
    let rec: Record_
    try {
      rec = JSON.parse(line) as Record_
    } catch {
      continue // a torn final line; the tailer will re-read it once complete
    }
    const type = rec.type ?? ''

    if (STATE_TYPES.has(type)) {
      // Last write wins: these are emitted repeatedly and the newest is current.
      if (rec.permissionMode) patch.permissionMode = rec.permissionMode
      if (rec.aiTitle) patch.aiTitle = rec.aiTitle
      if (rec.lastPrompt) patch.lastPrompt = rec.lastPrompt
      continue
    }
    // Attachments carry no timeline meaning, but this one carries session
    // state: the goal the session is working towards. Last write wins, the
    // same way permission mode does.
    const goal = goalFromRecord(rec)
    if (goal) patch.goal = goal

    /*
     * A compaction, read before the `system` records are skipped as meta.
     *
     * This is the only thing this app can ever know about `/compact`. The
     * request itself is unobservable — it is text pasted into a prompt — and
     * the work runs for minutes (`durationMs: 157676` in the one real sample),
     * so the button that asks for it cannot wait and does not claim it
     * happened. This record is Claude Code saying it did, with the numbers.
     *
     * `trigger` is kept because the two are different news: one the user asked
     * for, and one the CLI did on its own because the window filled. The
     * second is exactly the sort of thing a dashboard exists to surface.
     */
    if (type === 'system' && rec.subtype === 'compact_boundary') {
      const meta = rec.compactMetadata
      events.push({
        id: seq(),
        at: stamp(rec.timestamp),
        kind: 'notice',
        text: '',
        notice: meta?.trigger === 'manual' ? 'compacted' : 'compactedAuto',
        ...(typeof meta?.preTokens === 'number' ? { tokensBefore: meta.preTokens } : {}),
        ...(typeof meta?.postTokens === 'number' ? { tokensAfter: meta.postTokens } : {}),
      })
      continue
    }

    if (META_TYPES.has(type)) continue

    const when = stamp(rec.timestamp)
    // 'HEAD' is what a non-repo or detached checkout reports; it tells the
    // user nothing, so it is not worth a slot on the card.
    if (rec.gitBranch && rec.gitBranch !== 'HEAD') patch.gitBranch = rec.gitBranch
    if (rec.cwd) patch.cwd = rec.cwd

    const usage = rec.message?.usage
    if (usage?.output_tokens) tokens += usage.output_tokens
    // The model can change mid-session via /model, so the latest wins.
    if (rec.message?.model) patch.model = rec.message.model

    const content = rec.message?.content
    const sidechain = rec.isSidechain === true

    if (type === 'user') {
      if (typeof content === 'string') {
        const text = content.trim()
        if (text.length > 0) {
          events.push({ id: seq(), at: when, kind: 'user', text, sidechain })
        }
      }
      // Array content on a user record is tool_result plumbing; not shown.
      continue
    }

    if (type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text?.trim()) {
          events.push({
            id: seq(),
            at: when,
            kind: 'assistant',
            text: block.text.trim(),
            sidechain,
          })
        } else if (block.type === 'tool_use' && block.name) {
          const isSub = SUBAGENT_TOOLS.has(block.name)
          if (isSub) subagents += 1
          events.push({
            id: seq(),
            at: when,
            kind: isSub ? 'subagent' : 'tool',
            tool: block.name,
            text: summarizeTool(block.name, block.input),
            sidechain,
          })
        }
        // 'thinking' blocks are intentionally omitted from the timeline.
      }
    }
  }

  const last = events.at(-1)
  if (last) {
    patch.activity = describe(last)
    patch.lastActivityAt = last.at
  }
  if (tokens > 0) patch.tokens = tokens
  if (subagents > 0) patch.subagents = subagents
  return { events, patch }
}

/** The one-line "what is it doing" string shown on a fleet card. */
export function describe(event: TimelineEvent): string {
  const trim = (s: string, n = 80): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
  switch (event.kind) {
    case 'tool':
      return trim(event.text ? `${event.tool}: ${event.text}` : (event.tool ?? 'tool'))
    case 'subagent':
      return trim(event.text ? `${event.tool} → ${event.text}` : 'delegating to subagent')
    case 'user':
      return trim(`you: ${event.text}`)
    case 'notice':
      // The card has no room for the token pair and no i18n; the timeline
      // carries the detail.
      return event.notice === 'compactedAuto' ? 'compacted automatically' : 'compacted'
    default:
      return trim(event.text)
  }
}

/** Incremental byte-offset tailer for one transcript file. */
export class TranscriptTail {
  #path: string | null = null
  /** When this agent itself last wrote, as opposed to a subagent of it. */
  #lastEventAt = 0
  #offset = 0
  #partial = ''
  /**
   * Holds a multi-byte character that a read stopped in the middle of.
   *
   * The offset this tails by is a byte count, and the poll lands wherever the
   * file happens to have got to — so a three-byte character can be split
   * across two reads. Decoding each chunk as an independent string turned that
   * into two U+FFFD replacements: "检查一下" came back as "��查一下"
   * for any conversation not written in ASCII, which this app has a Chinese
   * locale for. The decoder holds the incomplete bytes back until the rest of
   * them arrive.
   */
  #decoder = new StringDecoder('utf8')
  #counter = 0
  #totalTokens = 0
  #totalSubagents = 0
  /**
   * Whether a full backfill has been handed over yet.
   *
   * `first` tells the client to replace what it has rather than append, so it
   * must not be raised again by a transcript that has merely gone missing —
   * that would blank a conversation the user is reading, once per poll.
   */
  #backfilled = false

  constructor(
    private readonly sessionId: string,
    /** Where to look for the transcript; overridden by tests. */
    private readonly root: string = PROJECTS_DIR,
  ) {}

  get path(): string | null {
    return this.#path
  }

  /**
   * Whether a subagent is working while this agent waits, and a last-activity
   * time that says so.
   *
   * Without this the clock freezes at the moment work was handed off, so a
   * healthy delegated run reads as "18m ago" and looks exactly like an agent
   * that has silently died — the one thing this dashboard exists to catch.
   */
  async #delegation(): Promise<Partial<Agent>> {
    if (!this.#path) return {}
    const at = await subagentActivityAt(this.#path, this.sessionId)
    if (at === null || at <= this.#lastEventAt) return { delegating: false }
    return { delegating: true, lastActivityAt: at }
  }

  /**
   * Read whatever is new. The first call backfills only the tail of the file
   * so that opening a long-running agent stays cheap.
   */
  async read(): Promise<ParseResult & { first: boolean }> {
    if (!this.#path) {
      this.#path = await findTranscript(this.sessionId, this.root)
      if (!this.#path) return { events: [], patch: {}, first: !this.#backfilled }
    }

    let size: number
    try {
      size = (await stat(this.#path)).size
    } catch {
      /*
       * The file moved, was rotated, or is briefly unreadable. The path was
       * resolved once and cached, so holding on to it meant every later read
       * failed the same way and that agent's timeline was dead for the life of
       * the process. Dropping it costs one directory scan and lets the next
       * read find where the transcript went.
       */
      this.#path = null
      return { events: [], patch: {}, first: false }
    }

    let first = this.#offset === 0
    if (first && size > BACKFILL_BYTES) {
      this.#offset = size - BACKFILL_BYTES
    }
    if (size < this.#offset) {
      // File was truncated or replaced; start over rather than emit garbage.
      // This is a replacement, not a continuation: without saying so, the
      // client appends the whole file to the copy it already has.
      this.#offset = 0
      this.#partial = ''
      this.#decoder = new StringDecoder('utf8')
      first = true
    }
    // Checked even when the transcript has not grown by a byte: that silence is
    // exactly what a delegated run looks like from here.
    if (size === this.#offset) {
      if (first) this.#backfilled = true
      return { events: [], patch: await this.#delegation(), first }
    }

    const length = size - this.#offset
    const buf = Buffer.allocUnsafe(length)
    const handle = await open(this.#path, 'r')
    try {
      await handle.read(buf, 0, length, this.#offset)
    } finally {
      await handle.close()
    }
    this.#offset = size

    // Decoded through the tailer's own decoder, so a character split across
    // this read and the next survives it.
    const text = this.#partial + this.#decoder.write(buf)
    const lines = text.split('\n')
    // The last element is either '' (clean boundary) or a torn record.
    this.#partial = lines.pop() ?? ''

    // A backfill starts mid-file, so the first line is almost certainly torn.
    if (first && lines.length > 0 && this.#offset > length) lines.shift()

    const result = parseLines(lines, () => `${this.sessionId}:${this.#counter++}`)
    this.#totalTokens += result.patch.tokens ?? 0
    this.#totalSubagents += result.patch.subagents ?? 0
    if (this.#totalTokens > 0) result.patch.tokens = this.#totalTokens
    if (this.#totalSubagents > 0) result.patch.subagents = this.#totalSubagents
    if (result.patch.lastActivityAt !== undefined) this.#lastEventAt = result.patch.lastActivityAt
    Object.assign(result.patch, await this.#delegation())
    if (first) this.#backfilled = true
    return { ...result, first }
  }
}

/** Bytes of the transcript tail scanned when reading current session state. */
const STATE_TAIL_BYTES = 128 * 1024

/**
 * Read the permission mode a session reports right now.
 *
 * Used to verify a mode switch landed, so it reads the file directly rather
 * than waiting for the 5s enrichment tick. Only the tail is scanned: these
 * records are written on every turn, so the newest is always near the end.
 */
async function readStateTail(sessionId: string, root: string): Promise<string[]> {
  const path = await findTranscript(sessionId, root)
  if (!path) return []

  let size: number
  try {
    size = (await stat(path)).size
  } catch {
    return []
  }

  const start = Math.max(0, size - STATE_TAIL_BYTES)
  const length = size - start
  if (length <= 0) return []

  const buf = Buffer.allocUnsafe(length)
  const handle = await open(path, 'r')
  try {
    await handle.read(buf, 0, length, start)
  } finally {
    await handle.close()
  }
  return buf.toString('utf8').split('\n')
}

export async function readPermissionMode(
  sessionId: string,
  root = PROJECTS_DIR,
): Promise<string | undefined> {
  const lines = await readStateTail(sessionId, root)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]
    if (!line || !line.includes('"permission-mode"')) continue
    try {
      const rec = JSON.parse(line) as { type?: string; permissionMode?: string }
      if (rec.type === 'permission-mode' && rec.permissionMode) return rec.permissionMode
    } catch {
      // A torn line at the head of the window; keep looking backwards.
    }
  }
  return undefined
}

/**
 * Read the goal a session reports right now.
 *
 * Used to verify that a `/goal` actually landed, so — like the mode reader —
 * it goes to the file rather than waiting for the 5s enrichment tick. Only
 * `goal_status` records are parsed, and only the newest one counts: it is
 * either the set-sentinel, the latest rejection, or the verdict that ended the
 * goal.
 */
export async function readGoal(
  sessionId: string,
  root = PROJECTS_DIR,
): Promise<GoalState | undefined> {
  const lines = await readStateTail(sessionId, root)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]
    if (!line || !line.includes('"goal_status"')) continue
    try {
      const goal = goalFromRecord(JSON.parse(line) as Record_)
      if (goal) return goal
    } catch {
      // A torn line at the head of the window; keep looking backwards.
    }
  }
  return undefined
}
