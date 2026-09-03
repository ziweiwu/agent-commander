/**
 * The sheet is sized from the visual viewport, so an iOS keyboard does not
 * cover the composer (FR-UI-19).
 *
 * jsdom has no visual viewport, so one is stood in for; what is asserted is
 * the contract the stylesheet reads — the variable and the attribute on the
 * root — and that Safari's pan is undone once the sheet fits.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import {
  useVisualViewport,
  VIEWPORT_HEIGHT_VAR,
  VIEWPORT_TOP_VAR,
} from '../../src/web/hooks/useVisualViewport.ts'

class FakeVisualViewport extends EventTarget {
  height = 844
  offsetTop = 0
  resize(height: number): void {
    this.height = height
    this.dispatchEvent(new Event('resize'))
  }
}

let vv: FakeVisualViewport

beforeEach(() => {
  vv = new FakeVisualViewport()
  vi.stubGlobal('visualViewport', vv)
  Object.defineProperty(window, 'innerHeight', { value: 844, configurable: true })
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const root = () => document.documentElement

describe('useVisualViewport', () => {
  it('writes the visible height to the root, keyboard or not', () => {
    renderHook(() => useVisualViewport())
    expect(root().style.getPropertyValue(VIEWPORT_HEIGHT_VAR)).toBe('844px')
    expect(root().dataset.keyboard).toBeUndefined()
  })

  it('shrinks the sheet and marks the keyboard when the viewport drops', () => {
    renderHook(() => useVisualViewport())
    vv.resize(390)
    expect(root().style.getPropertyValue(VIEWPORT_HEIGHT_VAR)).toBe('390px')
    expect(root().dataset.keyboard).toBe('true')
  })

  /*
   * Safari pans the visual viewport as well as shrinking it. A sheet that only
   * shrank sat at the top of a layout viewport whose top was off screen, so
   * the reader saw its lower half and the empty document below — which reads
   * as nothing having adjusted at all. The sheet follows the pan.
   */
  it('follows the pan, so the sheet covers exactly the visible rectangle', () => {
    renderHook(() => useVisualViewport())
    vv.offsetTop = 120
    vv.resize(390)
    expect(root().style.getPropertyValue(VIEWPORT_TOP_VAR)).toBe('120px')
    vv.offsetTop = 200
    vv.dispatchEvent(new Event('scroll'))
    expect(root().style.getPropertyValue(VIEWPORT_TOP_VAR)).toBe('200px')
  })

  /*
   * The terminal's textarea rides the cursor, which may sit on a row the
   * shrunken pane has scrolled under the keyboard. Once the layout has the new
   * height, the focused field is brought back inside its own scroller.
   */
  it('brings the focused field back into view once the sheet has shrunk', () => {
    const field = document.createElement('textarea')
    document.body.append(field)
    field.scrollIntoView = vi.fn()
    field.focus()
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
      fn(0)
      return 1
    })
    renderHook(() => useVisualViewport())
    vv.resize(390)
    expect(field.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    field.remove()
  })

  it('grows back and clears the mark when the keyboard goes', () => {
    renderHook(() => useVisualViewport())
    vv.resize(390)
    vv.resize(844)
    expect(root().style.getPropertyValue(VIEWPORT_HEIGHT_VAR)).toBe('844px')
    expect(root().dataset.keyboard).toBeUndefined()
  })

  it('leaves nothing behind when it unmounts', () => {
    const { unmount } = renderHook(() => useVisualViewport())
    vv.resize(390)
    unmount()
    expect(root().style.getPropertyValue(VIEWPORT_HEIGHT_VAR)).toBe('')
    expect(root().dataset.keyboard).toBeUndefined()
  })
})
