/**
 * FR-UI-13's two filter keys, driven through the real route tree.
 *
 * `/` focuses the filter and Esc clears it. Both read one ref, and for as long
 * as this app has existed the box was wired to a second ref of `FleetRoute`'s
 * own, so the handler's ref was always null: `/` did nothing, and Esc in a
 * filled filter fell through to closing the open agent. These mount `App` with
 * `FleetRoute` beneath it, the shape `routes.tsx` builds, because a test that
 * renders `App` alone has no filter box to find.
 *
 * Esc is asserted on the value rather than on the browser's own search-field
 * clear: jsdom has none, and WebKit keeps the text, so the handler is the only
 * thing that clears it everywhere.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { App, FleetRoute } from '../../src/web/components/App.tsx'
import { useStore } from '../../src/web/store/store.ts'
import { agent, resetStore } from './helpers.tsx'
import { setViewport } from './setup.ts'

vi.mock('../../src/web/store/transport.ts', () => ({
  sendMessage: vi.fn(),
  sendKey: vi.fn(),
  sendConfirmedKey: vi.fn(),
  sendText: vi.fn(),
  loadEnv: vi.fn(),
  startAgent: vi.fn(),
  focusAgent: vi.fn(),
  setAttached: vi.fn(),
  answerPrompt: vi.fn(),
  clearAgentContext: vi.fn(),
  compactAgentContext: vi.fn(),
  setAgentModel: vi.fn(),
  setGoal: vi.fn(),
  clearGoal: vi.fn(),
  sendShiftTab: vi.fn(),
  closeAgentById: vi.fn(),
  closeAgent: vi.fn(),
  fetchTree: vi.fn(),
}))

const DESKTOP = () => false

let path = ''

function Probe() {
  path = useLocation().pathname
  return null
}

function shell(startPath: string) {
  return render(
    <MemoryRouter initialEntries={[startPath]}>
      <Probe />
      <Routes>
        <Route path="/*" element={<App />}>
          <Route index element={<FleetRoute />} />
          <Route path="agent/:sessionId" element={<FleetRoute />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

function search(): HTMLInputElement {
  return screen.getByTestId('search') as HTMLInputElement
}

beforeEach(() => {
  resetStore()
  setViewport(DESKTOP)
  useStore.setState({
    agents: [
      agent({ sessionId: 'a', name: 'alpha', status: 'idle', paneId: '%1' }),
      agent({ sessionId: 'b', name: 'beta', status: 'idle', paneId: '%2' }),
    ],
  })
})

describe('the filter box keys (FR-UI-13)', () => {
  it('focuses the filter on /, without typing the slash into it', async () => {
    const user = userEvent.setup()
    shell('/')

    await user.keyboard('/')

    expect(document.activeElement).toBe(search())
    expect(search().value).toBe('')
  })

  it('clears a filled filter on Esc', async () => {
    const user = userEvent.setup()
    shell('/')

    await user.keyboard('/')
    await user.keyboard('x')
    expect(search().value).toBe('x')
    await user.keyboard('{Escape}')

    expect(search().value).toBe('')
    expect(useStore.getState().fleet.query).toBe('')
  })

  it('clears the filter rather than closing the open agent (FR-UI-14: one level per press)', async () => {
    const user = userEvent.setup()
    useStore.setState({ selected: 'a' })
    shell('/agent/a')

    await user.click(search())
    await user.keyboard('x')
    await user.keyboard('{Escape}')

    expect(search().value).toBe('')
    expect(path).toBe('/agent/a')

    await user.keyboard('{Escape}')
    expect(path).toBe('/')
  })

  it('keeps j and k as letters while typing in the filter', async () => {
    const user = userEvent.setup()
    shell('/')

    await user.click(search())
    await user.keyboard('jk')

    expect(search().value).toBe('jk')
    expect(document.activeElement).toBe(search())
  })

  it('still moves from the filter into the list on ArrowDown', async () => {
    const user = userEvent.setup()
    shell('/')

    await user.click(search())
    await user.keyboard('{ArrowDown}')

    expect(document.activeElement?.getAttribute('data-testid')).toBe('agent-card')
  })

  it('types a slash into the filter once it has focus', async () => {
    const user = userEvent.setup()
    shell('/')

    await user.click(search())
    await user.keyboard('~/')

    expect(search().value).toBe('~/')
  })
})
