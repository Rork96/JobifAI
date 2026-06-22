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

import { useEffect } from 'react';
import { Routes, Route, useLocation } from 'react-router-dom';

// Pages — route-level shells with NO business logic (Handbook §3.2)
import LandingPage    from '@/pages/LandingPage';
import LoginPage      from '@/pages/LoginPage';
import DashboardPage  from '@/pages/DashboardPage';
import WorkspacePage  from '@/pages/WorkspacePage';
import SettingsPage   from '@/pages/SettingsPage';
import PaywallPage    from '@/pages/PaywallPage';
import OnboardingPage from '@/pages/OnboardingPage';

// Route guard — three-stage: loading → 401 redirect → missing context
import ProtectedRoute from '@/app/router/ProtectedRoute';

// Global UI
import Toaster from '@/shared/ui/Toaster';
import { PaywallModal } from '@/components/paywall/PaywallModal';

// Stores
import { useAuthStore }     from '@/store/useAuthStore';
import { useBillingStore }  from '@/store/useBillingStore';
import { useSessionStore }  from '@/store/useSessionStore';
import { useChatStore }     from '@/store/useChatStore';
import { useDocumentStore } from '@/store/useDocumentStore';

/**
 * GlobalPaywall — singleton modal mounted outside <Routes>.
 *
 * Lives above the route tree so it can overlay any page (Dashboard, Workspace,
 * Settings…) without being unmounted by navigation. Reads isPaywallOpen from
 * useBillingStore; renders nothing when closed so there is zero DOM overhead.
 *
 * onAccessGranted = closePaywall — free trial flow just closes the modal and
 * lets the user proceed with their free-tier quota.
 */
function GlobalPaywall() {
  const isOpen       = useBillingStore(s => s.isPaywallOpen);
  const closePaywall = useBillingStore(s => s.closePaywall);

  if (!isOpen) return null;
  return <PaywallModal onAccessGranted={closePaywall} />;
}

export default function App() {
  const location = useLocation();

  // Start the Supabase auth listener once, on mount.
  // initAuth() subscribes to onAuthStateChange and returns the unsubscribe fn.
  // isAuthLoading starts true; the first INITIAL_SESSION event sets it false,
  // preventing ProtectedRoute from flashing the redirect before session restore.
  useEffect(() => {
    const unsubscribe = useAuthStore.getState().initAuth();
    return unsubscribe;
  }, []);

  // DEV ONLY — log all 5 Zustand slices once on mount
  useEffect(() => {
    console.group('[JobifAI] useAppStore — 5 slice initial state');
    console.log('useAuthStore    →', useAuthStore.getState());
    console.log('useBillingStore →', useBillingStore.getState());
    console.log('useSessionStore →', useSessionStore.getState());
    console.log('useChatStore    →', useChatStore.getState());
    console.log('useDocumentStore→', useDocumentStore.getState());
    console.groupEnd();
  }, []);

  return (
    <>
    {/* Global overlays — rendered outside Routes so they survive navigation */}
    <Toaster />
    <GlobalPaywall />
    {/* <AnimatePresence mode="wait"> */}
    <Routes location={location} key={location.pathname}>

      {/* ── Public routes ─────────────────────────────────────────────────── */}

      {/* Soft-gate landing: CV + JD upload → ATS score → soft auth prompt.
          User sees real computed value (their score) before any account is
          required. PRD §2.1: "Critical constraint: score before auth." */}
      <Route path="/" element={<LandingPage />} />

      {/* Login — auth entry point; redirects authenticated users away. */}
      <Route path="/login" element={<LoginPage />} />

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

      {/* Workspace (new resume) — no :id, post-landing flow */}
      <Route
        path="/workspace"
        element={
          <ProtectedRoute>
            <WorkspacePage />
          </ProtectedRoute>
        }
      />

      {/* Workspace (existing resume) — loaded from DB by id */}
      <Route
        path="/workspace/:id"
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
    {/* </AnimatePresence> */}
    </>
  );
}
