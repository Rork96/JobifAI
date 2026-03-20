/**
 * hooks/useAuth.ts — Supabase Auth Integration
 * ─────────────────────────────────────────────────────────────────────────────
 * This hook owns ALL authentication logic.  It is called ONCE in main.tsx
 * (at the root, outside React) to set up the auth listener.  Components
 * read auth state from the Zustand store; they do NOT call this hook directly.
 *
 * WHAT THIS HOOK DOES:
 *   1. Checks for an existing session on app load (restores logged-in state).
 *   2. Subscribes to Supabase auth state changes (sign-in, sign-out, token
 *      refresh) and keeps the Zustand store in sync.
 *   3. After a sign-in, fetches the user's `profiles` row to read `is_premium`.
 *   4. Exposes `signInWithEmail`, `signInWithGoogle`, and `signOut` actions.
 *
 * WHY HERE AND NOT IN A COMPONENT?
 *   Auth state must outlive any single component.  By initialising the
 *   listener in a hook called from the React root, we guarantee it's always
 *   running even if the user navigates between screens.
 *
 * AUTH FLOWS SUPPORTED:
 *   • Magic Link  — passwordless email one-time link (OTP)
 *   • Google OAuth — popup/redirect OAuth2 via Supabase's Google provider
 *
 * PREMIUM CHECK:
 *   After every sign-in, we SELECT from `public.profiles` where id = user.id.
 *   The `is_premium` flag is flipped to true by the Stripe webhook handler in
 *   the backend.  We copy it into the Zustand store so the paywall in
 *   DocumentPreview can gate the PDF export without another round-trip.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useEffect } from 'react';
import { supabase, type Profile } from '@/lib/supabase';
import { useAppStore }            from '@/store/useAppStore';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Fetch the `profiles` row for a given user ID and update the Zustand store
 * with `is_premium` and the user object.
 *
 * Called after every successful sign-in event so the store always reflects
 * the latest entitlement state.
 */
async function syncProfileToStore(userId: string, email: string | null): Promise<void> {
  const { setUser, setIsPremium } = useAppStore.getState();

  // Optimistically set the user so the UI updates immediately (no flicker)
  setUser({ id: userId, email: email ?? null });

  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('is_premium')
      .eq('id', userId)
      .single();

    if (error) {
      // Profile may not exist yet if the `handle_new_user` trigger hasn't fired.
      // This can happen in development if the trigger was added after the user
      // was created.  Fail gracefully — isPremium stays false.
      console.warn('[useAuth] Could not fetch profile:', error.message);
      setIsPremium(false);
      return;
    }

    setIsPremium((data as Profile).is_premium ?? false);
  } catch {
    setIsPremium(false);
  }
}

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * Initialise the Supabase auth listener.
 * Call this hook ONCE at the application root (in main.tsx or App.tsx).
 *
 * Returns auth action helpers that the TopBar Sign-In UI can call directly.
 *
 * Usage:
 *   // In App.tsx or main.tsx:
 *   const auth = useAuth();
 *
 *   // Pass actions down to the TopBar:
 *   <TopBar onSignIn={auth.signInWithEmail} onSignOut={auth.signOut} />
 */
export function useAuth() {
  const { setIsAuthLoading, clearAuth } = useAppStore(
    (s) => ({ setIsAuthLoading: s.setIsAuthLoading, clearAuth: s.clearAuth })
  );

  useEffect(() => {
    // ── Step 1: Check for an existing session on mount ─────────────────────
    // This restores state after a page refresh or a Magic Link redirect.
    setIsAuthLoading(true);

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        syncProfileToStore(session.user.id, session.user.email ?? null);
      }
      // Regardless of whether there's a session, we're done loading
      setIsAuthLoading(false);
    });

    // ── Step 2: Listen for auth state changes ─────────────────────────────
    // Supabase fires this whenever the user signs in, signs out, or the
    // JWT is refreshed automatically.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
          if (session?.user) {
            await syncProfileToStore(session.user.id, session.user.email ?? null);
          }
        }

        if (event === 'SIGNED_OUT') {
          clearAuth();
        }

        // INITIAL_SESSION fires immediately — mark loading done
        if (event === 'INITIAL_SESSION') {
          setIsAuthLoading(false);
        }
      }
    );

    // Cleanup: unsubscribe when the hook is unmounted (app teardown)
    return () => subscription.unsubscribe();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Exposed auth actions ─────────────────────────────────────────────────

  /**
   * Send a Magic Link email.  The user clicks the link in their inbox and is
   * redirected back to the app, where `onAuthStateChange` catches the session.
   *
   * @param email  The user's email address.
   * @returns      An error string if the send failed, null on success.
   */
  const signInWithEmail = async (email: string): Promise<string | null> => {
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        // After clicking the Magic Link, redirect here so the app can catch
        // the session from the URL fragment.
        emailRedirectTo: window.location.origin,
      },
    });
    if (error) {
      console.error('[useAuth] Magic Link error:', error.message);
      return error.message;
    }
    return null;
  };

  /**
   * Open the Google OAuth flow.
   * Supabase handles the OAuth popup/redirect and fires `SIGNED_IN` when done.
   */
  const signInWithGoogle = async (): Promise<void> => {
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin,
        // Request the profile scope so we can access the user's name + avatar
        scopes: 'openid email profile',
      },
    });
  };

  /**
   * Sign the user out and wipe all local session state.
   * The `onAuthStateChange` handler fires `SIGNED_OUT` and calls `clearAuth()`.
   */
  const signOut = async (): Promise<void> => {
    await supabase.auth.signOut();
    // clearAuth() is called by the onAuthStateChange handler above
  };

  return { signInWithEmail, signInWithGoogle, signOut };
}
