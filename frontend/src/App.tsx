import { useEffect } from 'react'
import { Routes, Route, Link } from 'react-router-dom'
import LandingPage from './pages/LandingPage'
import DashboardPage from './pages/DashboardPage'
import WorkspacePage from './pages/WorkspacePage'
import SettingsPage from './pages/SettingsPage'
import ProtectedRoute from './app/router/ProtectedRoute'
import { useAuthStore } from './store/useAuthStore'
import { useBillingStore } from './store/useBillingStore'
import { useSessionStore } from './store/useSessionStore'
import { useChatStore } from './store/useChatStore'
import { useDocumentStore } from './store/useDocumentStore'

// Temporary dev nav — deleted once real layouts exist
function TempNav() {
  return (
    <nav style={{
      display: 'flex',
      gap: '20px',
      padding: '12px 24px',
      background: '#0f0f23',
      borderBottom: '1px solid #333',
      fontFamily: 'monospace',
      fontSize: '14px',
    }}>
      <Link to="/"          style={{ color: '#c084fc', textDecoration: 'none' }}>/ landing</Link>
      <Link to="/dashboard" style={{ color: '#c084fc', textDecoration: 'none' }}>/dashboard</Link>
      <Link to="/workspace" style={{ color: '#c084fc', textDecoration: 'none' }}>/workspace</Link>
      <Link to="/settings"  style={{ color: '#c084fc', textDecoration: 'none' }}>/settings</Link>
    </nav>
  )
}

export default function App() {
  // Verify all 5 Zustand slices initialised correctly on mount.
  // useAppStore is a barrel; each slice has its own .getState() static method.
  useEffect(() => {
    console.log('[useAppStore slices — initial state]', {
      auth:     useAuthStore.getState(),
      billing:  useBillingStore.getState(),
      session:  useSessionStore.getState(),
      chat:     useChatStore.getState(),
      document: useDocumentStore.getState(),
    })
  }, [])

  return (
    <>
      <TempNav />
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route element={<ProtectedRoute />}>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/workspace" element={<WorkspacePage />} />
          <Route path="/settings"  element={<SettingsPage />} />
        </Route>
      </Routes>
    </>
  )
}
