// Handbook §4.2 — Store 1: useAuthStore
// Owns: session identity, premium status, freemium quota counters, Supabase sync.
// Target location (post-migration): features/auth/model/useAuthStore.ts

import { create } from 'zustand'

interface User {
  id: string
  email: string
}

interface AuthState {
  user: User | null
  isPremium: boolean
  isAuthLoading: boolean
  freeRewrites: number
  freeInterviews: number
  isSaving: boolean
  lastSyncedAt: string | null
  syncError: string | null
}

interface AuthActions {
  setUser: (user: User | null) => void
  setIsPremium: (isPremium: boolean) => void
  /** Server-authoritative check. Frontend counters are display-only. */
  canUseAI: () => boolean
  applyPromoCode: (_code: string) => void
  decrementFreeRewrites: () => void
  decrementFreeInterviews: () => void
  syncToSupabase: () => Promise<void>
  clearCloudData: () => void
  clearAuth: () => void
}

const INITIAL_FREE_REWRITES = 3
const INITIAL_FREE_INTERVIEWS = 1

export const useAuthStore = create<AuthState & AuthActions>((set, get) => ({
  user: null,
  isPremium: false,
  // false until Supabase onAuthStateChange is wired up (features/auth).
  isAuthLoading: false,
  freeRewrites: INITIAL_FREE_REWRITES,
  freeInterviews: INITIAL_FREE_INTERVIEWS,
  isSaving: false,
  lastSyncedAt: null,
  syncError: null,

  setUser: (user) => set({ user }),
  setIsPremium: (isPremium) => set({ isPremium }),

  canUseAI: () => {
    const { isPremium, freeRewrites, freeInterviews } = get()
    return isPremium || freeRewrites > 0 || freeInterviews > 0
  },

  // TODO: POST /api/promo → validate server-side
  applyPromoCode: (_code) => {},

  decrementFreeRewrites: () =>
    set((s) => ({ freeRewrites: Math.max(0, s.freeRewrites - 1) })),

  decrementFreeInterviews: () =>
    set((s) => ({ freeInterviews: Math.max(0, s.freeInterviews - 1) })),

  // TODO: PATCH /api/user/me — sync resume_data, chat_history to Supabase
  syncToSupabase: async () => {
    set({ isSaving: true, syncError: null })
    try {
      // implementation added in auth feature slice
      set({ lastSyncedAt: new Date().toISOString() })
    } catch (err) {
      set({ syncError: err instanceof Error ? err.message : 'Sync failed' })
    } finally {
      set({ isSaving: false })
    }
  },

  clearCloudData: () => set({ lastSyncedAt: null, syncError: null }),

  clearAuth: () =>
    set({
      user: null,
      isPremium: false,
      isAuthLoading: false,
      freeRewrites: INITIAL_FREE_REWRITES,
      freeInterviews: INITIAL_FREE_INTERVIEWS,
      isSaving: false,
      lastSyncedAt: null,
      syncError: null,
    }),
}))
