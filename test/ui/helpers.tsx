import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { render, type RenderOptions } from '@testing-library/react'
import { useStore } from '../../src/web/store/store.ts'
import type { Agent } from '../../src/shared/types.ts'

export const agent = (over: Partial<Agent> & { sessionId: string }): Agent => ({
  pid: 4421,
  name: over.sessionId,
  cwd: '/Users/me/Projects/thing',
  folder: 'thing',
  status: 'idle',
  kind: 'interactive',
  startedAt: Date.now() - 3_600_000,
  paneId: '%77',
  ...over,
})

/** Put the store back to a known state; component tests share the singleton. */
export function resetStore(): void {
  // The theme and the scheme are applied to <html>, which is one document
  // shared by every test in a file — so a test that picked Ember leaves the
  // next one starting in it.
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.removeAttribute('data-scheme')
  useStore.setState({
    agents: [],
    limits: null,
    env: null,
    mock: false,
    conn: 'open',
    selected: null,
    tab: 'chat',
    fullscreen: false,
    newAgentOpen: false,
    fleet: { query: '', filter: 'all', sort: 'recent', dir: 'desc' },
    theme: 'system',
    scheme: 'graphite',
    lang: 'en',
    events: [],
    messages: [],
    pending: [],
    pendingSeq: 0,
    frame: null,
    toast: null,
  })
}

export function renderApp(ui: ReactElement, options?: RenderOptions) {
  return render(<MemoryRouter>{ui}</MemoryRouter>, options)
}
