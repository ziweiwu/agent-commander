import type { Agent, AgentStatus } from '../shared/types.ts'
import { ago, folderLabel, GROUPS, type GroupKey, matches, statusLabel, tildePath, tokens, uptime } from './format.ts'

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

export type StatusFilter = 'all' | GroupKey

export interface FleetState {
  query: string
  filter: StatusFilter
}

const IN_GROUP: Record<GroupKey, ReadonlySet<AgentStatus>> = {
  waiting: new Set<AgentStatus>(['waiting']),
  busy: new Set<AgentStatus>(['busy']),
  idle: new Set<AgentStatus>(['idle', 'unknown']),
}

export function countByGroup(agents: Agent[]): Record<GroupKey, number> {
  return {
    waiting: agents.filter((a) => IN_GROUP.waiting.has(a.status)).length,
    busy: agents.filter((a) => IN_GROUP.busy.has(a.status)).length,
    idle: agents.filter((a) => IN_GROUP.idle.has(a.status)).length,
  }
}

/** Apply the status filter and the free-text query. */
export function visibleAgents(agents: Agent[], state: FleetState): Agent[] {
  return agents.filter(
    (a) => (state.filter === 'all' || IN_GROUP[state.filter].has(a.status)) && matches(a, state.query),
  )
}

export function renderFilters(
  host: HTMLElement,
  agents: Agent[],
  state: FleetState,
  onFilter: (next: StatusFilter) => void,
): void {
  const counts = countByGroup(agents)
  host.replaceChildren()
  const add = (key: StatusFilter, label: string, count: number): void => {
    const button = el('button', 'chip')
    button.type = 'button'
    button.dataset.key = key
    button.setAttribute('aria-pressed', String(state.filter === key))
    button.append(el('b', undefined, String(count)), document.createTextNode(` ${label}`))
    button.addEventListener('click', () => onFilter(state.filter === key ? 'all' : key))
    host.append(button)
  }
  add('all', 'agents', agents.length)
  if (counts.waiting) add('waiting', 'need you', counts.waiting)
  if (counts.busy) add('busy', 'working', counts.busy)
  if (counts.idle) add('idle', 'idle', counts.idle)
}

export function renderFleet(
  host: HTMLElement,
  agents: Agent[],
  state: FleetState,
  selected: string | null,
  onSelect: (sessionId: string) => void,
): void {
  host.replaceChildren()

  if (agents.length === 0) {
    host.append(
      emptyState(
        'No Claude Code sessions found',
        'Start one with `claude` in any directory and it will appear here within a couple of seconds.',
      ),
    )
    return
  }

  const shown = visibleAgents(agents, state)
  if (shown.length === 0) {
    host.append(
      emptyState(
        'Nothing matches that filter',
        state.query ? `No agent matches “${state.query}”.` : 'No agent has that status right now.',
      ),
    )
    return
  }

  for (const group of GROUPS) {
    const members = shown.filter((a) => IN_GROUP[group.key].has(a.status))
    if (members.length === 0) continue
    const header = el('h2', `group-head group-${group.key}`)
    header.append(
      el('span', 'group-title', group.title),
      el('span', 'group-count', String(members.length)),
    )
    host.append(header)
    const list = el('div', 'group-list')
    for (const agent of members) list.append(card(agent, selected, onSelect))
    host.append(list)
  }
}

function emptyState(title: string, body: string): HTMLElement {
  const box = el('div', 'empty')
  box.append(el('p', 'empty-title', title), el('p', 'empty-body', body))
  return box
}

function card(agent: Agent, selected: string | null, onSelect: (id: string) => void): HTMLElement {
  const isOpen = agent.sessionId === selected
  const node = el('button', 'card')
  node.type = 'button'
  node.dataset.status = agent.status
  node.dataset.sessionId = agent.sessionId
  node.setAttribute('aria-current', String(isOpen))
  node.addEventListener('click', () => onSelect(agent.sessionId))

  const top = el('div', 'card-top')
  const name = el('span', 'card-name', agent.name)
  name.title = agent.name
  top.append(name)
  const pill = el('span', 'pill', statusLabel(agent))
  pill.dataset.status = agent.status
  top.append(pill)

  const meta = el('div', 'card-meta')
  const folder = el('span', 'folder', folderLabel(agent))
  folder.title = tildePath(agent.cwd)
  meta.append(folder)
  if (agent.gitBranch) meta.append(el('span', 'branch', agent.gitBranch))
  // A bare em-dash next to the folder reads as noise; a session that has never
  // run anything says so in the activity line instead.
  if (agent.lastActivityAt) meta.append(el('span', undefined, ago(agent.lastActivityAt)))
  const tok = tokens(agent.tokens)
  if (tok) meta.append(el('span', undefined, `↓ ${tok}`))
  if (agent.subagents) {
    meta.append(el('span', undefined, `${agent.subagents} subagent${agent.subagents > 1 ? 's' : ''}`))
  }
  // Uptime deliberately omitted here: it pushed the meta row to three lines and
  // is rarely what you are scanning for. It stays in the detail header.
  if (!agent.paneId) meta.append(el('span', 'warn', 'not attachable'))

  node.append(top, meta)
  if (agent.activity) {
    const activity = el('div', 'card-activity', agent.activity)
    // The line is clamped to one row, so keep the full text recoverable.
    activity.title = agent.activity
    node.append(activity)
  } else {
    node.append(
      el('div', 'card-activity muted', 'No prompts yet — waiting for its first instruction.'),
    )
  }
  return node
}

export function agentSubtitle(agent: Agent): string {
  const bits = [tildePath(agent.cwd)]
  if (agent.gitBranch) bits.push(agent.gitBranch)
  const up = uptime(agent.startedAt)
  if (up) bits.push(`up ${up}`)
  bits.push(`pid ${agent.pid}`)
  return bits.join('  ·  ')
}
