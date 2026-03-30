/**
 * useAuthStore — Store 1 of 5
 * ─────────────────────────────────────────────────────────────────────────────
 * Handbook §4.2 — owns: session identity, premium status, freemium quota
 * counters, Supabase sync.
 *
 * FSD target location: features/auth/model/useAuthStore.ts
 * Lives in store/ during Phase 1; will move during FSD refactor.
 *
 * Rules:
 *   - canUseAI() is the single source of truth for quota gating.
 *     useBillingStore reads this — never duplicates the logic.
 *   - clearAuth() is called by apiClient on every 401 (Handbook §3.4).
 *   - syncToSupabase() is debounced in the feature layer — never call it
 *     directly from components.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { create } from 'zustand';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AuthUser {
  id: string;
  email: string;
}

interface AuthState {
  // ── State ──────────────────────────────────────────────────────────────────
  user: AuthUser | null;
  isPremium: boolean;
  isAuthLoading: boolean;
  /** Remaining free magic rewrites. Authoritative value: GET /api/user/me */
  freeRewrites: number;
  /** Remaining free interview sessions. Authoritative value: GET /api/user/me */
  freeInterviews: number;
  isSaving: boolean;
  lastSyncedAt: Date | null;
  syncError: string | null;

  // ── Actions ────────────────────────────────────────────────────────────────
  setUser: (user: AuthUser | null) => void;
  setIsPremium: (value: boolean) => void;
  setIsAuthLoading: (value: boolean) => void;
  setFreeQuota: (rewrites: number, interviews: number) => void;

  /**
   * Returns true if the user can invoke an AI action.
   * Premium users always return true.
   * Free users return true while either counter > 0.
   * BYOK users: checked separately in useChatStore (key presence bypasses quota).
   */
  canUseAI: () => boolean;

  /** Decrement after a confirmed magic rewrite (POST /api/rewrite-section success). */
  decrementFreeRewrites: () => void;
  /** Decrement after a confirmed interview turn (SSE type:"done"). */
  decrementFreeInterviews: () => void;

  /**
   * Apply a promo code. Fires POST /api/promo/apply.
   * On success: sets isPremium = true, re-syncs quota from server.
   * Placeholder — implement in features/auth/api/.
   */
  applyPromoCode: (code: string) => Promise<void>;

  /** Push local state to Supabase user_data table. */
  syncToSupabase: () => Promise<void>;
  /** Delete all cloud data for the authenticated user. */
  clearCloudData: () => Promise<void>;
  /**
   * Clear all auth state. Called by apiClient on every 401.
   * Handbook §3.4: "401 always triggers clearAuth()."
   */
  clearAuth: () => void;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useAuthStore = create<AuthState>((set, get) => ({
  // ── Initial state ──────────────────────────────────────────────────────────
  user: null,
  isPremium: false,
  isAuthLoading: false, // false until onAuthStateChange is wired (Phase 2)
  // Phase 2: the auth feature hook will set this to `true` immediately on
  // mount, then to `false` once Supabase resolves the session. For now it
  // starts false so ProtectedRoute redirects unauthenticated users
  // immediately instead of spinning forever.
  freeRewrites: 3,     // matches DB default in freemium_limits migration
  freeInterviews: 1,
  isSaving: false,
  lastSyncedAt: null,
  syncError: null,

  // ── Actions ────────────────────────────────────────────────────────────────
  setUser: (user) => set({ user }),

  setIsPremium: (value) => set({ isPremium: value }),

  setIsAuthLoading: (value) => set({ isAuthLoading: value }),

  setFreeQuota: (rewrites, interviews) =>
    set({ freeRewrites: rewrites, freeInterviews: interviews }),

  canUseAI: () => {
    const { isPremium, freeRewrites, freeInterviews } = get();
    return isPremium || freeRewrites > 0 || freeInterviews > 0;
  },

  decrementFreeRewrites: () =>
    set((s) => ({ freeRewrites: Math.max(0, s.freeRewrites - 1) })),

  decrementFreeInterviews: () =>
    set((s) => ({ freeInterviews: Math.max(0, s.freeInterviews - 1) })),

  applyPromoCode: async (_code: string) => {
    // TODO: implement in features/auth/api/authApi.ts
    // POST /api/promo/apply → { success: bool, isPremium: bool }
    // On success: get().setIsPremium(true); get().syncToSupabase();
    throw new Error('applyPromoCode: not yet implemented');
  },

  syncToSupabase: async () => {
    // TODO: implement in features/auth/model/useAuth.ts
    // PATCH /api/user/save-progress with current store state
    set({ isSaving: true, syncError: null });
    try {
      // ... call saveProgress service
      set({ lastSyncedAt: new Date() });
    } catch (err) {
      set({ syncError: err instanceof Error ? err.message : 'Sync failed' });
    } finally {
      set({ isSaving: false });
    }
  },

  clearCloudData: async () => {
    // TODO: DELETE /api/user/data
    throw new Error('clearCloudData: not yet implemented');
  },

  clearAuth: () =>
    set({
      user: null,
      isPremium: false,
      isAuthLoading: false,
      freeRewrites: 3,
      freeInterviews: 1,
      isSaving: false,
      lastSyncedAt: null,
      syncError: null,
    }),
}));
