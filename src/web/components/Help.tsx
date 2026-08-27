import { useEffect, useState } from 'react'
import { useStore } from '../store/store.ts'
import { loadEnv } from '../store/transport.ts'
import { useTranslate } from '../hooks/useTranslate.ts'
import { Button } from './ui/Button.tsx'
import styles from './Help.module.css'

/** Shown when Tailscale is not installed, so the steps still make sense. */
const EXAMPLE_HOST = 'your-mac.tailnet-name.ts.net'

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

  return (
    <article className={styles.help} data-testid="help-page">
      <header className={styles.head}>
        <h2>{t('helpTitle')}</h2>
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
              {t('helpTailscaleDetected')}: <code data-testid="tailscale-host">{host}</code>
            </>
          ) : (
            t('helpTailscaleMissing')
          )}
        </p>

        <ol className={styles.steps}>
          <li>{t('helpPhoneStep1')}</li>
          <li>
            {t('helpPhoneStep2')}
            <CodeRow text={`${cli} serve --bg ${port}`} />
          </li>
          <li>
            {t('helpPhoneStep3')}
            <CodeRow text={`https://${host}/`} />
            <p className={styles.note}>{t('helpAddToHome')}</p>
          </li>
          <li>
            {t('helpPhoneStep4')}
            <CodeRow text={`${cli} serve reset`} />
          </li>
        </ol>

        <details className={styles.alt}>
          <summary>{t('helpPhoneAlt')}</summary>
          <CodeRow text={`npm run serve -- --host ${ip} --token auto`} />
          <p className={styles.note}>{t('helpPhoneAltNote')}</p>
        </details>

        <p className={styles.warning}>{t('helpPhoneWarning')}</p>
      </section>
    </article>
  )
}

function CodeRow({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className={styles.codeRow}>
      <code>{text}</code>
      <Button
        variant="compact"
        aria-label={`copy: ${text}`}
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
