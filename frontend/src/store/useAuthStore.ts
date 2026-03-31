/**
 * useAuthStore — Store 1 of 5
 * ─────────────────────────────────────────────────────────────────────────────
 * Handbook §4.2 — owns: session identity, premium status, freemium quota
 * counters, Supabase sync.
 *
 * Auth flow:
 *   App.tsx calls initAuth() once on mount.
 *   initAuth() subscribes to supabase.auth.onAuthStateChange, which:
 *     - SIGNED_IN / TOKEN_REFRESHED → maps session.user → setUser + setIsPremium
 *     - SIGNED_OUT                  → clearAuth()
 *     - Sets isAuthLoading = false after the first event (session restore complete)
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
import type { AuthError, User } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AuthUser {
  id: string;
  email: string;
}

interface AuthState {
  // ── State ──────────────────────────────────────────────────────────────────
  user: AuthUser | null;
  isPremium: boolean;
  /** True while Supabase is restoring the session from localStorage on load.
   *  ProtectedRoute shows a spinner during this window — never redirects. */
  isAuthLoading: boolean;
  /** Remaining free magic rewrites. Authoritative value: GET /api/user/me */
  freeRewrites: number;
  /** Remaining free interview sessions. Authoritative value: GET /api/user/me */
  freeInterviews: number;
  isSaving: boolean;
  lastSyncedAt: Date | null;
  syncError: string | null;

  // ── Actions ────────────────────────────────────────────────────────────────

  /**
   * Subscribe to supabase.auth.onAuthStateChange.
   * Call ONCE from App.tsx on mount. Returns the unsubscribe function.
   *
   * Transitions:
   *   SIGNED_IN / TOKEN_REFRESHED → setUser(mapped) + setIsAuthLoading(false)
   *   SIGNED_OUT / USER_DELETED   → clearAuth()
   *   INITIAL_SESSION             → setIsAuthLoading(false) (session restore done)
   */
  initAuth: () => () => void;

  /** Email + password sign-in. Returns AuthError if failed, null on success. */
  signInWithEmail: (email: string, password: string) => Promise<AuthError | null>;

  /** Email + password sign-up. Returns AuthError if failed, null on success. */
  signUpWithEmail: (email: string, password: string) => Promise<AuthError | null>;

  /**
   * Google OAuth — opens the provider popup/redirect.
   * Pass redirectTo so Supabase knows where to land after the OAuth dance.
   */
  signInWithGoogle: (redirectTo?: string) => Promise<AuthError | null>;

  /** Sign out. Fires SIGNED_OUT in onAuthStateChange → clearAuth(). */
  signOut: () => Promise<void>;

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
   * Clear all auth state. Called by apiClient on every 401 and by
   * onAuthStateChange on SIGNED_OUT.
   * Handbook §3.4: "401 always triggers clearAuth()."
   */
  clearAuth: () => void;
}

// ── Helper: map Supabase User → AuthUser ──────────────────────────────────────

function mapUser(u: User): AuthUser {
  return {
    id:    u.id,
    email: u.email ?? '',
  };
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useAuthStore = create<AuthState>((set, get) => ({
  // ── Initial state ──────────────────────────────────────────────────────────
  user: null,
  isPremium: false,
  // true so ProtectedRoute shows a spinner while Supabase restores the session.
  // initAuth() sets this to false once onAuthStateChange fires the first event.
  isAuthLoading: true,
  freeRewrites: 3,     // matches DB default in freemium_limits migration
  freeInterviews: 1,
  isSaving: false,
  lastSyncedAt: null,
  syncError: null,

  // ── Actions ────────────────────────────────────────────────────────────────

  initAuth: () => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        switch (event) {
          case 'SIGNED_IN':
          case 'TOKEN_REFRESHED':
            if (session?.user) {
              set({
                user:           mapUser(session.user),
                isAuthLoading:  false,
                // TODO Phase 7: fetch isPremium from profiles table via GET /api/user/me
                isPremium:      false,
              });
            }
            break;

          case 'INITIAL_SESSION':
            // Session restore from localStorage is complete.
            // If session is null the user is logged out — that's fine.
            if (session?.user) {
              set({ user: mapUser(session.user), isAuthLoading: false });
            } else {
              set({ isAuthLoading: false });
            }
            break;

          case 'SIGNED_OUT':
          case 'USER_DELETED':
            get().clearAuth();
            break;
        }
      }
    );

    // Return unsubscribe so App.tsx can clean up on unmount
    return () => subscription.unsubscribe();
  },

  signInWithEmail: async (email, password) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return error ?? null;
  },

  signUpWithEmail: async (email, password) => {
    const { error } = await supabase.auth.signUp({ email, password });
    return error ?? null;
  },

  signInWithGoogle: async (redirectTo) => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: redirectTo ?? `${window.location.origin}/dashboard`,
      },
    });
    return error ?? null;
  },

  signOut: async () => {
    await supabase.auth.signOut();
    // onAuthStateChange fires SIGNED_OUT → clearAuth() is called automatically
  },

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
    throw new Error('applyPromoCode: not yet implemented');
  },

  syncToSupabase: async () => {
    set({ isSaving: true, syncError: null });
    try {
      // TODO: PATCH /api/user/save-progress with current store state
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
      user:          null,
      isPremium:     false,
      isAuthLoading: false,
      freeRewrites:  3,
      freeInterviews: 1,
      isSaving:      false,
      lastSyncedAt:  null,
      syncError:     null,
    }),
}));
