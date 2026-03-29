/**
 * App.tsx — Route Tree
 * ─────────────────────────────────────────────────────────────────────────────
 * Owns: route definitions, AnimatePresence wrapper, auth-driven navigation.
 * Does NOT own: BrowserRouter (lives in main.tsx), business logic.
 *
 * PRD Route Map (Handbook §3.2 + PRD §§2–6):
 *   /            → LandingPage    public  — soft-gate onboarding (PRD §2)
 *   /dashboard   → DashboardPage  protected — hub, persists CV+JD (PRD §3)
 *   /workspace   → WorkspacePage  protected — sandwich edit / interview (PRD §4)
 *   /settings    → SettingsPage   protected — BYOK, language, privacy (PRD §6)
 *   /paywall     → PaywallPage    public  — upgrade CTA (rarely a hard route)
 *   /onboarding  → OnboardingPage protected — post-auth context capture
 *
 * FSD note: per Handbook §3.2 this file should ultimately live at
 * src/app/App.tsx. It stays at src/App.tsx for now so main.tsx needs no
 * changes during this phase.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Routes, Route, useLocation } from 'react-router-dom';

// Pages — route-level shells with NO business logic (Handbook §3.2)
import LandingPage    from '@/pages/LandingPage';
import DashboardPage  from '@/pages/DashboardPage';
import WorkspacePage  from '@/pages/WorkspacePage';
import SettingsPage   from '@/pages/SettingsPage';
import PaywallPage    from '@/pages/PaywallPage';
import OnboardingPage from '@/pages/OnboardingPage';

// Route guard — three-stage: loading → 401 redirect → missing context
import ProtectedRoute from '@/app/router/ProtectedRoute';

// TODO Phase 2: wrap <Routes> in <AnimatePresence mode="wait"> once
// framer-motion is installed. The location key drives exit/enter animations.
// import { AnimatePresence } from 'framer-motion';

export default function App() {
  // location is kept here so AnimatePresence can key on pathname once added.
  const location = useLocation();

  return (
    // <AnimatePresence mode="wait">
    <Routes location={location} key={location.pathname}>

      {/* ── Public routes ─────────────────────────────────────────────────── */}

      {/* Soft-gate landing: CV + JD upload → ATS score → soft auth prompt.
          User sees real computed value (their score) before any account is
          required. PRD §2.1: "Critical constraint: score before auth." */}
      <Route path="/" element={<LandingPage />} />

      {/* Paywall: usually shown as a modal; this route handles direct links. */}
      <Route path="/paywall" element={<PaywallPage />} />

      {/* ── Protected routes ──────────────────────────────────────────────── */}

      {/* Dashboard — the Hub. Holds CV + JD context across all spoke sessions.
          PRD §1.2: "useDocumentStore survives route changes." */}
      <Route
        path="/dashboard"
        element={
          <ProtectedRoute>
            <DashboardPage />
          </ProtectedRoute>
        }
      />

      {/* Workspace — mode driven by ?mode=resume|interview|cover (PRD §4.8).
          useSessionStore.workspaceMode is hydrated from the URL param on mount. */}
      <Route
        path="/workspace"
        element={
          <ProtectedRoute>
            <WorkspacePage />
          </ProtectedRoute>
        }
      />

      {/* Settings — BYOK Gemini key, language prefs, data privacy (PRD §6). */}
      <Route
        path="/settings"
        element={
          <ProtectedRoute>
            <SettingsPage />
          </ProtectedRoute>
        }
      />

      {/* Onboarding — post-auth context capture (placeholder). */}
      <Route
        path="/onboarding"
        element={
          <ProtectedRoute>
            <OnboardingPage />
          </ProtectedRoute>
        }
      />

      {/* ── Fallback ──────────────────────────────────────────────────────── */}
      {/* Unknown paths fall back to landing; no 404 page yet. */}
      <Route path="*" element={<LandingPage />} />

    </Routes>
    // </AnimatePresence>
  );
}
