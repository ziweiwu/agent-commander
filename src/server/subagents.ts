/**
 * Reading an agent's delegation tree off disk.
 *
 * **The structure is not derived — Claude Code writes it down.** Beside every
 * subagent transcript sits a sidecar naming the delegate's type, the brief it
 * was given, and its parent:
 *
 * ```
 * ~/.claude/projects/<slug>/<sessionId>/subagents/
 *   agent-<agentId>.jsonl        the delegate's own transcript
 *   agent-<agentId>.meta.json    {agentType, description, toolUseId,
 *                                 parentAgentId, spawnDepth}
 * ```
 *
 * Checked against 350 of them: every transcript has a sidecar and every sidecar
 * a transcript, `spawnDepth: 1` never carries `parentAgentId` and depth 2 and 3
 * always do. So the structure of a whole tree costs one `readdir` plus a few
 * hundred bytes each.
 *
 * The transcripts themselves *are* read, for one thing only: how much work each
 * delegate did (INV-13). That is affordable under INV-4 for the same reason the
 * sidecars are cached — a delegate that has gone quiet never writes again, so
 * its transcript is parsed once and then answered from memory forever. Only a
 * delegate that is still growing is re-read, and it is re-read because it is
 * the one that is changing. Measured on this machine: seven delegates, 1.9 MB,
 * 13 ms for the first pass and nothing at all after it.
 *
 * The directory is flat: a grandchild sits beside its parent. The tree is
 * rebuilt from `parentAgentId`, never from the path.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  Agent,
  AgentStatus,
  AgentTree,
  SubagentNode,
  SubagentState,
} from '../shared/types.ts'
import { hasTranscripts } from '../shared/agent-kinds.ts'

/** The shape of a sidecar, as far as anything here is willing to rely on it. */
interface Sidecar {
  agentType?: string
  description?: string
  name?: string
  parentAgentId?: string
  spawnDepth?: number
  stoppedByUser?: boolean
  isFork?: boolean
}

/**
 * A delegate that has written this recently is treated as still running.
 *
 * Only ever a *guess*, and it is marked as one. It is paired with the parent
 * being busy because on its own a recent write says nothing about whether the
 * work is continuing — a delegate that finished half a second ago also wrote
 * half a second ago.
 */
const ACTIVE_WINDOW_MS = 90_000

interface Entry {
  agentId: string
  meta: Sidecar
  lastWriteAt: number
  bytes: number
  effort: Effort | null
}

/**
 * What a delegate did, as opposed to what became of it.
 *
 * Two measurements, never a summary. `quiet` is the honest answer about a
 * delegate's *outcome* and will stay the answer for almost all of them, so it
 * cannot also be the only thing on the row: seven delegates all reading `quiet`
 * say nothing. These say the one thing that is both true and useful — that this
 * one worked for thirteen minutes and made twenty-nine tool calls, and that one
 * died on its first.
 */
interface Effort {
  calls: number
  workedMs: number
}

/**
 * Above this, the transcript is not parsed and the node carries no effort.
 *
 * A delegate that is still writing is re-read on every poll, so the cost of the
 * biggest one is paid over and over. The largest on this machine is 321 KB;
 * this leaves an order of magnitude of headroom and still bounds the work. A
 * node with no effort renders without it rather than with a zero, which would
 * be a claim that it did nothing (INV-11).
 */
const EFFORT_MAX_BYTES = 4 * 1024 * 1024

/**
 * Parsed transcripts, keyed by what would have to change for the answer to.
 *
 * Size as well as mtime, because a second-granularity clock and an append can
 * land in the same tick.
 */
const efforts = new Map<string, Effort>()

/** Testing seam: forget what was cached. */
export function forgetEfforts(): void {
  efforts.clear()
}

/**
 * How much work is recorded in one delegate's transcript, read at most once.
 *
 * Every failure returns null and the node simply carries no effort: a file that
 * vanished, one too large to keep re-reading, a transcript in a shape this does
 * not recognise. None of them is a reason to lose the node (INV-5) — and a null
 * is deliberately not cached, so a file being written as it was read is
 * reconsidered rather than written off.
 */
async function readEffort(path: string, mtimeMs: number, bytes: number): Promise<Effort | null> {
  if (bytes > EFFORT_MAX_BYTES) return null
  const key = `${path}:${mtimeMs}:${bytes}`
  const cached = efforts.get(key)
  if (cached) return cached

  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return null
  }

  const effort = measure(text)
  if (effort) efforts.set(key, effort)
  return effort
}

/**
 * The counting itself, over one transcript's text.
 *
 * Counts `tool_use` blocks rather than messages, because a turn that read nine
 * files and a turn that said "ok" are not the same amount of work. The span is
 * between the first and last record carrying a timestamp — not a duration the
 * delegate reported, which nothing does.
 */
function measure(text: string): Effort | null {
  let calls = 0
  let records = 0
  let first = 0
  let last = 0
  for (const line of text.split('\n')) {
    if (line === '') continue
    let record: TranscriptRecord
    try {
      record = JSON.parse(line) as TranscriptRecord
    } catch {
      // A tail being appended to as it is read ends in a partial line.
      continue
    }
    records += 1
    const at = Date.parse(record.timestamp ?? '')
    if (!Number.isNaN(at)) {
      if (first === 0) first = at
      last = at
    }
    if (record.type !== 'assistant') continue
    for (const block of record.message?.content ?? []) {
      if (block.type === 'tool_use') calls += 1
    }
  }

  /*
   * Nothing parsed, so this is not a transcript this code understands — an
   * empty file, or a format that has moved. Reporting `0 calls` for it would
   * say "I read it and nothing happened", which is a different and unearned
   * claim. `0 calls` is kept for the case where a transcript really was read
   * and really held none.
   */
  if (records === 0) return null
  return { calls, workedMs: last > first ? last - first : 0 }
}

/** Only the parts of a transcript record this file looks at. */
interface TranscriptRecord {
  type?: string
  timestamp?: string
  message?: { content?: { type?: string }[] }
}

/**
 * Sidecars, cached by path forever.
 *
 * They are written once when the delegate is spawned and never touched again —
 * a type, a brief and a parent do not change — so re-reading one on every poll
 * would be pure cost. Only the transcript is re-`stat`ed.
 */
const sidecars = new Map<string, Sidecar>()

/** Testing seam: forget what was cached. */
export function forgetSidecars(): void {
  sidecars.clear()
}

async function readSidecar(path: string): Promise<Sidecar | null> {
  const cached = sidecars.get(path)
  if (cached) return cached
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Sidecar
    // A half-written sidecar parses to something that is not an object, and
    // one delegate's malformed file must not cost the whole tree (INV-5).
    if (typeof parsed !== 'object' || parsed === null) return null
    sidecars.set(path, parsed)
    return parsed
  } catch {
    return null
  }
}

/** Every delegate of one session, unordered and unlinked. */
async function readEntries(dir: string): Promise<Entry[]> {
  /*
   * `stat` before `readdir`, exactly as `subagentActivityAt` does: most agents
   * never delegate, and the common case should cost one syscall (INV-4).
   */
  try {
    await stat(dir)
  } catch {
    return []
  }
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }

  const entries: Entry[] = []
  for (const name of names) {
    const agentId = /^agent-(.+)\.jsonl$/.exec(name)?.[1]
    if (agentId === undefined) continue
    const meta = await readSidecar(join(dir, `agent-${agentId}.meta.json`))
    if (!meta) continue
    try {
      const path = join(dir, name)
      const transcript = await stat(path)
      entries.push({
        agentId,
        meta,
        lastWriteAt: transcript.mtimeMs,
        bytes: transcript.size,
        effort: await readEffort(path, transcript.mtimeMs, transcript.size),
      })
    } catch {
      // Vanished between readdir and stat; nothing to learn from it.
    }
  }
  return entries
}

/**
 * What this app is willing to say a delegate is doing.
 *
 * INV-13, and the ordering matters: evidence first, then a marked guess, then
 * an admission. `done` is only ever claimed on something recorded — the user
 * stopped it — because an agent that finished and an agent that died look
 * identical from a transcript that stopped growing.
 */
function stateOf(
  entry: Entry,
  parentStatus: AgentStatus,
  now: number,
): { state: SubagentState; stateInferred?: boolean } {
  if (entry.meta.stoppedByUser === true) return { state: 'done' }
  if (parentStatus === 'busy' && now - entry.lastWriteAt < ACTIVE_WINDOW_MS) {
    return { state: 'active', stateInferred: true }
  }
  return { state: 'quiet' }
}

/** One sidecar as a node of its own, still unattached to any parent. */
function toNode(entry: Entry, parentStatus: AgentStatus, now: number): SubagentNode {
  const meta = entry.meta
  return {
    agentId: entry.agentId,
    // A forked skill carries `name` instead of a subagent type. Neither is
    // guaranteed, and a node with no label is still a node.
    agentType: meta.agentType ?? meta.name ?? 'agent',
    description: meta.description ?? '',
    depth: typeof meta.spawnDepth === 'number' ? meta.spawnDepth : 1,
    ...(meta.parentAgentId !== undefined ? { parentAgentId: meta.parentAgentId } : {}),
    lastWriteAt: entry.lastWriteAt,
    bytes: entry.bytes,
    ...(entry.effort ? { calls: entry.effort.calls, workedMs: entry.effort.workedMs } : {}),
    ...stateOf(entry, parentStatus, now),
    ...(meta.stoppedByUser === true ? { stoppedByUser: true } : {}),
    children: [],
  }
}

/**
 * Whether attaching `node` to `parent` would close a loop.
 *
 * Real data cannot produce one — `spawnDepth` only ever increases — but this
 * reads files nothing validates, and a loop is the one malformed shape that
 * loses data *silently*: two nodes naming each other end up in each other's
 * children, neither is a root, and the whole branch disappears from the view
 * with no error anywhere. That is precisely the failure the re-parenting rule
 * exists to prevent, so it has to hold for a loop as well as for an absent
 * parent.
 */
function wouldLoop(
  node: SubagentNode,
  parent: SubagentNode,
  byId: Map<string, SubagentNode>,
): boolean {
  let at: SubagentNode | undefined = parent
  for (let steps = 0; at && steps <= byId.size; steps += 1) {
    if (at === node) return true
    at = at.parentAgentId ? byId.get(at.parentAgentId) : undefined
  }
  return false
}

/**
 * Assemble the flat list into a tree.
 *
 * **An unresolvable parent is raised to the top, never dropped.** A sidecar
 * that is missing or half-written takes its whole subtree with it if children
 * are only ever attached to a parent that exists, and silently losing a branch
 * is a worse failure than showing one at the wrong depth (INV-5). `reparented`
 * marks it so the interface can say what happened rather than quietly lying
 * about the shape of the work.
 */
function assemble(entries: Entry[], parentStatus: AgentStatus, now: number): SubagentNode[] {
  const byId = new Map<string, SubagentNode>()
  for (const entry of entries) byId.set(entry.agentId, toNode(entry, parentStatus, now))

  const roots: SubagentNode[] = []
  for (const node of byId.values()) {
    const parent = node.parentAgentId ? byId.get(node.parentAgentId) : undefined
    if (parent && !wouldLoop(node, parent, byId)) {
      parent.children.push(node)
      continue
    }
    if (node.parentAgentId !== undefined) node.reparented = true
    roots.push(node)
  }

  // Oldest first, so a tree reads in the order the work was handed out.
  const byStart = (left: SubagentNode, right: SubagentNode): number =>
    left.lastWriteAt - right.lastWriteAt
  for (const node of byId.values()) node.children.sort(byStart)
  roots.sort(byStart)
  return roots
}

/**
 * One agent's delegates.
 *
 * `transcriptPath` is the agent's own transcript, which is what names the
 * directory the delegates live in. Without one there is nothing to read, and
 * for a CLI that keeps no transcript at all that is *absence of evidence*: the
 * tree comes back `unknown` rather than empty, because "has not delegated" is a
 * claim this app would have no way to make (INV-11).
 */
export async function readTree(
  agent: Agent,
  transcriptPath: string | null,
  now = Date.now(),
): Promise<AgentTree> {
  if (!hasTranscripts(agent.agentKind)) {
    return { sessionId: agent.sessionId, children: [], unknown: true }
  }
  if (!transcriptPath) return { sessionId: agent.sessionId, children: [] }

  const dir = join(dirname(transcriptPath), agent.sessionId, 'subagents')
  const entries = await readEntries(dir)
  return {
    sessionId: agent.sessionId,
    children: assemble(entries, agent.status, now),
  }
}
