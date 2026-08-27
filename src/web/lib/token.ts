/**
 * The access token, and everything that has to keep hold of it.
 *
 * It arrives once, as `?token=…` on the URL that opened the tab. Two separate
 * things then need it, and only one of them is served by remembering it in
 * memory:
 *
 *   - Requests this page makes (`withToken`). sessionStorage is enough here,
 *     because the module is already loaded by the time any of them run.
 *   - The address bar itself (`tokenSearch`). Nothing the page remembers can
 *     help the *document* request: navigating to `/agent/x` without the query
 *     string produces a URL that 401s on reload, bookmark or share, before a
 *     line of this file has run. So every navigation has to carry it forward.
 *
 * sessionStorage rather than localStorage, which is where every other
 * preference here lives: this is a secret scoped to the tab that was handed it,
 * and it should not outlive the browsing session or leak into every other tab.
 * A token in the URL always wins, so rotating it is just opening the new link.
 */
const TOKEN_KEY = 'agent-commander.token'

function readToken(): string | null {
  const fromUrl = new URLSearchParams(location.search).get('token')
  try {
    if (fromUrl) {
      sessionStorage.setItem(TOKEN_KEY, fromUrl)
      return fromUrl
    }
    return sessionStorage.getItem(TOKEN_KEY)
  } catch {
    // Safari private mode and some embedded webviews throw on access; the
    // token still works for as long as the URL keeps it.
    return fromUrl
  }
}

export const token = readToken()

/** An absolute URL for a request this page makes, token attached. */
export function withToken(path: string): URL {
  const url = new URL(path, location.href)
  if (token) url.searchParams.set('token', token)
  return url
}

/**
 * The query string every in-app navigation must keep, `''` when there is no
 * token. Written out rather than copied from `location.search` so that nothing
 * else that happens to be in the URL is dragged along with it.
 */
export function tokenSearch(): string {
  return token ? `?token=${encodeURIComponent(token)}` : ''
}

/** A path with the token re-attached, for `navigate()` and `<Navigate to>`. */
export function withTokenPath(path: string): string {
  return token && !path.includes('?') ? `${path}${tokenSearch()}` : path
}
