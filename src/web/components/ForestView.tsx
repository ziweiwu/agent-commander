import { AXIS_CEIL_S, MAX_LANES, place, duration } from '../lib/forest.ts'
import type { Family, Lane } from '../lib/forest.ts'
import { specOf } from '../../shared/agent-kinds.ts'
import { displayName } from '../lib/naming.ts'
import { useLang, useTranslate } from '../hooks/useTranslate.ts'
import type { Lang } from '../lib/i18n.ts'
import { useStatusText } from './AgentCard.tsx'
import styles from './ForestView.module.css'

const MINUTE_S = 60
const HOUR_S = 3600

/**
 * Where the one ruler is labelled.
 *
 * The left end is the lib's own ceiling rather than a number written out again
 * here, so a tick can never name a position the axis does not actually reach.
 */
const TICKS: readonly number[] = [AXIS_CEIL_S, HOUR_S, 10 * MINUTE_S, MINUTE_S, 0]

/**
 * How far a delegate is allowed to indent before the indent starts eating the
 * lane. Depth is unbounded in principle; the axis is the thing worth keeping.
 */
const MAX_INDENT_DEPTH = 3
const INDENT_PX = 14

function clockTime(lang: Lang, wroteAt: number): string {
  if (!Number.isFinite(wroteAt)) return ''
  return new Date(wroteAt).toLocaleTimeString(lang === 'zh-CN' ? 'zh-CN' : undefined, {
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * The caption beside a lane.
 *
 * While the fleet is live it is an age. Once it is not, it becomes a clock
 * time — an age is read as an age however long ago it was measured, so "4m"
 * twenty minutes after the last reading is not merely out of date, it is
 * wrong. Changing the claim is the honest move; dimming the row is not, and is
 * measured to lower confidence in a reading without stopping anyone acting on
 * it.
 *
 * The clock time is the moment the readings were taken, less how old the lane
 * was at that moment. With no reading time there is no honest caption at all,
 * so there is none — the mark still carries the shape and the banner says why
 * the number is missing.
 */
function liveCaption(lane: Lane): string {
  return lane.secs === null ? '' : duration(lane.secs)
}

function frozenCaption(lane: Lane, staleSince: number | null, lang: Lang): string {
  if (lane.secs === null || staleSince === null) return ''
  return clockTime(lang, staleSince - lane.secs * 1000)
}

function staleMessage(since: string): string {
  if (!since) {
    return (
      'Not live — everything below is the last state this app read, and it cannot say when it ' +
      'read it. The times are clock times rather than ages.'
    )
  }
  return (
    `Not live — everything below is the last state this app read, at ${since}. The times are clock ` +
    'times rather than ages, because an age would keep counting and stop being true.'
  )
}

/**
 * One ruler for the whole view.
 *
 * This is why the forest is a single column. Two columns need two rulers, and
 * then nothing on the left can be compared with anything on the right by eye —
 * which is the only reason to draw an axis in the first place. The ticks are
 * positioned with `place()`, the same function the marks use, so each sits over
 * the position it names; the axis shares the lanes' grid so it shares their
 * horizontal origin, and a ruler that does not is worse than no ruler at all.
 *
 * Hidden from assistive tech: the positions the ticks calibrate are invisible
 * there anyway, and each mark's own label already carries its duration in
 * words.
 */
function Axis() {
  return (
    <div className={styles.axis} data-testid="forest-axis" aria-hidden="true">
      <span className={styles.track}>
        <span className={styles.plot}>
          {TICKS.map((secs, i) => (
            <span
              key={secs}
              className={styles.tick}
              data-edge={i === 0 ? 'start' : i === TICKS.length - 1 ? 'end' : undefined}
              style={{ left: `${place(secs) * 100}%` }}
            >
              {secs === 0 ? 'now' : duration(secs)}
            </span>
          ))}
        </span>
      </span>
    </div>
  )
}

interface LaneRowProps {
  lane: Lane
  sessionId: string
  selected: boolean
  stale: boolean
  staleSince: number | null
  onOpen: (sessionId: string) => void
}

/**
 * One lane: who it is, where its last sign of life sits on the shared axis.
 *
 * **A lane whose `secs` is null gets no mark at all.** A mark has to go
 * somewhere, and the only place left for "no timestamp" is the far-left edge,
 * which is the position meaning "silent for six hours" — a claim nothing here
 * can make. It reads *never prompted* instead. That is INV-11 in one row, and
 * it applies to a delegate exactly as it does to a session.
 *
 * The mark carries `lane.describe` as its label because position is invisible
 * to a screen reader; the visible caption is hidden from one, so the duration
 * is heard once rather than twice.
 *
 * The position is `lane.at`, which the lib has already run through `place()`.
 * Placing it again here would put two copies of the axis's scale in the app,
 * and the ruler is drawn from the one in the lib.
 */
function LaneRow({ lane, sessionId, selected, stale, staleSince, onOpen }: LaneRowProps) {
  const t = useTranslate()
  const lang = useLang()
  const marked = lane.secs !== null

  return (
    <button
      type="button"
      className={styles.lane}
      data-testid="forest-lane"
      data-depth={lane.depth}
      data-marked={marked}
      aria-current={selected}
      onClick={() => onOpen(sessionId)}
    >
      <span
        className={styles.label}
        style={{ paddingLeft: `${Math.min(lane.depth, MAX_INDENT_DEPTH) * INDENT_PX}px` }}
      >
        {lane.label}
      </span>

      <span className={styles.track}>
        <span className={styles.plot}>
          {lane.secs === null ? (
            <span className={styles.never}>never prompted</span>
          ) : (
            <span
              className={styles.mark}
              data-testid="forest-mark"
              role="img"
              aria-label={lane.describe}
              data-state={lane.state}
              data-inferred={lane.inferred}
              style={{ left: `${lane.at * 100}%` }}
            />
          )}
        </span>
      </span>

      <span className={styles.when} aria-hidden="true">
        {stale ? frozenCaption(lane, staleSince, lang) : liveCaption(lane)}
      </span>

      {lane.orphan && (
        <span className={styles.orphan} data-testid="forest-orphan">
          <span aria-hidden="true">△</span> {t('treeReparented', { name: lane.label })}
        </span>
      )}
    </button>
  )
}

interface FamilyBlockProps {
  family: Family
  selected: boolean
  stale: boolean
  staleSince: number | null
  onOpen: (sessionId: string) => void
}

/**
 * One session and everything it handed out.
 *
 * The status comes from `useStatusText`, the fleet card's own function, so the
 * two views can never name one state two different ways. The counts ride as
 * data attributes rather than as a second sentence: `summary` is already the
 * prose, and repeating it beside itself is how a header grows to three lines.
 */
function FamilyBlock({ family, selected, stale, staleSince, onOpen }: FamilyBlockProps) {
  const t = useTranslate()
  const statusText = useStatusText()
  const agent = family.agent

  return (
    <section
      className={styles.family}
      data-testid="forest-family"
      data-session-id={family.sessionId}
      data-status={agent.status}
      data-selected={selected}
      data-total={family.total}
      data-running={family.running}
    >
      <div className={styles.head}>
        <h2 className={styles.name}>{displayName(agent)}</h2>
        <span
          className={styles.pill}
          data-status={agent.status}
          data-inferred={agent.statusInferred === true}
        >
          {statusText(agent)}
        </span>
        {family.summary && <p className={styles.summary}>{family.summary}</p>}
      </div>

      <LaneRow
        lane={family.self}
        sessionId={family.sessionId}
        selected={selected}
        stale={stale}
        staleSince={staleSince}
        onOpen={onOpen}
      />
      {family.lanes.map((lane) => (
        <LaneRow
          key={lane.key}
          lane={lane}
          sessionId={family.sessionId}
          selected={selected}
          stale={stale}
          staleSince={staleSince}
          onOpen={onOpen}
        />
      ))}

      {/* INV-13: an agent that has delegated nothing and one this app cannot
          ask are different claims, and drawing an empty family for both would
          be the dashboard asserting the first when it only knows the second. */}
      {family.unknownTree && (
        <p className={styles.note} data-testid="forest-unknown">
          {t('treeUnknown', { kind: specOf(agent.agentKind)?.label ?? agent.agentKind })}
        </p>
      )}

      {/* Folding is said out loud. Silently dropping lanes would leave a family
          that looks complete and is not, which is the one way a timeline can
          mislead without showing anything wrong. */}
      {family.hidden > 0 && (
        <p className={styles.note} data-testid="forest-hidden">
          {family.hidden} more {family.hidden === 1 ? 'delegate' : 'delegates'} folded away — this
          view draws at most {MAX_LANES} lanes for one session.
        </p>
      )}
    </section>
  )
}

export interface ForestViewProps {
  families: Family[]
  stale: boolean
  staleSince: number | null
  selected: string | null
  onOpen: (sessionId: string) => void
}

/**
 * The fleet as a forest: every session with what it delegated, on one axis.
 *
 * `ARCHITECTURE.md` has the module graph; what matters here is that the axis is
 * the mechanic. Everything about the layout — one column, one ruler, one
 * horizontal origin shared by the ruler and every lane under it, a label track
 * that gives way on a narrow screen before the lane does — exists to keep two
 * marks in different families comparable by eye.
 */
export function ForestView({ families, stale, staleSince, selected, onOpen }: ForestViewProps) {
  const lang = useLang()

  return (
    <div className={styles.view} data-testid="forest-view" data-stale={stale}>
      {/*
        INV-11's caveat, said once for the whole view rather than once per row.

        Present and empty from the first render on purpose. A live region that
        arrives already carrying its text is frequently not announced at all —
        the region has to be there for the browser to notice the text landing
        in it — and one region per row would announce the same sentence as many
        times as there are lanes.
      */}
      <p className={styles.stale} data-testid="forest-stale" data-empty={!stale} role="status">
        {stale ? staleMessage(staleSince === null ? '' : clockTime(lang, staleSince)) : ''}
      </p>

      <Axis />

      {families.map((family) => (
        <FamilyBlock
          key={family.sessionId}
          family={family}
          selected={family.sessionId === selected}
          stale={stale}
          staleSince={staleSince}
          onOpen={onOpen}
        />
      ))}
    </div>
  )
}
