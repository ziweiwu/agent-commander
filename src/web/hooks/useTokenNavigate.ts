import { useCallback } from 'react'
import { useNavigate, type NavigateOptions } from 'react-router-dom'
import { withTokenPath } from '../lib/token.ts'

/**
 * `useNavigate`, with the access token kept in the address bar.
 *
 * Every route change has to re-attach it: react-router replaces the whole
 * location, query string included, so `navigate('/agent/x')` silently produces
 * a URL that 401s the moment it is reloaded, bookmarked or sent to a phone —
 * which is the one flow the token exists to serve. Use this everywhere instead
 * of react-router's own hook.
 */
export function useTokenNavigate(): (to: string, options?: NavigateOptions) => void {
  const navigate = useNavigate()
  return useCallback(
    (to: string, options?: NavigateOptions) => navigate(withTokenPath(to), options),
    [navigate],
  )
}
