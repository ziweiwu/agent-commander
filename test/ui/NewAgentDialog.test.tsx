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
