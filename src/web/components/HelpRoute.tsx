import { useTokenNavigate } from '../hooks/useTokenNavigate.ts'
import { Help } from './Help.tsx'
import styles from './App.module.css'

export function HelpRoute() {
  const navigate = useTokenNavigate()
  return (
    <main className={`${styles.layout} ${styles.solo}`}>
      <Help onClose={() => navigate('/')} />
    </main>
  )
}
