/**
 * The on-screen keyboard, as a number.
 *
 * Two platforms, two behaviours. Android Chrome honours the viewport meta's
 * `interactive-widget=resizes-content`, so an open keyboard shrinks the layout
 * viewport and `100dvh` shrinks with it. iOS Safari ignores that hint: the
 * layout viewport keeps its height, only the *visual* viewport shrinks, and
 * Safari pans it to keep the focused field on screen — so a sheet sized in
 * `dvh` keeps its composer under the keyboard and its header off the top.
 *
 * `window.visualViewport` reports the truth on both. Its height is what is
 * actually visible, keyboard or not, so a sheet sized from it fits above the
 * keyboard on Safari and is a no-op on Chrome, where the two heights agree.
 */

/** How much shorter than the layout the visual viewport has to be to mean a keyboard. */
const KEYBOARD_MIN_PX = 120

export interface ViewportReading {
  /** Height of the visual viewport, in CSS pixels. */
  visualHeight: number
  /** Height of the layout viewport (`window.innerHeight`). */
  layoutHeight: number
}

export interface KeyboardState {
  /** The height the app should lay itself out in. */
  height: number
  /** Whether an on-screen keyboard is the likely reason for the difference. */
  keyboardOpen: boolean
}

/**
 * A URL bar collapsing or a browser chrome change moves the visual viewport by
 * tens of pixels; a keyboard moves it by hundreds. The threshold separates the
 * two so the page does not treat every scroll as a keyboard.
 */
export function keyboardState(reading: ViewportReading): KeyboardState {
  const height = Math.round(reading.visualHeight)
  const keyboardOpen = reading.layoutHeight - reading.visualHeight >= KEYBOARD_MIN_PX
  return { height, keyboardOpen }
}
