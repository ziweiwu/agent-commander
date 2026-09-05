import { useEffect, useRef } from 'react'
import { Outlet, useParams, useLocation, useNavigate } from 'react-router-dom'
import { hasTranscripts } from '../../shared/agent-kinds.ts'
import { useStore } from '../store/store.ts'
import { focusAgent, setAttached } from '../store/transport.ts'
import { countByGroup, type StatusFilter } from '../lib/filter.ts'
import { useIsNarrow, useLayout } from '../hooks/useMediaQuery.ts'
import { useVisualViewport } from '../hooks/useVisualViewport.ts'
import { useFleetTrees } from '../hooks/useFleetTrees.ts'
import { useTranslate } from '../hooks/useTranslate.ts'
import { FleetList } from './FleetList.tsx'
import { AgentDetail } from './AgentDetail.tsx'
import { NewAgentDialog } from './NewAgentDialog.tsx'
import { SettingsMenu } from './SettingsMenu.tsx'
import { NotifyButton, NotifyNudge } from './NotifyButton.tsx'
import { Button, Chip } from './ui/Button.tsx'
import { UsageChips } from './UsageChips.tsx'
import styles from './App.module.css'

/** Holds the delegation-graph poll while the fleet list is unmounted. */
function TreePoll() {
  useFleetTrees()
  return null
}

/** Shell: topbar, layout, global keyboard. Routes render through `Outlet`. */
export function App() {
  const t = useTranslate()
  const navigate = useNavigate()
  const location = useLocation()
  const narrow = useIsNarrow()
  const layout = useLayout()
  // Stamped on the root so a stylesheet, a test or a person in DevTools can
  // read which of the three layouts is on, rather than inferring it.
  useEffect(() => {
    document.documentElement.dataset.layout = layout
  }, [layout])
  // The height the sheet actually has once an on-screen keyboard is up.
  useVisualViewport()

  const mock = useStore((s) => s.mock)
  const conn = useStore((s) => s.conn)
  const toast = useStore((s) => s.toast)
  const selected = useStore((s) => s.selected)
  const fullscreen = useStore((s) => s.fullscreen)
  const newAgentOpen = useStore((s) => s.newAgentOpen)
  const setNewAgentOpen = useStore((s) => s.setNewAgentOpen)
  const setFullscreen = useStore((s) => s.setFullscreen)
  const setQuery = useStore((s) => s.setQuery)

  const searchRef = useRef<HTMLInputElement>(null)
  const isHelp = location.pathname.startsWith('/help')
  // Help takes the whole page, so it leaves no agent selected behind it and
  // has no fleet to filter.
  const solo = isHelp
  const sheetMode = narrow && selected !== null && !solo

  // Modals and the mobile sheet own the screen; the page behind must not scroll.
  useEffect(() => {
    document.body.classList.toggle('no-scroll', sheetMode || newAgentOpen || fullscreen)
  }, [sheetMode, newAgentOpen, fullscreen])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      /*
       * Narrowed rather than asserted. `e.target` is an `EventTarget`, and the
       * cast to `HTMLElement` was a promise the DOM does not make: an event
       * dispatched at `document` has a target with no `closest`, so every
       * branch below threw before it could run. A real keypress targets an
       * element, so this was not something a user could reach by typing — but
       * the handler's job is to answer "was this typed into a field", and
       * "into something that is not an element" has an answer: no.
       */
      const target = e.target instanceof HTMLElement ? e.target : null
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.closest('[data-testid="term-wrap"]') !== null

      if (e.key === '/' && !typing) {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
        return
      }

      // Shift+Escape steps back one level rather than leaving outright. From
      // full screen that means the panel, not the list: jumping straight to the
      // list threw away two levels at once and left focus on <body>, and from
      // the terminal — where plain Escape belongs to the agent — this is the
      // only way out, so it has to be the predictable one.
      if (e.key === 'Escape' && e.shiftKey && selected) {
        e.preventDefault()
        if (fullscreen) setFullscreen(false)
        else navigate('/')
        return
      }

      if (e.key === 'Escape') {
        if (newAgentOpen) {
          e.preventDefault()
          setNewAgentOpen(false)
          return
        }
        // Checked before full screen, not after. Plain Escape inside the
        // terminal interrupts the agent (INV-6 guards it with a confirmation),
        // and it must not also collapse the view out from under that dialog —
        // which is what answering the confirmation used to do.
        if (target?.closest('[data-testid="term-wrap"]')) return
        if (fullscreen) {
          e.preventDefault()
          setFullscreen(false)
          return
        }
        if (target === searchRef.current && searchRef.current?.value) {
          setQuery('')
          return
        }
        if (selected) {
          e.preventDefault()
          navigate('/')
        }
        return
      }

      if (typing && target !== searchRef.current) return

      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault()
        moveCardFocus(1)
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault()
        moveCardFocus(-1)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [selected, newAgentOpen, fullscreen, navigate, setNewAgentOpen, setFullscreen, setQuery])

  return (
    // `data-sheet` as well as the class: CSS Modules hashes the class name, so
    // another module's stylesheet cannot reach it, and `UsageChips` needs to
    // know it is inside a sheet — that is where the height it costs is taken
    // from the conversation.
    <div
      className={`${styles.app} ${sheetMode ? styles.sheetMode : ''}`}
      data-sheet={sheetMode ? 'true' : undefined}
    >
      {mock && (
        <div className={styles.mockBanner}>mock mode — fixtures, nothing real is touched</div>
      )}

      <header className={styles.topbar}>
        <h1 className={styles.title}>
          agent<span>-commander</span>
        </h1>
        {solo ? <span className={styles.spacer} /> : <Filters />}
        <UsageChips />
        <Button
          variant="icon"
          data-testid="help-button"
          title={t('help')}
          aria-label={t('help')}
          aria-pressed={isHelp}
          onClick={() => navigate(isHelp ? '/' : '/help')}
        >
          ?
        </Button>
        <NotifyButton />
        <SettingsMenu />
        <div className={styles.conn} data-testid="connection-status" data-state={conn}>
          {t(conn === 'open' ? 'connLive' : conn === 'closed' ? 'connReconnecting' : 'connConnecting')}
        </div>
      </header>

      <NotifyNudge />

      <Outlet context={{ searchRef, narrow }} />

      <NewAgentDialog />
      {toast && (
        <div className={styles.toast} role="status" data-testid="toast">
          {toast}
        </div>
      )}
      <div className="sr-only" id="live-region" role="status" aria-live="polite" />
    </div>
  )
}

function Filters() {
  const t = useTranslate()
  const agents = useStore((s) => s.agents)
  const filter = useStore((s) => s.fleet.filter)
  const setFilter = useStore((s) => s.setFilter)
  const counts = countByGroup(agents)

  const chip = (key: StatusFilter, label: string, count: number) => (
    <Chip
      key={key}
      data-testid="filter-chip"
      data-key={key}
      aria-pressed={filter === key}
      onClick={() => setFilter(filter === key ? 'all' : key)}
    >
      {/*
        * A glyph, not just the fill colour. The filter now survives a reload,
        * so the common case is arriving at a dashboard that is already filtered
        * without having just clicked anything — and "8 agents are hidden" read
        * only from a hue difference is how this app comes to look like agents
        * vanished. aria-hidden because aria-pressed already says it.
        */}
      {filter === key && key !== 'all' && (
        <span className={styles.chipMark} aria-hidden="true">
          ✓
        </span>
      )}
      <b>{count}</b> {label}
    </Chip>
  )

  return (
    <div className={styles.filters}>
      {chip('all', t('filterAll'), agents.length)}
      {counts.waiting > 0 && chip('waiting', t('filterWaiting'), counts.waiting)}
      {counts.busy > 0 && chip('busy', t('filterBusy'), counts.busy)}
      {counts.idle > 0 && chip('idle', t('filterIdle'), counts.idle)}
    </div>
  )
}

function moveCardFocus(delta: number): void {
  const list = [...document.querySelectorAll<HTMLElement>('[data-testid="agent-card"]')]
  if (list.length === 0) return
  const active = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(
    '[data-testid="agent-card"]',
  )
  const index = active ? list.indexOf(active) : -1
  const next = list[Math.max(0, Math.min(list.length - 1, index + delta))] ?? list[0]
  next?.focus()
}

/**
 * The fleet route. The URL owns which agent is open; this keeps the transport's
 * idea of "focused" in step with it, including on a reload straight into
 * /agent/:sessionId.
 */
/**
 * How long the browser will wait for a session it was told exists.
 *
 * The registry scans every 2s, so this is that with room for a busy machine.
 * Bounded because an expectation this app cannot keep must expire rather than
 * leave the panel blank indefinitely (INV-11).
 */
const EXPECT_MS = 8000

export function FleetRoute() {
  const navigate = useNavigate()
  const narrow = useIsNarrow()
  const { sessionId } = useParams()
  const location = useLocation()
  const agents = useStore((s) => s.agents)
  const selected = useStore((s) => s.selected)
  const expectSession = useStore((s) => s.expectSession)
  const setExpectSession = useStore((s) => s.setExpectSession)
  const tab = useStore((s) => s.tab)
  const searchRef = useRef<HTMLInputElement>(null)

  const wantTab = location.pathname.endsWith('/term') ? 'attach' : 'chat'
  const agent = agents.find((a) => a.sessionId === sessionId)

  useEffect(() => {
    focusAgent(sessionId ?? null)
  }, [sessionId])

  /*
   * An agent whose CLI keeps no readable transcript is redirected to the
   * terminal, because its Chat tab is hidden and landing on it would leave the
   * panel showing nothing with no visible way back.
   *
   * A *blocked* agent used to be redirected here too, on the grounds that only
   * the terminal could answer its dialog. That is no longer true: the Chat tab
   * reads the question out of the transcript and offers its options (INV-16),
   * so sending the user to a capture of somebody else's terminal now takes them
   * away from the better surface rather than towards the only one. The blocked
   * banner keeps its "Open terminal" button for the prompts that cannot be
   * named, which is the case that redirect was really serving.
   */
  useEffect(() => {
    if (!agent || wantTab !== 'chat' || !agent.paneId) return
    if (!hasTranscripts(agent.agentKind)) {
      navigate(`/agent/${agent.sessionId}/term`, { replace: true })
    }
  }, [agent?.sessionId, agent?.paneId, agent?.agentKind, wantTab, navigate, agent])

  /*
   * The route decides the tab; the attachment follows it here for the Attach
   * tab, whose terminal is the one watcher that does not detach itself. The
   * Chat tab's peek attaches and detaches on its own and waits for `tab` to
   * read 'chat' before it does — this effect runs after it, since React runs
   * a child's effects first, and would otherwise detach it straight away.
   */
  useEffect(() => {
    if (!sessionId) return
    useStore.setState({ tab: wantTab })
    setAttached(wantTab === 'attach')
  }, [sessionId, wantTab])

  /*
   * The agent ended while it was open — but *only* that, and telling it apart
   * from an agent that has not arrived yet is the whole of this effect.
   *
   * `/clear` replaces a session rather than editing it, so straight after one
   * the URL names an id the registry has not scanned for. Without the
   * exception below this rule fired instantly and sent the user back to the
   * fleet every single time they cleared an agent, which reads exactly like the
   * panel closing itself.
   *
   * The wait is bounded. A session that never appears is a claim this app
   * cannot keep, and leaving the panel blank forever is worse than admitting
   * it: the expectation is dropped after `EXPECT_MS` and the ordinary rule
   * takes over.
   */
  useEffect(() => {
    if (!expectSession) return
    if (agents.some((a) => a.sessionId === expectSession)) {
      setExpectSession(null)
      return
    }
    const timer = window.setTimeout(() => setExpectSession(null), EXPECT_MS)
    return () => window.clearTimeout(timer)
  }, [expectSession, agents, setExpectSession])

  useEffect(() => {
    if (sessionId && sessionId === expectSession) return
    if (sessionId && agents.length > 0 && !agent) navigate('/', { replace: true })
  }, [sessionId, agent, agents, expectSession, navigate])

  const showDetail = Boolean(agent)

  return (
    <main className={`${styles.layout} ${showDetail ? '' : styles.solo}`}>
      {!(narrow && showDetail) && (
        <FleetList
          tiled={!showDetail}
          selected={selected}
          searchRef={searchRef}
          onSelect={(id) => navigate(`/agent/${id}`)}
        />
      )}
      {/*
        * The list is the graph's holder (INV-4: one poll for the fleet), and
        * on a phone the sheet unmounts it. The detail's status line still
        * reads the delegates, so while the list is away this takes the poll
        * over — one holder at a time, never two.
        */}
      {narrow && showDetail && <TreePoll />}
      {agent && (
        <AgentDetail
          agent={agent}
          tab={tab}
          sheet={narrow}
          onTab={(next) =>
            navigate(next === 'attach' ? `/agent/${agent.sessionId}/term` : `/agent/${agent.sessionId}`)
          }
          onClose={() => navigate('/')}
        />
      )}
    </main>
  )
}
