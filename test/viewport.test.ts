/**
 * The on-screen keyboard as a number (FR-UI-19).
 *
 * iOS Safari shrinks only the visual viewport for its keyboard; Android
 * Chrome shrinks the layout viewport too. Reading the visual one gives both
 * the same answer, and the threshold keeps a collapsing URL bar from being
 * mistaken for a keyboard.
 */
import { describe, expect, it } from 'vitest'
import { keyboardState } from '../src/web/lib/viewport.ts'

describe('keyboardState', () => {
  it('reports the visual height as the height to lay out in', () => {
    expect(keyboardState({ visualHeight: 390.4, layoutHeight: 844 })).toEqual({
      height: 390,
      keyboardOpen: true,
    })
  })

  it('does not call a collapsing URL bar a keyboard', () => {
    expect(keyboardState({ visualHeight: 780, layoutHeight: 844 }).keyboardOpen).toBe(false)
  })

  it('is a no-op where the layout viewport already shrank with the keyboard', () => {
    // Android Chrome under `interactive-widget=resizes-content`.
    expect(keyboardState({ visualHeight: 420, layoutHeight: 420 })).toEqual({
      height: 420,
      keyboardOpen: false,
    })
  })
})
