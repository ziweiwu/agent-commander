/**
 * Mock provider: fixture agents on a frozen clock.
 *
 * This exists so the UI can be reviewed and signed off without pointing the app
 * at real, working agents — the same reason terminal-system-monitor ships a mock
 * mode. `npm run mock` never touches tmux or the filesystem.
 */
import type { Agent, TimelineEvent } from '../shared/types.ts'
import type { AgentSource, PaneApi, TailApi } from './sources.ts'
import type { PaneMeta } from './pane.ts'

const START = 1786600000000
/** Real escape byte, so mock frames exercise the same ANSI path as live captures. */
const ESC = '\u001b['

/**
 * Deliberately modelled on a real, awkward fleet rather than a flattering one:
 * five sessions share the home directory with auto-generated names, one name is
 * far too long for its card, and two have never been prompted so they have no
 * activity at all. If the UI reads well here it reads well anywhere.
 */
const FIXTURES: Agent[] = [
  {
    sessionId: 'mock-waiting',
    pid: 28707,
    name: 'ziweiwu-ee',
    cwd: '/Users/demo',
    folder: 'demo',
    status: 'waiting',
    waitingFor: 'dialog open',
    kind: 'interactive',
    startedAt: START - 3_600_000,
    version: '2.1.232',
    paneId: '%76',
    tmuxSession: 'claude-mock-a',
    activity: 'Bash: rm -rf dist && rebuild from scratch',
    lastActivityAt: START - 240_000,
    tokens: 48_120,
  },
  {
    sessionId: 'mock-busy',
    pid: 4421,
    name: 'terminal-system-monitor-50',
    cwd: '/Users/demo/Projects/terminal-system-monitor',
    folder: 'terminal-system-monitor',
    status: 'busy',
    kind: 'interactive',
    startedAt: START - 7_200_000,
    version: '2.1.232',
    gitBranch: 'fix/locale-layout-startup',
    paneId: '%77',
    tmuxSession: 'claude-mock-b',
    activity: 'Task → Rerun the exhaustive sweep against fixed code',
    lastActivityAt: START - 12_000,
    tokens: 111_800,
    subagents: 3,
  },
  {
    sessionId: 'mock-busy-2',
    pid: 47117,
    name: 'markdown-viewer-with-ink',
    cwd: '/Users/demo/Projects/useful-markdown-viewer',
    folder: 'useful-markdown-viewer',
    status: 'busy',
    kind: 'interactive',
    startedAt: START - 5_400_000,
    version: '2.1.232',
    gitBranch: 'main',
    paneId: '%75',
    tmuxSession: 'claude-mock-c',
    activity: 'Bash: Test headless Chrome screenshot pipeline',
    lastActivityAt: START - 40_000,
    tokens: 67_500,
  },
  {
    sessionId: 'mock-long-name',
    pid: 18731,
    name: 'agent-commander-web-dashboard-ux-review-pass',
    cwd: '/Users/demo/Projects/agent-commander',
    folder: 'agent-commander',
    status: 'busy',
    kind: 'interactive',
    startedAt: START - 1_500_000,
    version: '2.1.232',
    gitBranch: 'main',
    paneId: '%79',
    tmuxSession: 'claude-mock-d',
    activity:
      'Write: /Users/demo/Projects/agent-commander/src/web/very/deep/path/component.ts',
    lastActivityAt: START - 8_000,
    tokens: 23_900,
    subagents: 1,
  },
  {
    sessionId: 'mock-idle-kb',
    pid: 34625,
    name: 'kb-operational-hardening',
    cwd: '/Users/demo',
    folder: 'demo',
    status: 'idle',
    kind: 'interactive',
    startedAt: START - 1_800_000,
    version: '2.1.232',
    activity: 'Repo is back to normal. `main` and `skills-find-suitable` both build.',
    lastActivityAt: START - 960_000,
    tokens: 59_800,
    paneId: '%72',
    tmuxSession: 'claude-mock-e',
  },
  {
    sessionId: 'mock-idle-ce',
    pid: 50893,
    name: 'ziweiwu-ce',
    cwd: '/Users/demo',
    folder: 'demo',
    status: 'idle',
    kind: 'interactive',
    startedAt: START - 50_400_000,
    version: '2.1.232',
    activity: 'Done — `~/.zshrc` updated (backup at `~/.zshrc.bak.2026`)',
    lastActivityAt: START - 50_400_000,
    tokens: 31_900,
    paneId: '%73',
    tmuxSession: 'claude-mock-f',
  },
  {
    sessionId: 'mock-idle-db',
    pid: 53848,
    name: 'ziweiwu-db',
    cwd: '/Users/demo',
    folder: 'demo',
    status: 'idle',
    kind: 'interactive',
    startedAt: START - 3_600_000,
    version: '2.1.232',
    activity: '**`react-hig-datepicker`, with 6,306 all-time downloads',
    lastActivityAt: START - 3_600_000,
    tokens: 8_800,
    paneId: '%78',
    tmuxSession: 'claude-mock-g',
  },
  {
    sessionId: 'mock-fresh',
    pid: 2330,
    name: 'ziweiwu-35',
    cwd: '/Users/demo',
    folder: 'demo',
    status: 'idle',
    kind: 'interactive',
    startedAt: START - 600_000,
    version: '2.1.232',
    paneId: '%0',
    tmuxSession: 'claude-mock-h',
  },
  {
    sessionId: 'mock-no-tmux',
    pid: 6556,
    name: 'headless-import',
    cwd: '/Users/demo/Projects/lego-deals',
    folder: 'lego-deals',
    status: 'idle',
    kind: 'background',
    startedAt: START - 600_000,
    version: '2.1.232',
    attachBlockedReason: 'session is not running inside tmux',
    activity: 'WebFetch: https://example.com/feed.xml',
    lastActivityAt: START - 60_000,
    tokens: 2_010,
  },
]

const MOCK_TIMELINE: Array<Omit<TimelineEvent, 'id'>> = [
  { at: START - 300_000, kind: 'user', text: 'Add a dark mode toggle to the site header.' },
  { at: START - 295_000, kind: 'assistant', text: "I'll start by getting oriented in the codebase." },
  { at: START - 290_000, kind: 'tool', tool: 'Glob', text: 'src/**/*.astro' },
  { at: START - 280_000, kind: 'tool', tool: 'Read', text: 'src/components/Header.astro' },
  { at: START - 260_000, kind: 'subagent', tool: 'Task', text: 'Audit existing theme tokens' },
  {
    at: START - 250_000,
    kind: 'assistant',
    text: 'The theme tokens already exist but are only defined for light mode.',
  },
  { at: START - 240_000, kind: 'tool', tool: 'Bash', text: 'rm -rf dist && rebuild' },
]

export class MockSource implements AgentSource {
  #agents = new Map(FIXTURES.map((a) => [a.sessionId, structuredClone(a)]))
  #listeners = new Set<(agents: Agent[]) => void>()
  #timer: NodeJS.Timeout | null = null

  /**
   * `transitions` flips the blocked fixture between waiting and idle on a timer.
   * Static fixtures cannot show whether the UI keeps up with a status change --
   * for instance whether the "waiting on you" banner clears once it is answered.
   */
  constructor(private readonly transitions = false) {}

  list(): Agent[] {
    return [...this.#agents.values()]
  }

  get(sessionId: string): Agent | undefined {
    return this.#agents.get(sessionId)
  }

  onChange(fn: (agents: Agent[]) => void): () => void {
    this.#listeners.add(fn)
    return () => this.#listeners.delete(fn)
  }

  enrich(sessionId: string, patch: Partial<Agent>): void {
    const current = this.#agents.get(sessionId)
    if (current) this.#agents.set(sessionId, { ...current, ...patch })
  }

  notify(): void {
    const list = this.list()
    for (const fn of this.#listeners) fn(list)
  }

  async start(): Promise<void> {
    if (!this.transitions) return
    this.#timer = setInterval(() => {
      const agent = this.#agents.get('mock-waiting')
      if (!agent) return
      const blocked = agent.status === 'waiting'
      this.#agents.set('mock-waiting', {
        ...agent,
        status: blocked ? 'idle' : 'waiting',
        ...(blocked ? {} : { waitingFor: 'dialog open' }),
      })
      if (blocked) delete this.#agents.get('mock-waiting')!.waitingFor
      this.notify()
    }, 3000)
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
  }
}

export class MockPanes implements PaneApi {
  async meta(): Promise<PaneMeta> {
    return { cols: 96, rows: 24, cursorX: 2, cursorY: 21, alternate: true, dead: false }
  }

  async capture(paneId: string, rows: number): Promise<string[]> {
    const dim = `${ESC}38;5;246m`
    const off = `${ESC}39m`
    const lines = [
      `${dim}╭─ mock pane ${paneId} ───────────────────╮${off}`,
      '',
      `${ESC}38;5;44m⏺${off} Reading src/components/Header.astro`,
      `  ${dim}Read 1 file, ran 2 shell commands${off}`,
      '',
      `${ESC}38;5;220m✻${off} Hyperspacing… (2m 14s · ${dim}↓ 48.1k tokens${off})`,
      '',
      `${dim}${'─'.repeat(60)}${off}`,
      '❯ ',
      `${dim}${'─'.repeat(60)}${off}`,
      `  ${ESC}38;5;220m⏵⏵ auto mode on${dim} · esc to interrupt${off}`,
    ]
    while (lines.length < rows) lines.push('')
    return lines.slice(0, rows)
  }

  async paste(): Promise<void> {}

  async key(): Promise<void> {}
}

export class MockTail implements TailApi {
  #sent = false

  constructor(private readonly sessionId: string) {}

  async read(): Promise<{ events: TimelineEvent[]; patch: Partial<Agent>; first: boolean }> {
    if (this.#sent) return { events: [], patch: {}, first: false }
    this.#sent = true
    const events = MOCK_TIMELINE.map((e, i) => ({ ...e, id: `${this.sessionId}:${i}` }))
    return { events, patch: {}, first: true }
  }
}
