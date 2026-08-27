/**
 * Mock provider: fixture agents on a frozen clock.
 *
 * This exists so the UI can be reviewed and signed off without pointing the app
 * at real, working agents — the same reason terminal-system-monitor ships a mock
 * mode. `npm run mock` never touches tmux or the filesystem.
 */
import { CLAUDE_KIND } from '../shared/agent-kinds.ts'
import type { Agent, RateLimits, TimelineEvent } from '../shared/types.ts'
import type { AgentSource, LimitsApi, PaneApi, TailApi } from './sources.ts'
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
    // Auto-named in a project directory with no title or prompt: the folder is
    // the last resort in the chain.
    derivedName: true,
    cwd: '/Users/demo/Projects/kb-vault',
    folder: 'kb-vault',
    status: 'waiting',
    waitingFor: 'dialog open',
    agentKind: CLAUDE_KIND,
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
    agentKind: CLAUDE_KIND,
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
    // Working towards a goal that has already been evaluated once and rejected:
    // the state the goal control has to render well, since it is the one that
    // lasts. A condition long enough to need truncating, because they are.
    goal: {
      condition:
        'every test passes and the locale sweep reports no layout breakage at 80 columns',
      met: false,
      at: START - 300_000,
      reason: 'Two locale snapshots still differ at 80 columns.',
    },
  },
  {
    sessionId: 'mock-busy-2',
    pid: 47117,
    name: 'markdown-viewer-with-ink',
    cwd: '/Users/demo/Projects/useful-markdown-viewer',
    folder: 'useful-markdown-viewer',
    status: 'busy',
    agentKind: CLAUDE_KIND,
    kind: 'interactive',
    startedAt: START - 5_400_000,
    version: '2.1.232',
    gitBranch: 'main',
    paneId: '%75',
    tmuxSession: 'claude-mock-c',
    // Parked on a subagent: the awkward case the fleet card has to survive.
    // Its own transcript has been silent for eleven minutes and only the
    // subagent is writing, so without `delegating` this reads as a dead agent.
    activity: 'Task → Audit the theme tokens across both themes',
    lastActivityAt: START - 12_000,
    delegating: true,
    subagents: 2,
    tokens: 67_500,
  },
  {
    sessionId: 'mock-long-name',
    pid: 18731,
    name: 'agent-commander-web-dashboard-ux-review-pass',
    cwd: '/Users/demo/Projects/agent-commander',
    folder: 'agent-commander',
    status: 'busy',
    agentKind: CLAUDE_KIND,
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
    agentKind: CLAUDE_KIND,
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
    // Auto-named, but the agent titled its own conversation.
    derivedName: true,
    aiTitle: 'Find an alternative markdown editor to Obsidian',
    cwd: '/Users/demo',
    folder: 'demo',
    status: 'idle',
    agentKind: CLAUDE_KIND,
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
    // Auto-named with no title yet, so the last prompt is the best label.
    derivedName: true,
    lastPrompt: 'check the npm download numbers for react-hig-datepicker',
    cwd: '/Users/demo',
    folder: 'demo',
    status: 'idle',
    agentKind: CLAUDE_KIND,
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
    // Auto-named, never prompted, and running in the home directory: there is
    // genuinely nothing better to call it, so it keeps its own name.
    derivedName: true,
    cwd: '/Users/demo',
    folder: 'demo',
    status: 'idle',
    agentKind: CLAUDE_KIND,
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
    agentKind: CLAUDE_KIND,
    kind: 'background',
    startedAt: START - 600_000,
    version: '2.1.232',
    attachBlockedReason: 'session is not running inside tmux',
    activity: 'WebFetch: https://example.com/feed.xml',
    lastActivityAt: START - 60_000,
    tokens: 2_010,
  },
  /*
   * A Kiro session, and the reason one is in the fixtures at all: everything a
   * tmux-discovered agent cannot supply has to be visible in `npm run mock`,
   * which is this project's UX sign-off gate. No activity line, no tokens, no
   * conversation, a derived name, and a status this app worked out by watching
   * the pane rather than one the agent reported (INV-11).
   */
  {
    sessionId: 'tmux:kiro-1787832510',
    pid: 84_638,
    name: 'folio',
    derivedName: true,
    cwd: '/Users/demo/Projects/folio',
    folder: 'folio',
    status: 'busy',
    statusInferred: true,
    agentKind: 'kiro',
    kind: 'interactive',
    startedAt: START - 900_000,
    gitBranch: 'main',
    lastActivityAt: START - 4_000,
    paneId: '%302',
    tmuxSession: 'kiro-1787832510',
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

/**
 * Messages sent from the browser, echoed back as transcript events.
 *
 * A real agent writes the prompt it was handed into its own transcript, and
 * that echo is what lets the chat drop its local "sending…" copy. The mock's
 * paste was a no-op, so in mock mode every message sent sat pending for ever —
 * which made the send flow the one thing that could not be exercised without
 * pointing at a live agent.
 *
 * Append-only, read through a per-reader cursor, because there is never just
 * one reader: the focused viewer polls its own tail every second and the fleet
 * enricher polls a second, independent tail for every agent every five. A queue
 * that each `read()` drained gave the message to whichever polled first — and
 * the enricher discards the events it reads, so when it won, the message was
 * gone for good and the chat marked it "not delivered" although the server had
 * accepted it. This mirrors how `TranscriptTail` already works: each reader
 * holds its own offset into a log nobody consumes.
 */
const echoes = new Map<string, Array<{ at: number; text: string }>>()

const SESSION_BY_PANE = new Map(
  FIXTURES.filter((a) => a.paneId !== undefined).map((a) => [a.paneId as string, a.sessionId]),
)

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

/**
 * Quota readings for mock mode.
 *
 * The steps are chosen to walk the meter through every branch the UI has --
 * ok, warn, critical -- and one reading with `sevenDay` missing, because a
 * session that has not yet touched the weekly window reports exactly that and
 * a component that assumes both windows exist will throw on it. The numbers are
 * deliberately un-round so a hardcoded fallback cannot masquerade as real data.
 */
const LIMIT_STEPS: RateLimits[] = [
  { fiveHour: { pct: 12.4 }, sevenDay: { pct: 31.8 }, at: 0 },
  { fiveHour: { pct: 61.4 }, sevenDay: { pct: 47.2 }, at: 0 },
  { fiveHour: { pct: 83.6 }, at: 0 },
  { fiveHour: { pct: 96.1 }, sevenDay: { pct: 88.3 }, at: 0 },
]

export class MockLimits implements LimitsApi {
  #step = 0
  #limits: RateLimits | null = null
  #listeners = new Set<(limits: RateLimits | null) => void>()
  #timer: NodeJS.Timeout | null = null

  constructor(private readonly transitions = false) {}

  current(): RateLimits | null {
    return this.#limits
  }

  onChange(fn: (limits: RateLimits | null) => void): () => void {
    this.#listeners.add(fn)
    return () => this.#listeners.delete(fn)
  }

  start(): void {
    this.#emit()
    if (!this.transitions) return
    this.#timer = setInterval(() => {
      this.#step = (this.#step + 1) % LIMIT_STEPS.length
      this.#emit()
    }, 4000)
    this.#timer.unref?.()
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
    this.#listeners.clear()
  }

  /**
   * Reset times are stamped relative to now rather than baked into the steps,
   * so the countdown reads sensibly however long the mock server has been up.
   */
  #emit(): void {
    const base = LIMIT_STEPS[this.#step] as RateLimits
    const now = Date.now()
    const next: RateLimits = { at: now }
    if (base.fiveHour) next.fiveHour = { ...base.fiveHour, resetsAt: now + 2 * 3600_000 }
    if (base.sevenDay) next.sevenDay = { ...base.sevenDay, resetsAt: now + 3 * 86_400_000 }
    this.#limits = next
    for (const fn of this.#listeners) fn(next)
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

  /** The same one-round-trip shape the real adapter has, so the hub is exercised. */
  async sample(paneId: string): Promise<{ meta: PaneMeta; lines: string[] }> {
    const geometry = await this.meta()
    return { meta: geometry, lines: await this.capture(paneId, geometry.rows) }
  }

  async paste(paneId: string, text: string, submit: boolean): Promise<void> {
    // Only a submitted message becomes a transcript entry; loose keystrokes
    // sent by the terminal view do not.
    if (!submit) return
    const sessionId = SESSION_BY_PANE.get(paneId)
    if (sessionId === undefined) return
    echoes.set(sessionId, [...(echoes.get(sessionId) ?? []), { at: Date.now(), text }])
  }

  async key(): Promise<void> {}
}

export class MockTail implements TailApi {
  #sent = false
  #echoCursor = 0

  constructor(private readonly sessionId: string) {}

  async read(): Promise<{ events: TimelineEvent[]; patch: Partial<Agent>; first: boolean }> {
    if (this.#sent) {
      const log = echoes.get(this.sessionId) ?? []
      if (this.#echoCursor >= log.length) return { events: [], patch: {}, first: false }
      const fresh = log.slice(this.#echoCursor)
      const events = fresh.map((entry, i) => ({
        // Stable across readers: the same entry gets the same id whoever reads
        // it, so two tails cannot introduce the same message twice.
        id: `${this.sessionId}:echo:${this.#echoCursor + i}`,
        // Stamped when it was sent, not when it happened to be read — a later
        // reader replaying the log must not restamp the conversation as "now".
        at: entry.at,
        kind: 'user' as const,
        text: entry.text,
      }))
      this.#echoCursor = log.length
      return { events, patch: {}, first: false }
    }
    this.#sent = true
    const events = MOCK_TIMELINE.map((e, i) => ({ ...e, id: `${this.sessionId}:${i}` }))
    return { events, patch: {}, first: true }
  }
}
