import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { render, type RenderOptions } from '@testing-library/react'
import { useStore } from '../../src/web/store/store.ts'

export { agent } from '../helpers/agent.ts'

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
    heldMode: null,
    expectSession: null,
  })
}

/**
 * Render inside a router, the way every component runs in the real app.
 *
 * The router goes in through `wrapper` rather than around `ui`, because the
 * `rerender` this returns replaces the *root* — with the router written into
 * the element, a rerender dropped it, and any component reaching for
 * `useNavigate` threw on the second render but not the first.
 */
export function renderApp(ui: ReactElement, options?: RenderOptions) {
  return render(ui, { wrapper: MemoryRouter, ...options })
}
