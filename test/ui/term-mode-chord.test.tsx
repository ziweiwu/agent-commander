/**
 * INV-11: a hardware Shift+Tab the server refused says so.
 *
 * The chord goes over HTTP, so a spent per-agent budget (INV-12) answers it
 * with `ok: false`. The pane then does not change, and only the toast can say
 * why.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import { Terminal } from '../../src/web/components/Terminal.tsx'
import { useStore } from '../../src/web/store/store.ts'
import { agent, renderApp, resetStore } from './helpers.tsx'

const sendShiftTab = vi.hoisted(() => vi.fn())
const chord = vi.hoisted(() => ({ press: null as null | (() => void) }))

vi.mock('../../src/web/store/transport.ts', () => ({
  sendText: vi.fn(),
  runText: vi.fn(),
  sendKey: vi.fn(),
  sendConfirmedKey: vi.fn(),
  sendShiftTab,
  setAttached: vi.fn(),
  requestHistory: vi.fn(),
}))

vi.mock('../../src/web/lib/term.ts', async (importActual) => {
  const actual = await importActual<typeof import('../../src/web/lib/term.ts')>()
  class CapturingPaneTerm extends actual.PaneTerm {
    constructor(...args: ConstructorParameters<typeof actual.PaneTerm>) {
      super(...args)
      chord.press = args[3] ?? null
    }
  }
  return { ...actual, PaneTerm: CapturingPaneTerm }
})

const pressChord = async (): Promise<void> => {
  renderApp(<Terminal agent={agent({ sessionId: 'a', paneId: '%1' })} onExit={() => {}} />)
  await waitFor(() => expect(chord.press).not.toBeNull())
  await act(async () => chord.press?.())
  await waitFor(() => expect(sendShiftTab).toHaveBeenCalledTimes(1))
}

beforeEach(() => {
  resetStore()
  chord.press = null
  sendShiftTab.mockReset()
})

describe('the mode chord in the terminal', () => {
  it('toasts why a refused press did nothing', async () => {
    const reason = 'too much input at once — slowing down'
    sendShiftTab.mockResolvedValue({ ok: false, error: reason })
    await pressChord()
    await waitFor(() =>
      expect(useStore.getState().toast).toBe(`That did not take effect: ${reason}`),
    )
  })

  it('stays quiet about a press that worked', async () => {
    sendShiftTab.mockResolvedValue({ ok: true, detail: 'sent' })
    await pressChord()
    await act(async () => {})
    expect(useStore.getState().toast).toBeNull()
  })
})
