/**
 * useSessionStore — Store 3 of 5
 * ─────────────────────────────────────────────────────────────────────────────
 * Handbook §4.2 — owns: app mode, lifecycle status, onboarding path,
 * language preferences, Hardcore Mode state, Mac Mascot state.
 *
 * FSD target location: features/onboarding/model/useSessionStore.ts
 * Lives in store/ during Phase 1; will move during FSD refactor.
 *
 * Critical rule:
 *   transitionTo(status) is THE ONLY WAY to change appStatus.
 *   Never call set({ appStatus: ... }) directly — always go through transitionTo.
 *   This makes status transitions traceable and testable.
 *
 * Mac Mascot state machine (PRD §2.7):
 *   'processing' overrides all other states while any API call is in flight.
 *   After 'shocked' | 'success' | 'warning': revert to 'idle' after 3 seconds.
 *   'listening' activates on input focus, reverts on blur.
 *   In Hardcore Mode, 'success' is NEVER played for individual rewrites —
 *   only for total session score improvement ≥ 20 pts (PRD §5.5).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { create } from 'zustand';

// ── Types ─────────────────────────────────────────────────────────────────────

export type AppMode =
  | 'idle'
  | 'onboarding'
  | 'dashboard'
  | 'workspace';

export type AppStatus =
  | 'initializing'  // Supabase session restore in progress
  | 'ready'         // all data loaded, user can interact
  | 'uploading'     // CV/JD upload in flight
  | 'analyzing'     // ATS score / AI call in flight
  | 'error';        // recoverable error state

export type OnboardingMode =
  | 'resume-fix'
  | 'interview'
  | 'cover-letter'
  | null;

export type WorkspaceMode =
  | 'resume'     // /workspace?mode=resume
  | 'interview'  // /workspace?mode=interview
  | 'cover'      // /workspace?mode=cover
  | null;

/**
 * Mac Mascot visual state (PRD §2.7).
 * Drives which .webm asset is rendered by <MacMascot />.
 */
export type MacState =
  | 'idle'        // idle.webm — default, no active operation
  | 'listening'   // listening.webm — user typing in any text input
  | 'processing'  // processing.webm — any API call in flight (highest priority)
  | 'shocked'     // shocked.webm — ATS score < 40 revealed
  | 'success'     // success.webm — score ≥ 70 or milestone ≥ 20pt gain
  | 'warning';    // warning.webm — score 40–69 or Hardcore auto-trigger

interface SessionState {
  // ── State ──────────────────────────────────────────────────────────────────
  appMode: AppMode;
  appStatus: AppStatus;
  onboardingMode: OnboardingMode;
  workspaceMode: WorkspaceMode;

  /** Raw uploaded resume text (extracted from PDF/DOCX). */
  uploadedResumeText: string;
  /** Raw job description text pasted by the user. */
  jobDescription: string;

  userLang: string;    // UI language, e.g. 'en', 'fr', 'de'
  resumeLang: string;  // Resume/AI output language

  /** Persistent Hardcore Mode. Synced to profiles.hardcore_mode via PATCH /api/user/me */
  isHardcoreMode: boolean;
  /**
   * Set to true when ATS score < 40 on landing page.
   * Triggers auto-activation banner + toggle on dashboard mount (PRD §5.4).
   */
  hardcorePending: boolean;

  macState: MacState;

  // ── Actions ────────────────────────────────────────────────────────────────

  /**
   * THE ONLY WAY to change appStatus. Never write to appStatus directly.
   * Enforces a traceable, testable state machine for lifecycle transitions.
   */
  transitionTo: (status: AppStatus) => void;

  setAppMode: (mode: AppMode) => void;
  setOnboardingMode: (mode: OnboardingMode) => void;
  /** Called on WorkspacePage mount from URL ?mode param (PRD §4.8). */
  setWorkspaceMode: (mode: WorkspaceMode) => void;

  /** Resets CV text, JD text, and workspace mode — used by "Change Documents". */
  clearApplicationContext: () => void;

  setUserLang: (lang: string) => void;
  setResumeLang: (lang: string) => void;

  /**
   * Toggle Hardcore Mode. Fires PATCH /api/user/me immediately (PRD §5.3).
   * Toggle implementation in features/auth/api/ — this just mutates local state.
   */
  toggleHardcoreMode: () => void;
  setHardcorePending: (pending: boolean) => void;

  /**
   * Set the Mac Mascot visual state.
   * Components call this; the timed revert-to-idle logic runs here.
   * 'processing' state can only be cleared by calling setMacState with a
   * different value — it does not auto-revert (API call must complete first).
   */
  setMacState: (state: MacState) => void;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** States that auto-revert to 'idle' after 3 seconds (PRD §2.7). */
const TRANSIENT_STATES: MacState[] = ['shocked', 'success', 'warning'];

let macRevertTimer: ReturnType<typeof setTimeout> | null = null;

function clearMacTimer() {
  if (macRevertTimer !== null) {
    clearTimeout(macRevertTimer);
    macRevertTimer = null;
  }
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useSessionStore = create<SessionState>((set) => ({
  // ── Initial state ──────────────────────────────────────────────────────────
  appMode: 'idle',
  appStatus: 'initializing',
  onboardingMode: null,
  workspaceMode: null,
  uploadedResumeText: '',
  jobDescription: '',
  userLang: 'en',
  resumeLang: 'en',
  isHardcoreMode: false,
  hardcorePending: false,
  macState: 'idle',

  // ── Actions ────────────────────────────────────────────────────────────────
  transitionTo: (status) => set({ appStatus: status }),

  setAppMode: (mode) => set({ appMode: mode }),

  setOnboardingMode: (mode) => set({ onboardingMode: mode }),

  setWorkspaceMode: (mode) => set({ workspaceMode: mode }),

  clearApplicationContext: () =>
    set({
      uploadedResumeText: '',
      jobDescription: '',
      workspaceMode: null,
      appMode: 'idle',
    }),

  setUserLang: (lang) => set({ userLang: lang }),

  setResumeLang: (lang) => set({ resumeLang: lang }),

  toggleHardcoreMode: () =>
    set((s) => ({ isHardcoreMode: !s.isHardcoreMode })),

  setHardcorePending: (pending) => set({ hardcorePending: pending }),

  setMacState: (state) => {
    // Cancel any pending revert timer
    clearMacTimer();

    set({ macState: state });

    // Transient states auto-revert to idle after 3 seconds (PRD §2.7).
    // 'processing' does NOT auto-revert — it must be cleared explicitly
    // when the API call resolves.
    if (TRANSIENT_STATES.includes(state)) {
      macRevertTimer = setTimeout(() => {
        set({ macState: 'idle' });
        macRevertTimer = null;
      }, 3000);
    }
  },
}));
