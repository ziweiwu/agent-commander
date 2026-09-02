import { useNavigate } from 'react-router-dom'
import { Help } from './Help.tsx'
import styles from './App.module.css'

export function HelpRoute() {
  const navigate = useNavigate()
  return (
    <main className={`${styles.layout} ${styles.solo}`}>
      <Help onClose={() => navigate('/')} />
    </main>
  )
}
