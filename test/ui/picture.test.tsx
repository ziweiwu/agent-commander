/**
 * A picture becomes a path in the composer, and nothing else happens.
 *
 * The whole point of the feature is that an upload is not a send. Claude Code
 * reads an image file named in a prompt, so the bytes go to the server and the
 * *path* comes back — and what to do with that path is a sentence only the
 * person can write. Composing one here would be this app putting prose in
 * somebody's mouth (INV-11); sending it would be input nobody typed (INV-2).
 *
 * So these assert the two halves that are easy to lose later: the path lands
 * in the box rather than at the agent, and the button is absent for an agent
 * whose composer is already disabled — an agent started outside tmux has no
 * pane, and a path it could never be told about is a button that does nothing
 * (TODO §14, "Watch for").
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Chat } from '../../src/web/components/Chat.tsx'
import { agent, renderApp, resetStore } from './helpers.tsx'
import { useStore } from '../../src/web/store/store.ts'

const sendMessage = vi.hoisted(() => vi.fn())
const uploadPicture = vi.hoisted(() => vi.fn())

vi.mock('../../src/web/store/transport.ts', () => ({
  sendMessage,
  uploadPicture,
  sendConfirmedKey: vi.fn(),
  sendKey: vi.fn(),
  sendText: vi.fn(),
  flushText: vi.fn(),
  interruptAndSend: vi.fn(),
  loadEnv: vi.fn(),
  focusAgent: vi.fn(),
  setAttached: vi.fn(),
  setAgentGoal: vi.fn(),
  clearAgentGoal: vi.fn(),
  sendShiftTab: vi.fn(),
  clearAgentContext: vi.fn(),
  compactAgentContext: vi.fn(),
}))

const idle = () => agent({ sessionId: 'a', status: 'idle', paneId: '%1' })
const shot = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'shot.png', { type: 'image/png' })

const box = () => screen.getByTestId('composer-input') as HTMLTextAreaElement

beforeEach(() => {
  resetStore()
  sendMessage.mockClear()
  uploadPicture.mockReset()
})

describe('INV-11 a picture is offered as a path, never sent as a message', () => {
  it('puts the path in the box and sends nothing', async () => {
    const user = userEvent.setup()
    uploadPicture.mockResolvedValue({ ok: true, path: '/tmp/pics/a/abc.png' })
    renderApp(<Chat agent={idle()} />)

    await user.upload(screen.getByTestId('picture-input'), shot())

    expect(uploadPicture).toHaveBeenCalledWith('a', expect.any(File))
    expect(box().value).toContain('/tmp/pics/a/abc.png')
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('leaves a half-written draft alone and appends after it', async () => {
    const user = userEvent.setup()
    uploadPicture.mockResolvedValue({ ok: true, path: '/tmp/pics/a/abc.png' })
    renderApp(<Chat agent={idle()} />)

    await user.type(box(), 'what is wrong with this layout?')
    await user.upload(screen.getByTestId('picture-input'), shot())

    expect(box().value).toBe('what is wrong with this layout? /tmp/pics/a/abc.png ')
  })

  it('says why a refused picture was refused, in the server’s own words', async () => {
    const user = userEvent.setup()
    uploadPicture.mockResolvedValue({ ok: false, error: 'that is not a PNG, JPEG, GIF or WebP' })
    renderApp(<Chat agent={idle()} />)

    await user.upload(screen.getByTestId('picture-input'), shot())

    await waitFor(() => expect(useStore.getState().toast).toMatch(/not a PNG/))
    expect(box().value).toBe('')
  })
})

/** A paste event's clipboard, holding the given files and text. */
const clipboard = (files: File[], text = '') => ({
  files,
  getData: (type: string) => (type === 'text/plain' ? text : ''),
  types: [...(files.length ? ['Files'] : []), ...(text ? ['text/plain'] : [])],
})

describe('INV-2 a pasted screenshot is uploaded like an attached one', () => {
  it('uploads the picture and puts its path in the box, sending nothing', async () => {
    uploadPicture.mockResolvedValue({ ok: true, path: '/tmp/pics/a/abc.png' })
    renderApp(<Chat agent={idle()} />)

    fireEvent.paste(box(), { clipboardData: clipboard([shot()]) })

    await waitFor(() => expect(box().value).toBe('/tmp/pics/a/abc.png '))
    expect(uploadPicture).toHaveBeenCalledWith('a', expect.any(File))
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('leaves a text paste to the browser', () => {
    renderApp(<Chat agent={idle()} />)

    const prevented = !fireEvent.paste(box(), { clipboardData: clipboard([], 'hello') })

    expect(prevented).toBe(false)
    expect(uploadPicture).not.toHaveBeenCalled()
  })

  it('does not take a file that is not a picture', () => {
    renderApp(<Chat agent={idle()} />)

    const notes = new File(['x'], 'notes.txt', { type: 'text/plain' })
    fireEvent.paste(box(), { clipboardData: clipboard([notes]) })

    expect(uploadPicture).not.toHaveBeenCalled()
  })

  it('uploads nothing while nothing typed here could arrive', () => {
    useStore.setState({ conn: 'closed' })
    renderApp(<Chat agent={idle()} />)

    fireEvent.paste(box(), { clipboardData: clipboard([shot()]) })

    expect(uploadPicture).not.toHaveBeenCalled()
  })
})

describe('INV-17 the button follows the composer it belongs to', () => {
  it('is absent for an agent with no pane, exactly as the box is disabled', () => {
    renderApp(<Chat agent={agent({ sessionId: 'a', status: 'idle', paneId: undefined })} />)

    expect(box().disabled).toBe(true)
    expect(screen.queryByTestId('attach-picture')).toBeNull()
  })

  it('is disabled while nothing typed here could arrive', () => {
    useStore.setState({ conn: 'closed' })
    renderApp(<Chat agent={idle()} />)

    expect((screen.getByTestId('attach-picture') as HTMLButtonElement).disabled).toBe(true)
  })

  it('is named rather than left as a glyph', () => {
    renderApp(<Chat agent={idle()} />)

    expect(screen.getByTestId('attach-picture').getAttribute('aria-label')).toBe('Attach a picture')
  })
})
