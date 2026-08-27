import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NewAgentDialog } from '../../src/web/components/NewAgentDialog.tsx'
import { useStore } from '../../src/web/store/store.ts'
import { agent, renderApp, resetStore } from './helpers.tsx'

const startAgent = vi.hoisted(() => vi.fn())
vi.mock('../../src/web/store/transport.ts', () => ({
  startAgent,
  loadEnv: vi.fn(),
  sendMessage: vi.fn(),
  sendKey: vi.fn(),
  sendText: vi.fn(),
  focusAgent: vi.fn(),
  setAttached: vi.fn(),
}))

const env = { tailscale: null, tmux: true, port: 4317, platform: 'darwin' }

beforeEach(() => {
  resetStore()
  startAgent.mockReset()
})

describe('NewAgentDialog', () => {
  it('renders nothing until it is opened', () => {
    renderApp(<NewAgentDialog />)
    expect(screen.queryByTestId('new-agent-dialog')).toBeNull()
  })

  it('starts an agent in the directory given', async () => {
    const user = userEvent.setup()
    startAgent.mockResolvedValue({ ok: true, tmuxSession: 'claude-1', cwd: '/Users/me/x' })
    useStore.setState({ newAgentOpen: true, env })

    renderApp(<NewAgentDialog />)
    await user.type(screen.getByTestId('new-agent-dir'), '~/Projects/x')
    await user.click(screen.getByTestId('new-agent-submit'))

    await waitFor(() => expect(startAgent).toHaveBeenCalledWith('~/Projects/x', {}))
    await waitFor(() => expect(useStore.getState().newAgentOpen).toBe(false))
  })

  // The server validates the directory; the dialog has to show what it said.
  it('surfaces a server error and stays open', async () => {
    const user = userEvent.setup()
    startAgent.mockResolvedValue({ ok: false, error: 'no such directory: /nope' })
    useStore.setState({ newAgentOpen: true, env })

    renderApp(<NewAgentDialog />)
    await user.type(screen.getByTestId('new-agent-dir'), '/nope')
    await user.click(screen.getByTestId('new-agent-submit'))

    const error = await screen.findByTestId('new-agent-error')
    expect(error.textContent).toContain('no such directory: /nope')
    expect(screen.getByTestId('new-agent-dialog')).toBeDefined()
    expect(useStore.getState().newAgentOpen).toBe(true)
  })

  it('passes an optional name through', async () => {
    const user = userEvent.setup()
    startAgent.mockResolvedValue({ ok: true, tmuxSession: 'claude-1', cwd: '/x' })
    useStore.setState({ newAgentOpen: true, env })

    renderApp(<NewAgentDialog />)
    await user.type(screen.getByTestId('new-agent-dir'), '/x')
    await user.type(screen.getByTestId('new-agent-name'), 'scratch')
    await user.click(screen.getByTestId('new-agent-submit'))

    await waitFor(() => expect(startAgent).toHaveBeenCalledWith('/x', { name: 'scratch' }))
  })

  it('offers the directories of running agents as shortcuts', async () => {
    const user = userEvent.setup()
    useStore.setState({
      newAgentOpen: true,
      env,
      agents: [agent({ sessionId: 'a', cwd: '/Users/me/Projects/lego-deals' })],
    })

    renderApp(<NewAgentDialog />)
    await user.click(screen.getByRole('button', { name: '~/Projects/lego-deals' }))
    expect(screen.getByTestId<HTMLInputElement>('new-agent-dir').value).toBe('~/Projects/lego-deals')
  })

  // The point of the dropdowns: these become CLI flags on the new session.
  it('passes the chosen model and permission mode', async () => {
    const user = userEvent.setup()
    startAgent.mockResolvedValue({ ok: true, tmuxSession: 'claude-1', cwd: '/x' })
    useStore.setState({ newAgentOpen: true, env })

    renderApp(<NewAgentDialog />)
    await user.type(screen.getByTestId('new-agent-dir'), '/x')
    await user.selectOptions(screen.getByTestId('new-agent-model'), 'opus')
    await user.selectOptions(screen.getByTestId('new-agent-mode'), 'plan')
    await user.click(screen.getByTestId('new-agent-submit'))

    await waitFor(() =>
      expect(startAgent).toHaveBeenCalledWith('/x', { model: 'opus', permissionMode: 'plan' }),
    )
  })

  // "default" means "whatever the CLI would do", so it is omitted rather than
  // pinned — otherwise the app would override a configured default.
  it('omits model and mode when left on default', async () => {
    const user = userEvent.setup()
    startAgent.mockResolvedValue({ ok: true, tmuxSession: 'claude-1', cwd: '/x' })
    useStore.setState({ newAgentOpen: true, env })

    renderApp(<NewAgentDialog />)
    await user.type(screen.getByTestId('new-agent-dir'), '/x')
    await user.click(screen.getByTestId('new-agent-submit'))

    await waitFor(() => expect(startAgent).toHaveBeenCalledWith('/x', {}))
  })

  // Spawning needs tmux; saying so beats a failed request.
  it('explains when tmux is unavailable instead of offering the form', () => {
    useStore.setState({ newAgentOpen: true, env: { ...env, tmux: false } })
    renderApp(<NewAgentDialog />)
    expect(screen.queryByTestId('new-agent-dir')).toBeNull()
    expect(screen.getByText(/tmux/)).toBeDefined()
  })
})

/*
 * INV-2, on the one control in this app that creates a process.
 *
 * `disabled={busy}` is React state and does not reach the DOM until React
 * flushes, so three submits dispatched in the same tick — key repeat, a double
 * click, a slow machine — each re-entered the handler before the attribute
 * landed. In mock mode that is three fixtures; against a real fleet it is three
 * `tmux new-session … claude` spawns from one click, and two agents nobody
 * asked for, in a directory they were not meant to be in.
 */
describe('starting an agent happens exactly once', () => {
  it('sends one spawn for a burst of three submits in the same tick', async () => {
    const user = userEvent.setup()
    startAgent.mockReturnValue(new Promise(() => {}))
    useStore.setState({ newAgentOpen: true })
    renderApp(<NewAgentDialog />)
    await user.type(screen.getByTestId('new-agent-dir'), '~/Projects/x')

    /*
     * Native clicks, not `fireEvent`: Testing Library flushes React between
     * fired events, so `disabled` lands and the race this guards can never
     * happen. Three real clicks in one tick is what key repeat and a
     * double-click actually produce, and what reproduced it in the browser.
     */
    const submit = screen.getByTestId('new-agent-submit')
    submit.click()
    submit.click()
    submit.click()

    expect(startAgent).toHaveBeenCalledTimes(1)
  })

  // A refused attempt must leave the button usable, or one bad path locks the
  // dialog until it is closed and reopened.
  it('can be retried after a failure', async () => {
    const user = userEvent.setup()
    startAgent.mockResolvedValue({ ok: false, error: 'no such directory' })
    useStore.setState({ newAgentOpen: true })
    renderApp(<NewAgentDialog />)
    await user.type(screen.getByTestId('new-agent-dir'), '~/nope')

    await user.click(screen.getByTestId('new-agent-submit'))
    await waitFor(() => expect(startAgent).toHaveBeenCalledTimes(1))
    await user.click(screen.getByTestId('new-agent-submit'))
    await waitFor(() => expect(startAgent).toHaveBeenCalledTimes(2))
  })
})
