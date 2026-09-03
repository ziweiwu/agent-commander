/**
 * The page no longer carries the token, and that is the property under test.
 *
 * It used to. The token arrived as `?token=…`, was remembered in
 * sessionStorage, was appended to every request, and was re-attached to every
 * in-app navigation — because the router replaces the whole location and a
 * *document* request for `/agent/x` without the query was refused before a line
 * of JavaScript ran. The cost was that the secret lived in the address bar
 * permanently, and therefore in history, in `document.referrer`, and in the
 * access log of whatever proxy was in front.
 *
 * The server now trades that first `?token=` for an `HttpOnly` cookie and
 * redirects to the same path without it (`cookie_exchange`). The browser sends
 * the cookie on every request and on the WebSocket handshake — which could
 * never carry an `Authorization` header, and was the whole reason for the query
 * parameter. So the client needs no token code at all, and these tests assert
 * that none came back: a URL is built without one, and navigation does not
 * re-add one.
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

describe('INV-3: the page never puts the token on a request', () => {
  // Even when one is sitting right there in the URL it was opened at. The
  // cookie is what authenticates, and it is HttpOnly, so this code cannot read
  // it and does not need to.
  it('sends no token even when the URL it loaded at had one', async () => {
    const { tokenOnRequest } = await loadTransportAt('/?token=s3cret')
    expect(tokenOnRequest()).toBeNull()
  })

  it('sends none on an ordinary URL either', async () => {
    const { tokenOnRequest } = await loadTransportAt('/agent/mock-busy')
    expect(tokenOnRequest()).toBeNull()
  })

  // The old client stored it here across loads. Nothing should now.
  it('remembers nothing across a reload', async () => {
    await loadTransportAt('/?token=s3cret')
    expect(Object.keys(sessionStorage)).toEqual([])
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
  // A fresh module, so `resetStore` above did not reach it: the frame has to
  // be marked as arrived here, or the fleet is outlines rather than cards
  // (INV-11's first-frame rule).
  useStore.setState({ fleetAt: Date.now(), ...state })
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

describe('INV-3: the token does not follow the router into the address bar', () => {
  beforeEach(() => {
    resetStore()
    // The unstub above this block takes setup.ts's matchMedia with it.
    setViewport(() => false)
  })

  // The reload this used to protect is now served by the cookie, so dropping
  // the query is correct rather than a regression.
  it('drops it when opening an agent', async () => {
    const user = userEvent.setup()
    await appAt('/?token=s3cret', { agents: FLEET })

    await user.click(screen.getAllByTestId('agent-card')[0] as HTMLElement)

    expect(address()).toBe('/agent/mock-busy')
  })

  it('drops it when closing one again', async () => {
    const user = userEvent.setup()
    await appAt('/agent/mock-busy?token=s3cret', { agents: FLEET, selected: 'mock-busy' })

    await user.keyboard('{Shift>}{Escape}{/Shift}')

    expect(address()).toBe('/')
  })

  it('adds no query string when the server has no token', async () => {
    const user = userEvent.setup()
    sessionStorage.clear()
    await appAt('/', { agents: FLEET })

    await user.click(screen.getAllByTestId('agent-card')[0] as HTMLElement)

    expect(address()).toBe('/agent/mock-busy')
  })
})
