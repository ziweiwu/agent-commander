/** A plausible agent, for tests that only care about one or two of its fields. */
import type { Agent } from '../../src/shared/types.ts'

export const agent = (over: Partial<Agent> & { sessionId: string }): Agent => ({
  pid: 4421,
  name: over.sessionId,
  cwd: '/Users/me/Projects/thing',
  folder: 'thing',
  status: 'idle',
  agentKind: 'claude',
  kind: 'interactive',
  startedAt: Date.now() - 3_600_000,
  paneId: '%77',
  ...over,
})
