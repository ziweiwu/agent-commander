import { useId, type KeyboardEvent } from 'react'

/** One tab in a list: its key, and whether it can be chosen at all. */
export interface TabSpec<K extends string> {
  key: K
  disabled?: boolean
}

/** What the arrows, Home and End do: where focus moves from `at` in a list of `count`. */
const STEPS: Readonly<Record<string, (at: number, count: number) => number>> = {
  ArrowRight: (at, count) => (at + 1) % count,
  ArrowLeft: (at, count) => (at - 1 + count) % count,
  Home: () => 0,
  End: (_at, count) => count - 1,
}

/**
 * The APG tabs pattern with manual activation, for a list of tab buttons.
 *
 * The selected tab is the list's one Tab stop, and the arrows, Home and End
 * move focus between the enabled tabs without selecting any: Enter or Space,
 * which a button already turns into a click, is what selects. On this app an
 * arrow therefore never mounts a terminal; attaching still takes a press
 * (INV-1, INV-2). The content is a panel labelled by the selected tab.
 */
export function useTabs<K extends string>(tabs: readonly TabSpec<K>[], selected: K) {
  const base = useId()
  const tabId = (key: K): string => `${base}-tab-${key}`
  const panelId = `${base}-panel`
  const enabled = tabs.filter((tab) => !tab.disabled)
  const stop = enabled.find((tab) => tab.key === selected)?.key ?? enabled[0]?.key
  const shown = tabs.some((tab) => tab.key === selected) ? selected : (stop ?? selected)

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const step = STEPS[event.key]
    if (!step) return
    const buttons = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]:not([disabled])')]
    const at = buttons.findIndex((button) => button === document.activeElement)
    if (at < 0) return
    event.preventDefault()
    buttons[step(at, buttons.length)]?.focus()
  }

  return {
    listProps: { role: 'tablist', onKeyDown },
    tabProps: (key: K) => ({
      role: 'tab',
      id: tabId(key),
      tabIndex: key === stop ? 0 : -1,
      'aria-selected': key === selected,
      'aria-controls': panelId,
    }),
    panelProps: { role: 'tabpanel', id: panelId, 'aria-labelledby': tabId(shown) },
  } as const
}
