/** The capability interfaces the server talks to, so mock mode can stand in. */
import type { Agent, RateLimits, TimelineEvent } from '../shared/types.ts'
import type { PaneMeta } from './pane.ts'

export interface AgentSource {
  list(): Agent[]
  get(sessionId: string): Agent | undefined
  onChange(fn: (agents: Agent[]) => void): () => void
  enrich(sessionId: string, patch: Partial<Agent>): void
  /** Broadcast the current list after out-of-band enrichment. */
  notify?(): void
  start(): Promise<void>
  stop(): void
}

export interface PaneApi {
  meta(paneId: string): Promise<PaneMeta>
  capture(paneId: string, rows: number): Promise<string[]>
  paste(paneId: string, text: string, submit: boolean): Promise<void>
  key(paneId: string, keyName: string): Promise<void>
}

export interface TailApi {
  read(): Promise<{ events: TimelineEvent[]; patch: Partial<Agent>; first: boolean }>
}

/** Account-level quota, watched from the file the statusLine bridge writes. */
export interface LimitsApi {
  /** Last good reading, or null when nothing has been written yet. */
  current(): RateLimits | null
  onChange(fn: (limits: RateLimits | null) => void): () => void
  start(): void
  stop(): void
}
