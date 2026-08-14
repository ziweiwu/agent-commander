/**
 * Turns a session's JSONL transcript into a readable timeline.
 *
 * INV-4: reads are incremental. The file is opened once and tailed by byte
 * offset; a live transcript is already 1.6 MB after a few hours, so re-reading
 * it on every tick would be the single most expensive thing this app does.
 */
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Agent, TimelineEvent } from '../shared/types.ts'

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')

/** On first read, only this much history is loaded. */
const BACKFILL_BYTES = 256 * 1024

/** Record types that carry no timeline meaning. */
const META_TYPES = new Set([
  'attachment',
  'mode',
  'permission-mode',
  'ai-title',
  'last-prompt',
  'file-history-delta',
  'file-history-snapshot',
  'summary',
  'system',
])

interface Block {
  type?: string
  text?: string
  name?: string
  input?: Record<string, unknown>
}

interface Record_ {
  type?: string
  timestamp?: string
  uuid?: string
  isSidechain?: boolean
  gitBranch?: string
  cwd?: string
  message?: { content?: string | Block[]; usage?: { output_tokens?: number } }
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

export interface ParseResult {
  events: TimelineEvent[]
  patch: Partial<Agent>
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
    if (META_TYPES.has(type)) continue

    const at = rec.timestamp ? Date.parse(rec.timestamp) : Number.NaN
    const when = Number.isFinite(at) ? at : Date.now()
    // 'HEAD' is what a non-repo or detached checkout reports; it tells the
    // user nothing, so it is not worth a slot on the card.
    if (rec.gitBranch && rec.gitBranch !== 'HEAD') patch.gitBranch = rec.gitBranch
    if (rec.cwd) patch.cwd = rec.cwd

    const usage = rec.message?.usage
    if (usage?.output_tokens) tokens += usage.output_tokens

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
    default:
      return trim(event.text)
  }
}

/** Incremental byte-offset tailer for one transcript file. */
export class TranscriptTail {
  #path: string | null = null
  #offset = 0
  #partial = ''
  #counter = 0
  #totalTokens = 0
  #totalSubagents = 0

  constructor(private readonly sessionId: string) {}

  get path(): string | null {
    return this.#path
  }

  /**
   * Read whatever is new. The first call backfills only the tail of the file
   * so that opening a long-running agent stays cheap.
   */
  async read(): Promise<ParseResult & { first: boolean }> {
    if (!this.#path) {
      this.#path = await findTranscript(this.sessionId)
      if (!this.#path) return { events: [], patch: {}, first: true }
    }

    let size: number
    try {
      size = (await stat(this.#path)).size
    } catch {
      return { events: [], patch: {}, first: false }
    }

    const first = this.#offset === 0
    if (first && size > BACKFILL_BYTES) {
      this.#offset = size - BACKFILL_BYTES
    }
    if (size < this.#offset) {
      // File was truncated or replaced; start over rather than emit garbage.
      this.#offset = 0
      this.#partial = ''
    }
    if (size === this.#offset) return { events: [], patch: {}, first }

    const length = size - this.#offset
    const buf = Buffer.allocUnsafe(length)
    const handle = await open(this.#path, 'r')
    try {
      await handle.read(buf, 0, length, this.#offset)
    } finally {
      await handle.close()
    }
    this.#offset = size

    const text = this.#partial + buf.toString('utf8')
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
    return { ...result, first }
  }
}
