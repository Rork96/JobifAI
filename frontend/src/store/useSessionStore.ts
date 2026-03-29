// Handbook §4.2 — Store 3: useSessionStore
// Owns: app mode, lifecycle status, onboarding path, language prefs,
//       Mac mascot state, recent sessions list.
// Target location (post-migration): features/onboarding/model/useSessionStore.ts

import { create } from 'zustand'

type AppMode = 'idle' | 'resume-fix' | 'interview' | 'cover-letter'
type AppStatus = 'idle' | 'uploading' | 'scoring' | 'ready' | 'working' | 'error'
type OnboardingMode = 'upload' | 'paste' | null

// PRD §2.7 — Mac mascot visual state machine
export type MacState = 'idle' | 'listening' | 'processing' | 'shocked' | 'success' | 'warning'

interface SessionState {
  appMode: AppMode
  appStatus: AppStatus
  onboardingMode: OnboardingMode
  uploadedResumeText: string
  jobDescription: string
  userLang: string
  resumeLang: string
  isHardcoreMode: boolean
  /** Set to true when ATS score < 40; DashboardPage auto-activates Hardcore Mode on mount. */
  hardcorePending: boolean
  macState: MacState
  recentSessions: unknown[]
}

interface SessionActions {
  /** THE ONLY WAY to change appStatus (Handbook §4.2). */
  transitionTo: (status: AppStatus) => void
  setOnboardingMode: (mode: OnboardingMode) => void
  setAppMode: (mode: AppMode) => void
  clearApplicationContext: () => void
  setUserLang: (lang: string) => void
  setResumeLang: (lang: string) => void
  toggleHardcoreMode: () => void
  setMacState: (state: MacState) => void
  setRecentSessions: (sessions: unknown[]) => void
}

export const useSessionStore = create<SessionState & SessionActions>((set) => ({
  appMode: 'idle',
  appStatus: 'idle',
  onboardingMode: null,
  uploadedResumeText: '',
  jobDescription: '',
  userLang: 'en',
  resumeLang: 'en',
  isHardcoreMode: false,
  hardcorePending: false,
  macState: 'idle',
  recentSessions: [],

  transitionTo: (appStatus) => set({ appStatus }),
  setOnboardingMode: (onboardingMode) => set({ onboardingMode }),
  setAppMode: (appMode) => set({ appMode }),

  clearApplicationContext: () =>
    set({
      uploadedResumeText: '',
      jobDescription: '',
      appMode: 'idle',
      appStatus: 'idle',
    }),

  setUserLang: (userLang) => set({ userLang }),
  setResumeLang: (resumeLang) => set({ resumeLang }),
  toggleHardcoreMode: () => set((s) => ({ isHardcoreMode: !s.isHardcoreMode })),
  setMacState: (macState) => set({ macState }),
  setRecentSessions: (recentSessions) => set({ recentSessions }),
}))
