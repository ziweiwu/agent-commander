/**
 * The token has to survive the first navigation, in both places it lives.
 *
 * It arrives as `?token=…` on the URL that opens the dashboard, and the router
 * does not carry a query string through `navigate('/agent/x')`. That breaks two
 * separate things, and remembering the token in sessionStorage only fixes one:
 *
 *   - Requests the page makes. Covered by the first block; the module is loaded
 *     by the time any of them run, so recalling the token is enough.
 *   - The address bar. Covered by the second. Nothing the page remembers can
 *     help here — the *document* request for `/agent/x` is refused with
 *     `unauthorized: append ?token=…` before a line of JavaScript runs, so a
 *     reload, a bookmark or a link sent to a phone all dead-end. That is the
 *     phone-over-Tailscale flow the token exists for in the first place.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import type { Agent } from '../../src/shared/types.ts'
import { agent, resetStore } from './helpers.tsx'
import { setViewport } from './setup.ts'

/** Re-import the transport with a given URL, the way a fresh page load would. */
async function loadTransportAt(url: string): Promise<{ tokenOnRequest: () => string | null }> {
  window.history.replaceState({}, '', url)
  vi.resetModules()
  const transport = await import('../../src/web/store/transport.ts')

  return {
    tokenOnRequest: () => {
      let seen: string | null = null
      const spy = vi.fn(async (input: RequestInfo | URL) => {
        seen = new URL(String(input), location.href).searchParams.get('token')
        return new Response('{}', { headers: { 'content-type': 'application/json' } })
      })
      vi.stubGlobal('fetch', spy)
      void transport.loadEnv()
      // Guards the negative case below from passing because nothing was sent.
      expect(spy).toHaveBeenCalledTimes(1)
      return seen
    },
  }
}

beforeEach(() => {
  sessionStorage.clear()
  vi.unstubAllGlobals()
})

describe('the token outlives the query string it arrived in', () => {
  it('sends the token given in the URL', async () => {
    const { tokenOnRequest } = await loadTransportAt('/?token=s3cret')
    expect(tokenOnRequest()).toBe('s3cret')
  })

  // The failing case: the router has since rewritten the URL to /agent/<id>.
  it('still sends it after a reload onto a URL with no query string', async () => {
    await loadTransportAt('/?token=s3cret')
    const { tokenOnRequest } = await loadTransportAt('/agent/mock-busy')
    expect(tokenOnRequest()).toBe('s3cret')
  })

  it('prefers a token in the URL over the one it remembered', async () => {
    await loadTransportAt('/?token=old')
    const { tokenOnRequest } = await loadTransportAt('/?token=rotated')
    expect(tokenOnRequest()).toBe('rotated')
  })

  // A server with no token at all must not have one invented for it.
  it('sends nothing when none was ever supplied', async () => {
    const { tokenOnRequest } = await loadTransportAt('/')
    expect(tokenOnRequest()).toBeNull()
  })
})

/** The URL the router would actually put in the address bar. */
function Address() {
  const { pathname, search } = useLocation()
  return <output data-testid="address">{pathname + search}</output>
}

/**
 * Mount the app at `url`, re-imported so the token module reads that URL.
 *
 * The store has to be seeded through the freshly imported copy: `resetModules`
 * gives the components a new singleton, and setting state on the old one leaves
 * them rendering an empty fleet with nothing to click.
 */
/*
 * Pinned to the card list on purpose. What this file asserts — that the token
 * survives the first navigation, in the address bar as well as on requests —
 * reaches for a card, which the fleet always renders.
 */
async function appAt(
  url: string,
  state: Partial<{ agents: Agent[]; selected: string }> = {},
) {
  window.history.replaceState({}, '', url)
  vi.resetModules()
  // Scoped to this import rather than hoisted: the block above exercises the
  // real transport, and a file-wide mock would leave it with nothing to assert.
  vi.doMock('../../src/web/store/transport.ts', () => ({
    sendMessage: vi.fn(),
    sendKey: vi.fn(),
    sendText: vi.fn(),
    loadEnv: vi.fn(),
    startAgent: vi.fn(),
    focusAgent: vi.fn(),
    setAttached: vi.fn(),
  }))
  const { App, FleetRoute } = await import('../../src/web/components/App.tsx')
  const { useStore } = await import('../../src/web/store/store.ts')
  useStore.setState(state)
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route
          path="/"
          element={
            <>
              <App />
              <Address />
            </>
          }
        >
          <Route index element={<FleetRoute />} />
          <Route path="agent/:sessionId" element={<FleetRoute />} />
          <Route path="agent/:sessionId/term" element={<FleetRoute />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

const address = (): string => screen.getByTestId('address').textContent ?? ''
const FLEET = [agent({ sessionId: 'mock-busy' })]

describe('the token stays in the address bar', () => {
  beforeEach(() => {
    resetStore()
    // The unstub above this block takes setup.ts's matchMedia with it.
    setViewport(() => false)
  })

  it('keeps it when opening an agent', async () => {
    const user = userEvent.setup()
    await appAt('/?token=s3cret', { agents: FLEET })

    await user.click(screen.getAllByTestId('agent-card')[0] as HTMLElement)

    // Without this the URL reads /agent/mock-busy, which 401s on reload.
    expect(address()).toBe('/agent/mock-busy?token=s3cret')
  })

  it('keeps it when closing one again', async () => {
    const user = userEvent.setup()
    await appAt('/agent/mock-busy?token=s3cret', { agents: FLEET, selected: 'mock-busy' })

    await user.keyboard('{Shift>}{Escape}{/Shift}')

    expect(address()).toBe('/?token=s3cret')
  })

  it('adds no query string when the server has no token', async () => {
    const user = userEvent.setup()
    sessionStorage.clear()
    await appAt('/', { agents: FLEET })

    await user.click(screen.getAllByTestId('agent-card')[0] as HTMLElement)

    expect(address()).toBe('/agent/mock-busy')
  })
})
