/**
 * ProtectedRoute.tsx — Three-Stage Auth Guard
 * ─────────────────────────────────────────────────────────────────────────────
 * Handbook §3.2 (ProtectedRoute spec) and PRD §3.2:
 *
 *   Stage 1 — isAuthLoading = true
 *     Supabase is restoring the session from localStorage. Show a spinner.
 *     Never redirect during this window — the user may have a valid session
 *     that hasn't been hydrated yet.
 *
 *   Stage 2 — No JWT (user is null after loading completes)
 *     Redirect to / with ?returnTo=<current path> so the landing page can
 *     restore the intended destination after auth completes.
 *
 *   Stage 3 — JWT valid, pendingCvFile non-null
 *     The user authenticated from the landing page with CV data pending.
 *     Dashboard will auto-trigger upload + ATS score on mount and clear
 *     pendingCvFile / pendingJdText on success. This guard just lets them
 *     through — the dashboard handles the hydration logic.
 *
 * Usage:
 *   <Route path="/dashboard" element={<ProtectedRoute><DashboardPage /></ProtectedRoute>} />
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/store/useAuthStore';

interface ProtectedRouteProps {
  children: React.ReactNode;
}

export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const location = useLocation();
  const { user, isAuthLoading } = useAuthStore();

  // Stage 1: Supabase is still restoring session — do not redirect yet.
  // TODO Phase 2: replace this div with a proper <SessionSpinner /> from
  // shared/ui/SessionSpinner.tsx once that component exists.
  if (isAuthLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <span className="sr-only">Loading session…</span>
        {/* TODO: replace with <SessionSpinner /> */}
        <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-blue-600" />
      </div>
    );
  }

  // Stage 2: No JWT — redirect to landing, preserving intended destination.
  // The landing page's auth modal reads returnTo and navigates there on success.
  if (!user) {
    return (
      <Navigate
        to={`/?returnTo=${encodeURIComponent(location.pathname + location.search)}`}
        replace
      />
    );
  }

  // Stage 3: Authenticated. Render the protected page.
  // If pendingCvFile is set, the DashboardPage handles auto-hydration on mount
  // (see PRD §3.2 and useDocumentStore.pendingCvFile).
  return <>{children}</>;
}
