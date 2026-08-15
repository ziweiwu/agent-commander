import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import './styles/global.css'
import { router } from './routes.tsx'
import { initPreferences } from './store/store.ts'
import { connect } from './store/transport.ts'

initPreferences()
connect()

const host = document.getElementById('root')
if (!host) throw new Error('missing #root')

createRoot(host).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
