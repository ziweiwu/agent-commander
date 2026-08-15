/**
 * Setup for component tests.
 *
 * jsdom implements neither matchMedia nor the layout APIs xterm and the chat
 * scroller reach for, so they are stubbed here rather than guarded for in the
 * components — production code should not carry test scaffolding.
 */
import { afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'

afterEach(() => {
  cleanup()
  // jsdom does not always expose storage; preferences are not what these test.
  globalThis.localStorage?.clear()
  document.documentElement.removeAttribute('data-theme')
})

/** Default to a wide, fine-pointer desktop; individual tests override. */
export function setViewport(matches: (query: string) => boolean): void {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: matches(query),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  )
}

setViewport(() => false)

// The chat scroller writes to these; jsdom reports zero for all layout.
Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { value: 0, writable: true })
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { value: 0, writable: true })
