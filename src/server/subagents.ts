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
 * always do. So a whole tree costs one `readdir` plus a few hundred bytes each,
 * with no transcript parsing at all — which is what makes this affordable to
 * poll under INV-4.
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
      const transcript = await stat(join(dir, name))
      entries.push({ agentId, meta, lastWriteAt: transcript.mtimeMs, bytes: transcript.size })
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
