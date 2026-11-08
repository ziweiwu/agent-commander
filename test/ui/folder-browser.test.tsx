/**
 * INV-9's refusal of a relative path, as the folder browser shows it.
 *
 * The server says it in English (`browse::NOT_ABSOLUTE`); the browser matches
 * that exact text and shows the reader's own language. The two copies of the
 * string live in two languages, so this file holds them together.
 */
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { FolderBrowser, SERVER_NOT_ABSOLUTE } from '../../src/web/components/FolderBrowser.tsx'
import { useStore } from '../../src/web/store/store.ts'
import { renderApp, resetStore } from './helpers.tsx'

const browseDirs = vi.hoisted(() => vi.fn())
vi.mock('../../src/web/store/transport.ts', () => ({ browseDirs }))

beforeEach(() => {
  resetStore()
  browseDirs.mockReset()
})

describe('INV-9 folder browser refusals', () => {
  it('matches the text the server refuses a relative path with', () => {
    const server = readFileSync('rust/src/browse.rs', 'utf8')
    expect(server).toContain(`pub const NOT_ABSOLUTE: &str = "${SERVER_NOT_ABSOLUTE}";`)
  })

  it('shows the relative-path refusal in the reader’s language', async () => {
    browseDirs.mockRejectedValue(new Error(SERVER_NOT_ABSOLUTE))
    useStore.setState({ lang: 'zh-CN' })
    renderApp(<FolderBrowser start="Projects" onChoose={() => {}} />)
    expect(await screen.findByText('请使用绝对路径或以 ~/ 开头的路径')).toBeTruthy()
  })

  it('still wraps any other refusal in the generic message', async () => {
    browseDirs.mockRejectedValue(new Error('that directory is outside the browsable root'))
    useStore.setState({ lang: 'en' })
    renderApp(<FolderBrowser start="/etc" onChoose={() => {}} />)
    expect(
      await screen.findByText('Could not read that folder: that directory is outside the browsable root'),
    ).toBeTruthy()
  })
})
