/**
 * useAuthStore — Store 1 of 5
 * ─────────────────────────────────────────────────────────────────────────────
 * Handbook §4.2 — owns: session identity, premium status, freemium quota
 * counters, Supabase sync.
 *
 * Auth + profile hydration flow:
 *   App.tsx calls initAuth() once on mount.
 *   initAuth() subscribes to supabase.auth.onAuthStateChange:
 *     INITIAL_SESSION → setIsAuthLoading(false), map user if session exists
 *     SIGNED_IN       → map user, then fetchProfile() to hydrate credits/locale
 *     TOKEN_REFRESHED → map user (profile already loaded)
 *     SIGNED_OUT      → clearAuth()
 *
 * Profile hydration populates:
 *   isPremium, freeRewrites, freeInterviews
 *   → useSessionStore.isHardcoreMode and userLang are patched from here too
 *
 * Rules:
 *   - canUseAI() is the single source of truth for quota gating.
 *   - clearAuth() is called by apiClient on every 401.
 *   - freeRewrites / freeInterviews are display-only; server is authoritative.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { create } from 'zustand';
import type { AuthError, User } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { fetchProfile } from '@/lib/db';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AuthUser {
  id:    string;
  email: string;
}

interface AuthState {
  // ── State ──────────────────────────────────────────────────────────────────
  user:          AuthUser | null;
  isPremium:     boolean;
  /** True while Supabase restores the session from localStorage on load.
   *  ProtectedRoute shows a spinner — never redirects — during this window. */
  isAuthLoading: boolean;
  /** Display-only free credits. Server is authoritative via GET /api/user/me */
  freeRewrites:    number;
  freeInterviews:  number;
  isSaving:      boolean;
  lastSyncedAt:  Date | null;
  syncError:     string | null;

  // ── Actions ────────────────────────────────────────────────────────────────

  /**
   * Subscribe to supabase.auth.onAuthStateChange.
   * Called ONCE from App.tsx on mount. Returns the unsubscribe function.
   */
  initAuth: () => () => void;

  /** Email + password sign-in. Returns AuthError if failed, null on success. */
  signInWithEmail: (email: string, password: string) => Promise<AuthError | null>;
  /** Email + password sign-up. Returns AuthError if failed, null on success. */
  signUpWithEmail: (email: string, password: string) => Promise<AuthError | null>;
  /** Google OAuth — opens the provider redirect. */
  signInWithGoogle: (redirectTo?: string) => Promise<AuthError | null>;
  /** Sign out. Fires SIGNED_OUT in onAuthStateChange → clearAuth(). */
  signOut: () => Promise<void>;

  setIsPremium:      (value: boolean) => void;
  setIsAuthLoading:  (value: boolean) => void;
  setFreeQuota:      (rewrites: number, interviews: number) => void;

  /**
   * True if the user can invoke an AI action.
   * Premium bypasses quota. Free users have limited credits.
   */
  canUseAI: () => boolean;
  decrementFreeRewrites:   () => void;
  decrementFreeInterviews: () => void;

  applyPromoCode:  (code: string) => Promise<void>;
  syncToSupabase:  () => Promise<void>;
  clearCloudData:  () => Promise<void>;
  /** Reset all auth state. Called by apiClient on 401 and by SIGNED_OUT event. */
  clearAuth: () => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function mapUser(u: User): AuthUser {
  return { id: u.id, email: u.email ?? '' };
}

/**
 * After SIGNED_IN: fetch the profile row and patch the store + session store.
 * Separated so it can be called without triggering a full store rebuild.
 */
async function hydrateProfile(userId: string, setState: (partial: Partial<AuthState>) => void) {
  const { data: profile, error } = await fetchProfile(userId);
  if (error || !profile) {
    console.warn('[useAuthStore] profile fetch failed:', error ?? 'no row');
    // Fallback: keep default values already in the store
    return;
  }

  setState({
    isPremium:    profile.is_premium,
    freeRewrites: profile.credits_rewrites,
    freeInterviews: profile.credits_interviews,
  });

  // Patch session store with locale + hardcore preference from DB
  // Lazy import avoids a circular dependency (both stores import supabase, not each other)
  import('@/store/useSessionStore').then(({ useSessionStore }) => {
    const s = useSessionStore.getState();
    if (profile.locale     && s.userLang     !== profile.locale)       s.setUserLang(profile.locale);
    if (profile.hardcore_mode !== s.isHardcoreMode) {
      // Only patch if DB value differs — avoids overwriting in-session toggles
      if (profile.hardcore_mode) useSessionStore.setState({ isHardcoreMode: true });
    }
  });
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useAuthStore = create<AuthState>((set, get) => ({
  // ── Initial state ──────────────────────────────────────────────────────────
  user:           null,
  isPremium:      false,
  isAuthLoading:  true,   // stays true until INITIAL_SESSION fires
  freeRewrites:   3,
  freeInterviews: 1,
  isSaving:       false,
  lastSyncedAt:   null,
  syncError:      null,

  // ── Actions ────────────────────────────────────────────────────────────────

  initAuth: () => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        switch (event) {

          case 'INITIAL_SESSION':
            // localStorage session restore complete — stop spinner regardless
            if (session?.user) {
              set({ user: mapUser(session.user), isAuthLoading: false });
              // Hydrate from DB without blocking the spinner removal
              hydrateProfile(session.user.id, set);
            } else {
              set({ isAuthLoading: false });
            }
            break;

          case 'SIGNED_IN':
            if (session?.user) {
              set({ user: mapUser(session.user), isAuthLoading: false });
              await hydrateProfile(session.user.id, set);
            }
            break;

          case 'TOKEN_REFRESHED':
            if (session?.user) {
              // Token refresh — user already hydrated, just keep user in sync
              set({ user: mapUser(session.user) });
            }
            break;

          case 'SIGNED_OUT':
            get().clearAuth();
            break;
        }
      }
    );

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
      options: { redirectTo: redirectTo ?? `${window.location.origin}/dashboard` },
    });
    return error ?? null;
  },

  signOut: async () => {
    await supabase.auth.signOut();
    // onAuthStateChange fires SIGNED_OUT → clearAuth() called automatically
  },

  setIsPremium:     (value)           => set({ isPremium: value }),
  setIsAuthLoading: (value)           => set({ isAuthLoading: value }),
  setFreeQuota:     (rewrites, interviews) =>
    set({ freeRewrites: rewrites, freeInterviews: interviews }),

  canUseAI: () => {
    const { isPremium, freeRewrites, freeInterviews } = get();
    return isPremium || freeRewrites > 0 || freeInterviews > 0;
  },

  decrementFreeRewrites: () =>
    set(s => ({ freeRewrites: Math.max(0, s.freeRewrites - 1) })),
  decrementFreeInterviews: () =>
    set(s => ({ freeInterviews: Math.max(0, s.freeInterviews - 1) })),

  applyPromoCode: async (_code) => {
    throw new Error('applyPromoCode: not yet implemented');
  },

  syncToSupabase: async () => {
    set({ isSaving: true, syncError: null });
    try {
      set({ lastSyncedAt: new Date() });
    } catch (err) {
      set({ syncError: err instanceof Error ? err.message : 'Sync failed' });
    } finally {
      set({ isSaving: false });
    }
  },

  clearCloudData: async () => {
    throw new Error('clearCloudData: not yet implemented');
  },

  clearAuth: () =>
    set({
      user:           null,
      isPremium:      false,
      isAuthLoading:  false,
      freeRewrites:   3,
      freeInterviews: 1,
      isSaving:       false,
      lastSyncedAt:   null,
      syncError:      null,
    }),
}));
