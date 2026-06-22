/**
 * useAuthStore — Store 1 of 5
 * ─────────────────────────────────────────────────────────────────────────────
 * Handbook §4.2 — owns: session identity, premium status, freemium quota
 * counters, Supabase sync.
 *
 * Auth + profile hydration flow:
 *   App.tsx calls initAuth() once on mount.
 *   initAuth() flow:
 *     1. await getSession() → single authoritative gate for isAuthLoading:false
 *        Sets user + session before ProtectedRoute ever re-renders.
 *     2. onAuthStateChange listener (INITIAL_SESSION is a deliberate no-op here):
 *        SIGNED_IN       → map user, then fetchProfile() to hydrate credits/locale
 *        TOKEN_REFRESHED → map user (profile already loaded)
 *        SIGNED_OUT      → clearAuth()
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
import type { AuthError, Session, User } from '@supabase/supabase-js';
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
  /**
   * The live Supabase session object. This is the JWT carrier.
   * Never null when user is non-null — they are always set together.
   * DB queries will return 0 rows (RLS) if session is null even when user isn't.
   */
  session:       Session | null;
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

// ── Module-level init guard ───────────────────────────────────────────────────
// Raw JS variable — lives OUTSIDE React's render cycle and outside Zustand.
// Zustand state can be reset by hydration; this cannot.
//
// Guarantees initAuth's IIFE and its watchdog run EXACTLY ONCE per page load,
// even under React StrictMode (which mounts → unmounts → remounts in dev) or
// any other double-invocation scenario.
let _initStarted = false;

// Module-level flag — ensures we hydrate at most once per browser session
// even if SIGNED_IN fires multiple times (token refresh, StrictMode double-invoke).
let _hydratedUserId: string | null = null;

/**
 * After SIGNED_IN: upsert-then-fetch the profile row, patch the store.
 * Guarded by _hydratedUserId so it runs at most once per unique user per session.
 *
 * Phase 11.18: passes email so fetchProfile can self-heal a missing profile row
 * (INSERT … ON CONFLICT DO NOTHING). This guarantees the FK target exists
 * before any saveResume call can fire.
 */
async function hydrateProfile(userId: string, email: string, setState: (partial: Partial<AuthState>) => void) {
  if (_hydratedUserId === userId) {
    console.log('🔐 [Auth] hydrateProfile: already hydrated for', userId, '— skipping');
    return;
  }
  _hydratedUserId = userId;

  try {
    console.log('🔐 [Auth] hydrateProfile: fetching profile for', userId);

    const { data: profile, error } = await fetchProfile(userId, email);

    if (error) {
      console.error('❌ [Profile] Fetch error:', error, '— attempting emergency upsert then bailing to free-tier');
      // Best-effort emergency creation: profile row may simply not exist yet
      // (new user, DB trigger not fired, or RLS blocked the self-heal in fetchProfile).
      // subscription_status:'incomplete' is the safe default — not premium.
      await supabase
        .from('profiles')
        .upsert(
          { id: userId, email, subscription_status: 'incomplete' },
          { onConflict: 'id', ignoreDuplicates: true },
        )
        .then(({ error: e }) => {
          if (e) console.warn('⚠️ [Profile] Emergency upsert also failed:', e.message);
          else   console.log('✅ [Profile] Emergency upsert succeeded — row should now exist');
        });
      return; // Non-fatal: store keeps free-tier defaults
    }

    if (!profile) {
      console.warn('⚠️ [Profile] No row returned even after upsert — using free-tier defaults');
      return;
    }

    console.log('✅ [Profile] Loaded — subscription_status:', profile.subscription_status, '| is_premium:', profile.is_premium);

    // isPremium: active subscription OR legacy flag
    const isPremium = profile.subscription_status === 'active' || profile.is_premium;

    setState({
      isPremium,
      freeRewrites:   profile.credits_rewrites,
      freeInterviews: profile.credits_interviews,
    });

    // Patch session store — lazy import avoids circular dependency
    import('@/store/useSessionStore').then(({ useSessionStore }) => {
      const s = useSessionStore.getState();
      if (profile.locale && s.userLang !== profile.locale) s.setUserLang(profile.locale);
      if (profile.hardcore_mode && profile.hardcore_mode !== s.isHardcoreMode) {
        useSessionStore.setState({ isHardcoreMode: true });
      }
    }).catch(err => {
      console.warn('⚠️ [Profile] Could not patch session store:', err);
    });

  } catch (err) {
    // hydrateProfile MUST NOT propagate — initAuth's finally block owns isAuthLoading
    console.error('❌ [Profile] Unexpected crash in hydrateProfile — using free-tier defaults:', err);
    _hydratedUserId = null; // allow retry on next sign-in
  }
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useAuthStore = create<AuthState>((set, get) => ({
  // ── Initial state ──────────────────────────────────────────────────────────
  user:           null,
  session:        null,
  isPremium:      false,
  isAuthLoading:  true,   // stays true until getSession() resolves in initAuth()
  freeRewrites:   3,
  freeInterviews: 1,
  isSaving:       false,
  lastSyncedAt:   null,
  syncError:      null,

  // ── Actions ────────────────────────────────────────────────────────────────

  initAuth: () => {
    // ── Atomic init guard ──────────────────────────────────────────────────
    // _initStarted is a raw module-level JS variable — immune to React
    // StrictMode's mount→unmount→remount cycle and to Zustand re-hydration.
    // If this guard didn't exist, StrictMode would call initAuth twice:
    //   call #1 → sets isAuthLoading:true, starts IIFE, registers listener
    //   cleanup  → unsubscribes listener
    //   call #2 → resets isAuthLoading:true, starts SECOND IIFE racing #1
    // The second IIFE is what causes the permanent "Restoring session…" lock.
    if (_initStarted) {
      console.warn('🛡️ [Auth] initAuth blocked — already initialised (StrictMode or double-invoke)');
      return () => {}; // no-op unsubscribe; real listener still alive from call #1
    }
    _initStarted = true;
    console.log('🔐 [Auth] initAuth starting…');

    // ── Watchdog: nuclear fallback ─────────────────────────────────────────
    // Set BEFORE the try block so it cannot be cancelled by a hung promise.
    // Calling set({ isAuthLoading: false }) when auth already resolved is a
    // harmless no-op — the check inside guards against spurious logging.
    // We intentionally do NOT clearTimeout in the finally block: if the IIFE
    // hangs and never reaches finally, the watchdog is the only escape hatch.
    setTimeout(() => {
      if (useAuthStore.getState().isAuthLoading) {
        console.error('❌ [Auth] 5 s watchdog fired — forcing isAuthLoading:false (IIFE may be hung)');
        set({ isAuthLoading: false });
      }
    }, 5_000);

    // ── Step 1: Authoritative initial hydration ────────────────────────────
    // Async IIFE — getSession() is the single gate for the initial load.
    // CRITICAL: INITIAL_SESSION from onAuthStateChange is a deliberate no-op
    // (see listener below). getSession() owns the first isAuthLoading release.
    (async () => {
      try {
        set({ isAuthLoading: true });

        const { data: { session }, error } = await supabase.auth.getSession();
        if (error) throw error;

        if (session?.user) {
          console.log('🔐 [Auth] Session found for', session.user.email, '— hydrating profile…');
          set({ user: mapUser(session.user), session });
          await hydrateProfile(session.user.id, session.user.email ?? '', set);
        } else {
          console.log('🔐 [Auth] No session — user is logged out.');
          set({ user: null, session: null });
        }
      } catch (err) {
        console.error('❌ [Auth] CRITICAL CRASH in initAuth — falling back to logged-out state:', err);
        set({ user: null, session: null });
      } finally {
        // finally always runs unless the JS engine itself crashes, so this is
        // the primary release path. The watchdog above is the emergency backup.
        console.log('🔐 [Auth] Releasing isAuthLoading lock (finally).');
        set({ isAuthLoading: false });
      }
    })();

    // ── Step 2: Subscribe for post-init changes only ───────────────────────
    // INITIAL_SESSION is intentionally a no-op — the async IIFE above owns it.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        switch (event) {

          case 'INITIAL_SESSION':
            // Deliberately a no-op. The IIFE above is the authoritative source
            // for initial state and prevents the INITIAL_SESSION/getSession race.
            break;

          case 'SIGNED_IN':
            if (session?.user) {
              console.log('🔐 [Auth] SIGNED_IN:', session.user.email);
              set({ user: mapUser(session.user), session, isAuthLoading: false });
              await hydrateProfile(session.user.id, session.user.email ?? '', set);
            }
            break;

          case 'TOKEN_REFRESHED':
            if (session?.user) {
              // Keep the session JWT in sync so every DB request carries a fresh token.
              set({ user: mapUser(session.user), session });
            }
            break;

          case 'SIGNED_OUT':
            console.log('🔐 [Auth] SIGNED_OUT — clearing state.');
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
      options: {
        queryParams: {
          prompt: 'select_account',
          access_type: 'offline',
        },
        redirectTo: redirectTo ?? `${window.location.origin}/dashboard`,
      },
    });
    return error ?? null;
  },

  signOut: async () => {
    await supabase.auth.signOut();
    // Hard redirect — works from any route (Billing, Workspace, Settings, etc.)
    // without relying on a React Router context being available in the caller.
    window.location.href = '/login';
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

  clearAuth: () => {
    _hydratedUserId = null;
    set({
      user:           null,
      session:        null,
      isPremium:      false,
      isAuthLoading:  false,
      freeRewrites:   3,
      freeInterviews: 1,
      isSaving:       false,
      lastSyncedAt:   null,
      syncError:      null,
    });
  },
}));
