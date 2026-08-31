/**
 * Application state.
 *
 * Zustand holds the state; `transport.ts` owns the WebSocket and writes into it
 * from outside React. Keeping the socket out of the component tree matters
 * because the terminal streams frames ~7x a second — that cadence should not be
 * expressed as a React effect.
 */
import { create } from 'zustand'
import type { Agent, Frame, NewAgentResponse, RateLimits, ServerEnv, TimelineEvent } from '../../shared/types.ts'
import {
  buildMessages,
  countSaid,
  pendingMessage,
  reconcile,
  type ChatMessage,
} from '../lib/chat.ts'
import type { FleetState, SortDir, SortKey, StatusFilter } from '../lib/filter.ts'
import { translate, type Key, type Lang } from '../lib/i18n.ts'
import {
  applyLang,
  applyScheme,
  applyTheme,
  loadDir,
  loadFilter,
  loadLang,
  loadSort,
  loadScheme,
  loadTheme,
  loadNotify,
  saveDir,
  saveFilter,
  saveLang,
  saveSort,
  saveScheme,
  saveTheme,
  saveNotify,
  type Scheme,
  type Theme,
} from '../lib/prefs.ts'

export type Tab = 'chat' | 'attach'
export type Conn = 'connecting' | 'open' | 'closed'

export interface AppState {
  /* server-driven */
  agents: Agent[]
  /**
   * When `agents` last arrived from the server.
   *
   * INV-11: while the socket is down the cards still hold the last values, and
   * a card saying "waiting · dialog open" is a claim about *now*. This is what
   * lets the view say when it stopped being able to make that claim.
   */
  fleetAt: number | null
  /** Account-level quota, or null when nothing has reported it. */
  limits: RateLimits | null
  env: ServerEnv | null
  mock: boolean
  conn: Conn

  /* selection — the router owns the URL, this mirrors it for the transport */
  selected: string | null
  tab: Tab
  fullscreen: boolean
  newAgentOpen: boolean

  fleet: FleetState
  notify: boolean
  theme: Theme
  scheme: Scheme
  lang: Lang

  events: TimelineEvent[]
  messages: ChatMessage[]
  pending: ChatMessage[]
  pendingSeq: number

  frame: Frame | null
  toast: string | null
  /** Sessions whose pane the server told us has exited. */
  exited: string[]
  /**
   * A session this app knows exists but has not seen in a fleet broadcast yet.
   *
   * `/clear` replaces a session rather than editing it, so the moment it lands
   * the browser is looking at an id the registry has not scanned for — up to a
   * couple of seconds. The route's "the agent ended while it was open" rule
   * cannot tell that apart from a session that really has gone, and bounced the
   * user to the fleet immediately after every clear.
   *
   * The same distinction `PendingStore` makes on the server for a just-started
   * agent, made here for a just-cleared one.
   */
  expectSession: string | null

  /* actions */
  setNotify: (notify: boolean) => void
  setTheme: (theme: Theme) => void
  setScheme: (scheme: Scheme) => void
  setLang: (lang: Lang) => void
  setQuery: (query: string) => void
  setFilter: (filter: StatusFilter) => void
  setSort: (sort: SortKey) => void
  setDir: (dir: SortDir) => void
  setFullscreen: (on: boolean) => void
  setNewAgentOpen: (open: boolean) => void
  showToast: (message: string) => void
  markExited: (sessionId: string) => void
  /** Expect a session the fleet has not broadcast yet; null once it arrives. */
  setExpectSession: (sessionId: string | null) => void
  addPending: (text: string) => void
  rebuildChat: () => void
  resetConversation: () => void
  t: (key: Key, vars?: Record<string, string | number>) => string
}

/**
 * How long a locally-echoed message waits for the transcript to confirm it.
 *
 * Generous on purpose: the transcript is read by polling and a busy agent can
 * take a moment to write the prompt out. This only has to be shorter than the
 * point at which a user decides the app is broken.
 */
const CONFIRM_TIMEOUT_MS = 12_000

const pendingTimers = new Map<string, number>()

function clearPendingTimer(id: string): void {
  const timer = pendingTimers.get(id)
  if (timer === undefined) return
  window.clearTimeout(timer)
  pendingTimers.delete(id)
}

let toastTimer: number | undefined

export const useStore = create<AppState>()((set, get) => ({
  agents: [],
  fleetAt: null,
  limits: null,
  env: null,
  // Read from the document rather than waiting for the first WebSocket frame.
  // Arriving late meant the banner was inserted after the page had painted,
  // pushing everything below it down 28px for a CLS of 0.121.
  mock: typeof document !== 'undefined' && document.documentElement.dataset.mock === 'true',
  conn: 'connecting',

  selected: null,
  tab: 'chat',
  fullscreen: false,
  newAgentOpen: false,

  // Filter, sort and direction are restored together: they are one arrangement
  // of the fleet, and restoring half of it puts the user in a view they never
  // chose. Query is deliberately *not* restored — an arrangement is a lasting
  // view, a search term is a one-off lookup that would be baffling to come back
  // to on a reload with no visible cause.
  fleet: { query: '', filter: loadFilter(), sort: loadSort(), dir: loadDir() },
  notify: loadNotify() === 'on',
  theme: loadTheme(),
  scheme: loadScheme(),
  lang: loadLang(),

  events: [],
  messages: [],
  pending: [],
  pendingSeq: 0,

  frame: null,
  toast: null,
  exited: [],
  expectSession: null,

  setNotify: (notify) => {
    saveNotify(notify ? 'on' : 'off')
    set({ notify })
  },

  setTheme: (theme) => {
    saveTheme(theme)
    applyTheme(theme)
    set({ theme })
  },

  setScheme: (scheme) => {
    saveScheme(scheme)
    applyScheme(scheme)
    set({ scheme })
  },

  setLang: (lang) => {
    saveLang(lang)
    applyLang(lang)
    set({ lang })
  },

  setQuery: (query) => set((s) => ({ fleet: { ...s.fleet, query } })),
  setFilter: (filter) => {
    saveFilter(filter)
    set((s) => ({ fleet: { ...s.fleet, filter } }))
  },
  setSort: (sort) => {
    saveSort(sort)
    set((s) => ({ fleet: { ...s.fleet, sort } }))
  },
  setDir: (dir) => {
    saveDir(dir)
    set((s) => ({ fleet: { ...s.fleet, dir } }))
  },
  setFullscreen: (fullscreen) => set({ fullscreen }),
  setNewAgentOpen: (newAgentOpen) => set({ newAgentOpen }),

  markExited: (sessionId) =>
    set((s) => (s.exited.includes(sessionId) ? s : { exited: [...s.exited, sessionId] })),
  showToast: (toast) => {
    window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => set({ toast: null }), 5000)
    set({ toast })
  },

  setExpectSession: (expectSession) => set({ expectSession }),

  /** Echo a sent message locally so sending feels instant. */
  addPending: (text) => {
    const { pendingSeq: seq, messages } = get()
    // How many copies of this text the conversation already holds, so the
    // transcript confirming *this* one can be told from it having recorded an
    // identical one earlier. `messages` is the right list to count: it holds
    // the confirmed conversation plus any echo still in flight, which is
    // exactly what this copy has to outnumber. See `reconcile`.
    const echo = pendingMessage(text, Date.now(), seq, countSaid(messages, text))
    set((s) => ({ pending: [...s.pending, echo], pendingSeq: seq + 1 }))
    get().rebuildChat()

    // INV-2 forbids resending, so this only ever *marks* the message. Left
    // alone it said "sending…" for ever, which reads as "still on its way"
    // rather than "this may never have arrived" — so the user waits instead of
    // checking the terminal. Marking it is the honest end state: the message
    // stays visible and unsent, and sending it again is the user's call.
    pendingTimers.set(
      echo.id,
      window.setTimeout(() => {
        pendingTimers.delete(echo.id)
        if (!get().pending.some((p) => p.id === echo.id)) return
        set((s) => ({
          // `pending` comes off as `failed` goes on: they are two states, not
          // two flags, and leaving both set left the message relying on CSS
          // declaration order to render the right one.
          pending: s.pending.map((p) =>
            p.id === echo.id ? { ...p, pending: false, failed: true } : p,
          ),
        }))
        get().rebuildChat()
      }, CONFIRM_TIMEOUT_MS),
    )
  },

  rebuildChat: () => {
    const { events, pending } = get()
    const messages = reconcile(buildMessages(events), pending)
    const survived = pending.filter((p) => messages.some((m) => m.id === p.id))
    // Anything the transcript has now confirmed no longer needs its timer.
    for (const p of pending) {
      if (!survived.includes(p)) clearPendingTimer(p.id)
    }
    set({ messages, pending: survived })
  },

  resetConversation: () => {
    for (const timer of pendingTimers.values()) window.clearTimeout(timer)
    pendingTimers.clear()
    set({ events: [], messages: [], pending: [], frame: null })
  },

  t: (key, vars) => translate(get().lang, key, vars),
}))

/** Apply persisted preferences before the first paint. */
export function initPreferences(): void {
  const { theme, scheme, lang } = useStore.getState()
  // Scheme first: `applyTheme` reads `--bg` back off the document to colour the
  // status bar, and before the scheme is on it would read the wrong palette's.
  applyScheme(scheme)
  applyTheme(theme)
  applyLang(lang)
  if (typeof matchMedia === 'function') {
    // A "system" preference must keep following the system while the app is open.
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (useStore.getState().theme === 'system') applyTheme('system')
    })
  }
}

export type { NewAgentResponse }
