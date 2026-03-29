import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuthStore } from '../../store/useAuthStore'

// Three-stage guard (Handbook §3.2 / PRD §3.2):
//   1. isAuthLoading  → hold (Supabase onAuthStateChange hasn't resolved yet)
//   2. no user        → redirect to / with ?returnTo=<intended path>
//   3. authenticated  → render child route via <Outlet />
//
// Stage 3 pending-CV hydration (PRD §3.2 step 3) is handled inside
// DashboardPage on mount — ProtectedRoute stays transport-only.

export default function ProtectedRoute() {
  const { user, isAuthLoading } = useAuthStore()
  const location = useLocation()

  if (isAuthLoading) {
    // TODO: replace with <SessionSpinner /> from shared/ui once built
    return null
  }

  if (!user) {
    return (
      <Navigate
        to={`/?returnTo=${encodeURIComponent(location.pathname + location.search)}`}
        replace
      />
    )
  }

  return <Outlet />
}
