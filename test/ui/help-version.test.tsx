/**
 * The Help page reports which server is answering.
 *
 * Worth a test rather than being obvious, because the interesting case is the
 * absent one. With the Mac app the bundle and the running server can be
 * different builds, and a dashboard that filled the gap with "undefined" —
 * or with the version the *browser bundle* was built at — would answer the
 * question wrongly rather than declining to answer it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { Help } from '../../src/web/components/Help.tsx'
import { useStore } from '../../src/web/store/store.ts'
import { renderApp, resetStore } from './helpers.tsx'

vi.mock('../../src/web/store/transport.ts', () => ({ loadEnv: vi.fn() }))

const env = (over: Record<string, unknown> = {}) => ({
  tailscale: null,
  tmux: true,
  port: 4317,
  platform: 'darwin',
  ...over,
})

beforeEach(() => {
  resetStore()
})

describe('the server version on the help page', () => {
  it('names the version the server reported', () => {
    useStore.setState({ env: env({ version: '0.8.0' }) as never })
    renderApp(<Help onClose={() => {}} />)
    expect(screen.getByTestId('server-version').textContent).toContain('0.8.0')
  })

  // A server built before it reported one. Nothing is better than a guess.
  it('says nothing when the server did not report one', () => {
    useStore.setState({ env: env() as never })
    renderApp(<Help onClose={() => {}} />)
    expect(screen.queryByTestId('server-version')).toBeNull()
  })

  it('says nothing before the environment has arrived', () => {
    renderApp(<Help onClose={() => {}} />)
    expect(screen.queryByTestId('server-version')).toBeNull()
  })
})
