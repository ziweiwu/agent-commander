import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../store/store.ts'
import { loadEnv, startAgent } from '../store/transport.ts'
import { tildePath } from '../lib/format.ts'
import { useTranslate } from '../hooks/useTranslate.ts'
import { useModalChrome } from '../hooks/useModalChrome.ts'
import type { Key } from '../lib/i18n.ts'
import { MODE_KEY, NEW_AGENT_MODES } from '../lib/modes.ts'
import { MODEL_ALIASES } from '../../shared/types.ts'
import { Button, Chip } from './ui/Button.tsx'
import { FolderBrowser } from './FolderBrowser.tsx'
import styles from './NewAgentDialog.module.css'

const RECENT_KEY = 'agent-commander.recentDirs'
const DEFAULT_DIR_KEY = 'agent-commander.defaultDir'
const RECENT_MAX = 6

/**
 * Modes settable at spawn time and the models on offer, both from the lists the
 * server validates against. `dontAsk` is in `SPAWN_MODES` and not in the cycle,
 * which is exactly the distinction this dialog needs.
 */
const MODES = NEW_AGENT_MODES
const MODELS = MODEL_ALIASES

function readList(key: string): string[] {
  try {
    const raw = localStorage.getItem(key)
    const list = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function rememberDir(dir: string): void {
  try {
    const next = [dir, ...readList(RECENT_KEY).filter((d) => d !== dir)].slice(0, RECENT_MAX)
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    /* preferences just won't stick */
  }
}

export function loadDefaultDir(): string {
  try {
    return localStorage.getItem(DEFAULT_DIR_KEY) ?? ''
  } catch {
    return ''
  }
}

function saveDefaultDir(dir: string): void {
  try {
    localStorage.setItem(DEFAULT_DIR_KEY, dir)
  } catch {
    /* preferences just won't stick */
  }
}

export function NewAgentDialog() {
  const t = useTranslate()
  const open = useStore((s) => s.newAgentOpen)
  const setOpen = useStore((s) => s.setNewAgentOpen)
  const agents = useStore((s) => s.agents)
  const env = useStore((s) => s.env)

  const [dir, setDir] = useState('')
  const [name, setName] = useState('')
  const [model, setModel] = useState('default')
  const [mode, setMode] = useState('default')
  const [browsing, setBrowsing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  /*
   * INV-2's lesson, on the one control that creates a process.
   *
   * `disabled={busy}` is React state and does not reach the DOM until React
   * flushes, so three submits dispatched in the same tick — key repeat, a
   * double click, a slow machine — all re-entered this before the attribute
   * landed and each fired its own `POST /api/agents`. In mock mode that is
   * three fixtures; in real mode it is three `tmux new-session … claude`
   * spawns from one click. The composer and the goal field already guard this
   * with a synchronously-cleared ref, for exactly the same reason.
   */
  const startingRef = useRef(false)
  const dirRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  // Declared before the focus effect below so it captures the trigger button
  // as the element to restore focus to, not the input we are about to focus.
  useModalChrome(rootRef, open)

  // Directories already in use are the likeliest places to want another agent.
  const suggestions = [...new Set([...readList(RECENT_KEY), ...agents.map((a) => a.cwd)])].slice(0, 8)
  /*
   * A first run has nothing to suggest: no recent folders, no agents whose
   * folders could be reused, no saved default. The form was then a bare text
   * field asking for a path, which is the worst possible first question. So
   * it opens on the folder browser instead, at home. The field stays empty:
   * picking a folder fills it, and typing a path still works.
   */
  const firstRun = suggestions.length === 0 && loadDefaultDir() === ''

  useEffect(() => {
    if (!open) return
    if (!env) void loadEnv()
    setError('')
    setBrowsing(firstRun)
    setDir((current) => current || loadDefaultDir())
    dirRef.current?.focus()
  }, [open, env, firstRun])

  if (!open) return null

  const noTmux = env?.tmux === false

  const close = () => {
    setBusy(false)
    setError('')
    setBrowsing(false)
    setOpen(false)
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!dir.trim() || startingRef.current) return
    startingRef.current = true
    setBusy(true)
    setError('')
    const result = await startAgent(dir.trim(), {
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(model !== 'default' ? { model } : {}),
      ...(mode !== 'default' ? { permissionMode: mode } : {}),
    })
    startingRef.current = false
    setBusy(false)
    if (result.ok) {
      rememberDir(result.cwd)
      setDir('')
      setName('')
      close()
      // The new process registers itself; the fleet picks it up on the next tick.
    } else {
      setError(t('newAgentFailed', { error: result.error }))
    }
  }

  return createPortal(
    <div ref={rootRef}>
      <div className={styles.backdrop} onClick={close} />
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-label={t('newAgentTitle')}
        data-testid="new-agent-dialog"
      >
        <header className={styles.head}>
          <h2>{t('newAgentTitle')}</h2>
          <Button variant="compact" onClick={close}>
            {t('close')}
          </Button>
        </header>

        {noTmux ? (
          <p className={styles.error}>{t('newAgentNoTmux')}</p>
        ) : (
          <form className={styles.body} onSubmit={submit}>
            <label className={styles.field}>
              <span className={styles.label}>{t('newAgentDir')}</span>
              <div className={styles.dirRow}>
                <input
                  ref={dirRef}
                  className={styles.input}
                  data-testid="new-agent-dir"
                  value={dir}
                  placeholder="~/Projects/my-app"
                  autoComplete="off"
                  spellCheck={false}
                  required
                  onChange={(e) => setDir(e.target.value)}
                />
                <Button
                  variant="compact"
                  data-testid="new-agent-browse"
                  aria-expanded={browsing}
                  onClick={() => setBrowsing((v) => !v)}
                >
                  {t('browse')}
                </Button>
              </div>
              <span className={styles.hint}>{t('newAgentDirHint')}</span>
            </label>

            {browsing && (
              <FolderBrowser
                start={dir.trim() || undefined}
                onChoose={(path) => {
                  setDir(tildePath(path))
                  setBrowsing(false)
                }}
              />
            )}

            {suggestions.length > 0 && !browsing && (
              <div className={styles.recent}>
                <span className={styles.label}>{t('newAgentRecent')}</span>
                <div className={styles.recentList}>
                  {suggestions.map((d) => (
                    <Chip key={d} onClick={() => setDir(tildePath(d))}>
                      {tildePath(d)}
                    </Chip>
                  ))}
                </div>
              </div>
            )}

            <label className={styles.field}>
              <span className={styles.label}>{t('newAgentName')}</span>
              <input
                className={styles.input}
                data-testid="new-agent-name"
                value={name}
                placeholder="dark-mode-toggle"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setName(e.target.value)}
              />
              <span className={styles.hint}>{t('newAgentNameHint')}</span>
            </label>

            <div className={styles.row}>
              <label className={styles.field}>
                <span className={styles.label}>{t('modelLabel')}</span>
                <select
                  className={styles.input}
                  data-testid="new-agent-model"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                >
                  {MODELS.map((m) => (
                    <option key={m} value={m}>
                      {m === 'default' ? t('modelDefault') : m}
                    </option>
                  ))}
                </select>
              </label>

              <label className={styles.field}>
                <span className={styles.label}>{t('modeLabel')}</span>
                <select
                  className={styles.input}
                  data-testid="new-agent-mode"
                  value={mode}
                  onChange={(e) => setMode(e.target.value)}
                >
                  {MODES.map((m) => (
                    <option key={m} value={m}>
                      {t(MODE_KEY[m] as Key)}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {error && (
              <p className={styles.error} data-testid="new-agent-error">
                {error}
              </p>
            )}

            <div className={styles.actions}>
              <Button
                variant="compact"
                data-testid="set-default-dir"
                disabled={!dir.trim()}
                onClick={() => saveDefaultDir(dir.trim())}
              >
                {t('defaultDirSet')}
              </Button>
              <span className={styles.spacer} />
              <Button onClick={close}>{t('newAgentCancel')}</Button>
              <Button type="submit" variant="primary" data-testid="new-agent-submit" disabled={busy}>
                {busy ? t('newAgentStarting') : t('newAgentStart')}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>,
    document.body,
  )
}
