import { createBrowserRouter, Navigate } from 'react-router-dom'
import { App, FleetRoute } from './components/App.tsx'
import { HelpRoute } from './components/HelpRoute.tsx'

/**
 * Real URLs, not view state. The phone's back button and swipe-back then close
 * an agent instead of leaving the app, and a reload keeps your place.
 */
export const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <FleetRoute /> },
      { path: 'agent/:sessionId', element: <FleetRoute /> },
      { path: 'agent/:sessionId/term', element: <FleetRoute /> },
      { path: 'help', element: <HelpRoute /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
])
