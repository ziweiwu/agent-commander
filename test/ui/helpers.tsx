import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { render, screen, type RenderOptions } from '@testing-library/react'
import type userEvent from '@testing-library/user-event'
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
    // A known state is one the server has spoken to: a frame has arrived, so
    // an empty `agents` here is a confirmed-empty fleet. The first-frame tests
    // set this back to null themselves (INV-11).
    fleetAt: Date.now(),
    limits: null,
    env: null,
    mock: false,
    conn: 'open',
    selected: null,
    tab: 'chat',
    attached: false,
    fullscreen: false,
    newAgentOpen: false,
    fleet: { query: '', filter: 'all', sort: 'recent', dir: 'desc' },
    theme: 'system',
    scheme: 'graphite',
    lang: 'en',
    notify: false,
    notifyNudge: false,
    trees: [],
    treesEtag: null,
    events: [],
    messages: [],
    pending: [],
    pendingSeq: 0,
    frame: null,
    history: null,
    historyPending: false,
    toast: null,
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

/**
 * Answer the confirmation in front of a destructive control.
 *
 * These actions used to be guarded by `window.confirm`, which a test could
 * stub. They are now guarded by a real dialog — because `confirm()` cannot
 * name the specific agent or the specific loss, is unthemed and untranslatable,
 * and is the least reliable dialog surface on a phone. So the tests click the
 * verb, which is also what pins that the guard is still there at all.
 *
 * Shared, because two surfaces now raise the same dialog: the detail panel's
 * control row and the composer strip.
 */
export async function answer(
  user: ReturnType<typeof userEvent.setup>,
  verb: 'accept' | 'cancel',
): Promise<void> {
  await user.click(await screen.findByTestId(`confirm-${verb}`))
}
