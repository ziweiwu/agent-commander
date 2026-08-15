import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SortControl } from '../../src/web/components/SortControl.tsx'
import { useStore } from '../../src/web/store/store.ts'
import { renderApp, resetStore } from './helpers.tsx'

vi.mock('../../src/web/store/transport.ts', () => ({
  sendMessage: vi.fn(), sendKey: vi.fn(), sendText: vi.fn(), loadEnv: vi.fn(),
  startAgent: vi.fn(), focusAgent: vi.fn(), setAttached: vi.fn(),
  setAgentMode: vi.fn(), setAgentModel: vi.fn(), closeAgent: vi.fn(), browseDirs: vi.fn(),
}))

beforeEach(resetStore)

describe('SortControl', () => {
  it('changes the sort key', async () => {
    const user = userEvent.setup()
    renderApp(<SortControl />)
    await user.selectOptions(screen.getByTestId('sort-select'), 'tokens')
    expect(useStore.getState().fleet.sort).toBe('tokens')
  })

  it('toggles direction both ways', async () => {
    const user = userEvent.setup()
    renderApp(<SortControl />)
    expect(useStore.getState().fleet.dir).toBe('desc')

    await user.click(screen.getByTestId('sort-direction'))
    expect(useStore.getState().fleet.dir).toBe('asc')

    await user.click(screen.getByTestId('sort-direction'))
    expect(useStore.getState().fleet.dir).toBe('desc')
  })

  // "Ascending tokens" means nothing; "least" does.
  it('labels the direction with what the order means, per key', async () => {
    const user = userEvent.setup()
    renderApp(<SortControl />)
    // The default key is "recent", so the label is about time, not amount.
    expect(screen.getByTestId('sort-direction').textContent).toContain('newest')

    await user.selectOptions(screen.getByTestId('sort-select'), 'tokens')
    expect(screen.getByTestId('sort-direction').textContent).toContain('most')

    await user.click(screen.getByTestId('sort-direction'))
    expect(screen.getByTestId('sort-direction').textContent).toContain('least')

    await user.selectOptions(screen.getByTestId('sort-select'), 'duration')
    // Direction is remembered across a key change; ascending duration is shortest.
    expect(screen.getByTestId('sort-direction').textContent).toContain('shortest')
  })

  it('keeps an accessible name on the toggle', () => {
    renderApp(<SortControl />)
    expect(screen.getByTestId('sort-direction').getAttribute('aria-label')).toBeTruthy()
  })
})
