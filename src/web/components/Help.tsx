import { useEffect, useState } from 'react'
import { useStore } from '../store/store.ts'
import { loadEnv } from '../store/transport.ts'
import { useTranslate } from '../hooks/useTranslate.ts'
import { Button } from './ui/Button.tsx'
import styles from './Help.module.css'

/** Shown when Tailscale is not installed, so the steps still make sense. */
const EXAMPLE_HOST = 'your-mac.tailnet-name.ts.net'

const MASK = '••••••••••'

/**
 * A tailnet name is `<machine>.<tailnet>.ts.net`, and the first two labels are
 * the identifying ones — a machine name is usually a person's name, and the
 * tailnet is the household or company they are in. `ts.net` is shared by every
 * Tailscale user alive and says nothing, so keeping it is what makes the masked
 * form still legible as an address rather than as a row of dots.
 */
function maskHost(host: string): string {
  return host.endsWith('.ts.net') ? `${MASK}.ts.net` : MASK
}

const IPV4_OCTETS = 4

/**
 * Same idea for the address. Every tailnet lives in `100.64.0.0/10`, so the
 * first octet is a constant and it is the other three that locate a machine.
 */
function maskIp(address: string): string {
  const octets = address.split('.')
  return octets.length === IPV4_OCTETS ? `${octets[0]}.•.•.•` : MASK
}

export function Help({ onClose }: { onClose: () => void }) {
  const t = useTranslate()
  const env = useStore((s) => s.env)

  useEffect(() => {
    if (!env) void loadEnv()
  }, [env])

  const ts = env?.tailscale
  const host = ts?.dnsName || EXAMPLE_HOST
  const port = env?.port ?? 4317
  const cli = ts?.cliPath ?? 'tailscale'
  const ip = ts?.ip || '100.x.y.z'

  /*
   * This page names the machine it is running on, and a tailnet name is
   * usually a person's name plus their household's. That is fine on the screen
   * it belongs to and not fine in the places this screen ends up: a screenshot
   * in a bug report, a screen-share, a demo. So it starts masked and reveals on
   * a press — the identifier is not a secret being protected from the viewer,
   * who can read it whenever they choose, but from the camera behind them.
   *
   * Deliberately not remembered across opens. A preference that survives is one
   * that is set once and then forgotten about, and the whole value here is that
   * the safe state is the one you get without thinking about it.
   */
  const [revealed, setRevealed] = useState(false)
  /* Nothing to hide when Tailscale is absent: those are placeholders, and
     masking `your-mac.tailnet-name.ts.net` would only obscure the example. */
  const identifying = ts != null && !revealed
  const shownHost = identifying ? maskHost(host) : host
  const shownIp = identifying ? maskIp(ip) : ip

  return (
    <article className={styles.help} data-testid="help-page">
      <header className={styles.head}>
        <h2>{t('helpTitle')}</h2>
        {/* Reported by the server rather than baked into the bundle: with the
            Mac app those two can be different builds, and the one that matters
            is the one answering. Absent from a server built before it existed,
            and then shown as nothing rather than as "undefined". */}
        {env?.version !== undefined && (
          <span className={styles.version} data-testid="server-version">
            {t('helpVersion', { version: env.version })}
          </span>
        )}
        <Button data-testid="help-close" onClick={onClose}>
          {t('close')}
        </Button>
      </header>

      <p className={styles.intro}>{t('helpIntro')}</p>

      <section>
        <h3>{t('helpSectionBasics')}</h3>
        <ul className={styles.list}>
          <li>{t('helpBasicsGroups')}</li>
          <li>{t('helpBasicsChat')}</li>
          <li>{t('helpBasicsAttach')}</li>
        </ul>
      </section>

      <section>
        <h3>{t('helpSectionKeys')}</h3>
        <dl className={styles.keys}>
          <dt>
            <kbd>/</kbd>
          </dt>
          <dd>{t('keySlash')}</dd>
          <dt>
            <kbd>↑ ↓</kbd>
          </dt>
          <dd>{t('keyArrows')}</dd>
          <dt>
            <kbd>Enter</kbd>
          </dt>
          <dd>{t('keyEnter')}</dd>
          <dt>
            <kbd>Esc</kbd>
          </dt>
          <dd>{t('keyEsc')}</dd>
          <dt>
            <kbd>Shift+Esc</kbd>
          </dt>
          <dd>{t('keyShiftEsc')}</dd>
          <dt>
            <kbd>Enter</kbd> / <kbd>Shift+Enter</kbd>
          </dt>
          <dd>{t('keyEnterSend')}</dd>
        </dl>
      </section>

      <section data-testid="help-kinds">
        <h3>{t('helpSectionKinds')}</h3>
        <p>{t('helpKindsIntro')}</p>
        <p>{t('helpKindsStatus')}</p>
      </section>

      <section data-testid="help-tailscale">
        <h3>{t('helpSectionPhone')}</h3>
        <p>{t('helpPhoneIntro')}</p>

        <p className={`${styles.detected} ${ts ? styles.ok : styles.missing}`}>
          {ts ? (
            <>
              {t('helpTailscaleDetected')}: <code data-testid="tailscale-host">{shownHost}</code>
              <Button
                variant="compact"
                data-testid="tailscale-reveal"
                aria-pressed={revealed}
                onClick={() => setRevealed((on) => !on)}
              >
                {revealed ? t('helpHide') : t('helpReveal')}
              </Button>
            </>
          ) : (
            t('helpTailscaleMissing')
          )}
        </p>
        {ts && !revealed && <p className={styles.note}>{t('helpMaskedNote')}</p>}

        <ol className={styles.steps}>
          <li>{t('helpPhoneStep1')}</li>
          <li>
            {t('helpPhoneStep2')}
            <CodeRow text={`npm run serve -- --token auto`} />
            <CodeRow text={`${cli} serve --bg ${port}`} />
          </li>
          <li>
            {t('helpPhoneStep3')}
            <CodeRow text={`https://${host}/`} display={`https://${shownHost}/`} />
            <p className={styles.note}>{t('helpPhoneStep3Note')}</p>
            <p className={styles.note}>{t('helpAddToHome')}</p>
          </li>
          <li>
            {t('helpPhoneStep4')}
            <CodeRow text={`${cli} serve reset`} />
          </li>
        </ol>

        <details className={styles.alt}>
          <summary>{t('helpPhoneAlt')}</summary>
          <CodeRow
            text={`npm run serve -- --host ${ip} --token auto`}
            display={`npm run serve -- --host ${shownIp} --token auto`}
          />
          <p className={styles.note}>{t('helpPhoneAltNote')}</p>
        </details>

        <p className={styles.warning}>{t('helpPhoneWarning')}</p>
      </section>
    </article>
  )
}

/**
 * `text` is what the clipboard gets; `display` is what the screen shows.
 *
 * They differ only while the tailnet name is masked, and that split is the
 * point of the control: you can hand your phone the working address without
 * putting your machine's name on a screen someone else is looking at. A
 * password manager's copy button works the same way, for the same reason.
 *
 * The accessible name follows `display` rather than `text`, because a screen
 * reader announcing what the screen is hiding would undo the masking for the
 * one user who cannot see that it happened.
 */
function CodeRow({ text, display = text }: { text: string; display?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className={styles.codeRow}>
      <code>{display}</code>
      <Button
        variant="compact"
        aria-label={`copy: ${display}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text)
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          } catch {
            // Clipboard needs a secure context; the text is selectable anyway.
          }
        }}
      >
        {copied ? '✓' : 'copy'}
      </Button>
    </div>
  )
}
