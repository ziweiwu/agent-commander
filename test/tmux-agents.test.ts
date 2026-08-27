/**
 * Agents this app finds by asking tmux, for CLIs that report nothing.
 *
 * The rule that matters most here is the one that keeps husks out. tmux-resurrect
 * restores sessions by name long after the process inside them exited, so this
 * machine carries `gemini-1780008794` sessions containing nothing but an idle
 * `zsh`. They are indistinguishable from a live agent by name, and listing them
 * would be worse than listing nothing: a fleet of five dead agents that look
 * merely quiet is exactly the confusion this dashboard exists to remove.
 *
 * The second rule is that an inferred status is never `waiting`. An agent
 * blocked on a permission dialog and an agent that has finished both sit there
 * emitting nothing; no timestamp separates them, and guessing would spend the
 * credibility of the one alert the product is built around.
 */
import { describe, expect, it } from 'vitest'
import {
  BUSY_MS,
  agentsFromPanes,
  inferStatus,
  isLiveAgent,
  kindOf,
  startedAtOf,
} from '../src/server/tmux-agents.ts'
import type { PaneFacts } from '../src/server/pane.ts'

const NOW = 1_787_832_700_000

const pane = (over: Partial<PaneFacts> = {}): PaneFacts => ({
  paneId: '%302',
  session: 'kiro-1787832510',
  pid: 84_638,
  command: 'kiro-cli',
  activityAt: Math.floor(NOW / 1000),
  windowPanes: 1,
  dead: false,
  cwd: '/Users/ziweiwu/Projects/folio',
  ...over,
})

describe('recognising an agent', () => {
  it('matches the real Kiro session on this machine', () => {
    expect(kindOf(pane())?.id).toBe('kiro')
  })

  // The process name is not a contract: Claude Code rewrites its own process
  // title to its version number, so a name allow-list alone would not even
  // recognise the CLI this app was built for.
  it('matches on the session name when the command is unrecognised', () => {
    expect(kindOf(pane({ command: 'node' }))?.id).toBe('kiro')
  })

  it('matches on the command when the session was named by hand', () => {
    expect(kindOf(pane({ session: 'work' }))?.id).toBe('kiro')
  })

  it('ignores a session merely named like one', () => {
    expect(kindOf(pane({ session: 'kiro-notes', command: 'vim' }))).toBeUndefined()
  })

  it('reads the launcher epoch out of the session name', () => {
    expect(startedAtOf('kiro-1787832510')).toBe(1_787_832_510_000)
    expect(startedAtOf('work')).toBe(0)
  })
})

describe('husks are not agents', () => {
  it('drops a session whose agent exited, leaving a shell', () => {
    for (const command of ['zsh', '-zsh', 'bash', 'fish', 'sh']) {
      expect(isLiveAgent(pane({ command }))).toBe(false)
    }
  })

  it('drops a dead pane', () => {
    expect(isLiveAgent(pane({ dead: true }))).toBe(false)
  })

  it('keeps a live one', () => {
    expect(isLiveAgent(pane())).toBe(true)
  })

  // The exact shape of the five stale sessions on this machine.
  it('excludes resurrected gemini and opencode husks from the fleet', () => {
    const rows = [
      pane({ session: 'gemini-1780008794', paneId: '%66', command: 'zsh' }),
      pane({ session: 'opencode-1785617312', paneId: '%70', command: 'zsh' }),
      pane(),
    ]
    const agents = agentsFromPanes(rows, NOW)
    expect(agents.map((a) => a.sessionId)).toEqual(['tmux:kiro-1787832510'])
  })
})

describe('status, inferred and labelled as such', () => {
  it('is busy while the pane is still producing output', () => {
    expect(inferStatus(pane(), NOW)).toBe('busy')
  })

  it('goes idle once it has been quiet', () => {
    const quiet = pane({ activityAt: Math.floor((NOW - BUSY_MS - 1000) / 1000) })
    expect(inferStatus(quiet, NOW)).toBe('idle')
  })

  // tmux tracks activity per window, so with a split there is no way to say
  // which pane produced it. Refusing to guess beats guessing.
  it('is unknown when the window holds more than one pane', () => {
    expect(inferStatus(pane({ windowPanes: 2 }), NOW)).toBe('unknown')
  })

  it('is never waiting, however long it has been quiet', () => {
    const ages = [0, 1, 60, 3_600, 86_400].map((s) => Math.floor(NOW / 1000) - s)
    for (const activityAt of ages) {
      expect(inferStatus(pane({ activityAt }), NOW)).not.toBe('waiting')
    }
  })

  it('marks the status as inferred so the card can say so (INV-11)', () => {
    const [agent] = agentsFromPanes([pane()], NOW)
    expect(agent?.statusInferred).toBe(true)
  })

  it('claims nothing when the status could not be worked out', () => {
    const [agent] = agentsFromPanes([pane({ windowPanes: 3 })], NOW)
    expect(agent?.status).toBe('unknown')
    expect(agent?.statusInferred).toBeUndefined()
  })
})

describe('the agent record', () => {
  it('carries what the fleet card and the Attach tab need', () => {
    const [agent] = agentsFromPanes([pane()], NOW)
    expect(agent).toMatchObject({
      // Namespaced: tmux reuses `%N`, and a bare uuid could collide with Claude.
      sessionId: 'tmux:kiro-1787832510',
      agentKind: 'kiro',
      pid: 84_638,
      paneId: '%302',
      tmuxSession: 'kiro-1787832510',
      cwd: '/Users/ziweiwu/Projects/folio',
      folder: 'folio',
      startedAt: 1_787_832_510_000,
    })
  })

  it('gives one agent per session, not one per pane', () => {
    const rows = [pane(), pane({ paneId: '%303' })]
    expect(agentsFromPanes(rows, NOW)).toHaveLength(1)
  })
})
