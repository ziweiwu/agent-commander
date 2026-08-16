/**
 * The token has to survive the first navigation.
 *
 * It arrives as `?token=…` on the URL that opens the dashboard, and the router
 * does not carry a query string through `navigate('/agent/x')`. Reading it once
 * at module load hid that: the tab kept working until it was reloaded, and then
 * every request came back 401 with nothing to do but edit the address bar —
 * which is the phone-over-Tailscale flow the token exists for in the first
 * place.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
