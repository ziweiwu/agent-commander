/**
 * Working out what to call an agent.
 *
 * Claude Code names an unnamed session after the user and a couple of hex
 * digits — `ziweiwu-35`, `projects-ef`. Nine of those in a list are nine
 * identical labels. Every session carries better material than that, so this
 * picks the most descriptive thing available.
 */
import type { Agent } from '../../shared/types.ts'

/** Longest a generated label may be before it is cut. */
const MAX_LABEL = 72

/**
 * Did Claude Code invent this name, or did someone choose it?
 *
 * The session file answers this directly with `nameSource: "derived"`, which is
 * carried through as `derivedName`. The shape check is only a fallback for
 * records that predate the field or have not registered yet — and it is a
 * guess, which is why it never overrides the real signal.
 */
export function isDerivedName(agent: Pick<Agent, 'name' | 'derivedName'>): boolean {
  if (typeof agent.derivedName === 'boolean') return agent.derivedName
  return /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{2,3}$/i.test(agent.name)
}

function clip(text: string, max = MAX_LABEL): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

/** Where the displayed name came from, so the UI can caption it honestly. */
export type NameSource = 'given' | 'title' | 'prompt'

export interface DisplayName {
  label: string
  source: NameSource
}

/**
 * Best available label, in descending order of how much it tells you:
 *
 * 1. a name someone gave it — always wins
 * 2. the title the agent generated for its own conversation
 * 3. the first line of the last thing it was asked
 *
 * With none of those, the session keeps its own name. Falling back to the
 * directory was tried and dropped: Claude Code derives these names *from* the
 * folder, so `terminal-system-monitor-50` became "Projects/terminal-system-
 * monitor" — no new information, and the card already shows the directory a
 * line below.
 */
export function describeAgent(agent: Agent): DisplayName {
  if (!isDerivedName(agent)) return { label: agent.name, source: 'given' }

  if (agent.aiTitle?.trim()) return { label: clip(agent.aiTitle), source: 'title' }

  if (agent.lastPrompt?.trim()) {
    const firstLine = agent.lastPrompt.split('\n').find((line) => line.trim().length > 0)
    if (firstLine) return { label: clip(firstLine), source: 'prompt' }
  }

  return { label: agent.name, source: 'given' }
}

/** Just the label, for the common case. */
export function displayName(agent: Agent): string {
  return describeAgent(agent).label
}

/** True when the label shown is not the session's own name. */
export function isRenamed(agent: Agent): boolean {
  return describeAgent(agent).source !== 'given'
}

/**
 * A label short enough to sit on one line inside a control.
 *
 * The composer placeholder is a textarea, so a long name wraps and is clipped
 * by the fixed height rather than ellipsised — on a phone
 * "Message agent-commander-web-dashboard-ux-review-pass…" lost its second line
 * entirely.
 */
export function shortName(agent: Agent, max = 22): string {
  return clip(displayName(agent), max)
}
