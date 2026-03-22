/**
 * hooks/useAuth.ts — Supabase Auth Integration
 * ─────────────────────────────────────────────────────────────────────────────
 * ARCHITECTURE: onAuthStateChange as SOLE source of truth.
 *
 * Previous design had a race: getSession().then() fired syncProfileToStore()
 * without await, called setIsAuthLoading(false) immediately, then the async
 * work ran in the background.  atsDebug() called during that window saw
 * isAuthLoading=true OR resumeData={} depending on timing.
 *
 * New design:
 *   1. Subscribe to onAuthStateChange FIRST.
 *   2. INITIAL_SESSION fires synchronously (or near-sync) with the current
 *      session — await the full syncProfileToStore before calling
 *      setIsAuthLoading(false).  This means isAuthLoading stays true until
 *      BOTH the profile AND the saved draft are in the store.
 *   3. Safety timer: if INITIAL_SESSION never fires (Supabase misconfigured,
 *      network down), unblock the app after 8 s so it doesn't hang forever.
 *   4. No separate getSession() call — INITIAL_SESSION handles it.
 *
 * EVENT MATRIX:
 *   INITIAL_SESSION  → full sync + setIsAuthLoading(false)  [always]
 *   SIGNED_IN        → full sync                            [new login]
 *   TOKEN_REFRESHED  → full sync (loadSavedProgress guard skips if data exists)
 *   SIGNED_OUT       → clearAuth()
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useEffect }                   from 'react';
import { supabase, type Profile }       from '@/lib/supabase';
import { useAppStore }                  from '@/store/useAppStore';
import type { ResumeData, ChatMessage } from '@/types';

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS (module-level so they don't get recreated on every render)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Restore the user's last auto-saved draft from the backend into Zustand.
 *
 * GUARD: skips immediately if resumeData is already populated (in-session
 * navigation, hot-reload, TOKEN_REFRESHED on an active session).
 *
 * ATOMIC: resumeData + currentAtsScore + messages land in ONE setState so no
 * component sees partial state (resume without score, or score without data).
 */
async function loadSavedProgress(accessToken: string): Promise<void> {
  const currentResumeData = useAppStore.getState().resumeData;
  if (Object.keys(currentResumeData).length > 0) {
    console.log('[useAuth] loadSavedProgress — store populated, skipping restore');
    return;
  }

  console.log('[useAuth] loadSavedProgress — fetching /api/user/load-progress…');

  try {
    const res = await fetch('/api/user/load-progress', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    console.log('[useAuth] loadSavedProgress — HTTP', res.status);

    if (!res.ok) {
      console.warn('[useAuth] loadSavedProgress — non-OK response, skipping restore');
      return;
    }

    const payload: {
      found:       boolean;
      resume_data: Partial<ResumeData>;
      ats_score:   number | null;
      messages:    Array<{ role: string; content: string }>;
    } = await res.json();

    console.log('[useAuth] loadSavedProgress — payload:', {
      found:    payload.found,
      score:    payload.ats_score,
      msgs:     payload.messages?.length ?? 0,
      hasData:  Object.keys(payload.resume_data ?? {}).length > 0,
    });

    if (!payload.found || Object.keys(payload.resume_data ?? {}).length === 0) {
      console.log('[useAuth] loadSavedProgress — no saved draft found (new user / empty draft)');
      return;
    }

    // Build full ChatMessage objects with stable IDs and ordered timestamps.
    // Timestamps are spaced 100 ms apart so React list keys are unique and
    // sorting is deterministic.
    const now = Date.now();
    const restoredMessages: ChatMessage[] = (payload.messages ?? []).map((m, i) => ({
      id:        `restored_${now}_${i}`,
      role:      m.role as ChatMessage['role'],
      content:   m.content,
      timestamp: now - (payload.messages.length - 1 - i) * 100,
    }));

    // ── Single atomic write ─────────────────────────────────────────────────
    // resumeData, currentAtsScore, AND messages all land in ONE setState call.
    // No component can ever see resumeData populated but messages empty, or
    // the score at 0 while the resume is already rendered.
    useAppStore.setState({
      resumeData:      payload.resume_data as Partial<ResumeData>,
      currentAtsScore: payload.ats_score ?? 0,
      realAtsScore:    payload.ats_score ?? null,
      messages:        restoredMessages,
    });

    console.log(
      `[useAuth] ✅ Session restored — score: ${payload.ats_score} | msgs: ${restoredMessages.length}`,
    );
  } catch (err) {
    // Log — never silently swallow so we can diagnose issues
    console.error('[useAuth] loadSavedProgress — fetch error:', err);
  }
}

/**
 * Fetch the user's `profiles` row (is_premium) and then restore their draft.
 * Called after every auth event that supplies a session.
 */
async function syncProfileToStore(
  userId:      string,
  email:       string | null,
  accessToken: string,
): Promise<void> {
  const { setUser, setIsPremium } = useAppStore.getState();

  // Optimistically set the user so the TopBar avatar appears immediately
  setUser({ id: userId, email: email ?? null });

  // ── Premium flag ──────────────────────────────────────────────────────────
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('is_premium')
      .eq('id', userId)
      .single();

    if (error) {
      console.warn('[useAuth] profiles fetch failed:', error.message);
      setIsPremium(false);
    } else {
      setIsPremium((data as Profile).is_premium ?? false);
    }
  } catch (err) {
    console.error('[useAuth] profiles fetch threw:', err);
    setIsPremium(false);
  }

  // ── Draft restore ──────────────────────────────────────────────────────────
  // loadSavedProgress has its own guard — safe to call on every auth event.
  await loadSavedProgress(accessToken);
}

// ─────────────────────────────────────────────────────────────────────────────
// HOOK
// ─────────────────────────────────────────────────────────────────────────────

export function useAuth() {
  const setIsAuthLoading = useAppStore((s) => s.setIsAuthLoading);
  const clearAuth        = useAppStore((s) => s.clearAuth);

  useEffect(() => {
    setIsAuthLoading(true);
    console.log('[useAuth] Initialising — isAuthLoading: true');

    // ── Safety timer ─────────────────────────────────────────────────────────
    // If Supabase never fires INITIAL_SESSION (misconfigured SDK, network
    // failure, localStorage cleared), unblock the app after 8 s so the user
    // isn't stuck on a blank screen.
    const safetyTimer = setTimeout(() => {
      if (useAppStore.getState().isAuthLoading) {
        console.warn('[useAuth] Safety timeout — forcing isAuthLoading: false');
        useAppStore.getState().setIsAuthLoading(false);
      }
    }, 8_000);

    // ── Auth state listener ────────────────────────────────────────────────
    // onAuthStateChange is the SINGLE source of truth for auth state.
    // We do NOT call getSession() separately — INITIAL_SESSION handles it.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        console.log(`[useAuth] ${event} — user: ${session?.user?.id ?? 'none'}`);

        switch (event) {
          // ── INITIAL_SESSION ──────────────────────────────────────────────
          // Fires once on startup (always, with or without a session).
          // We AWAIT the full sync here so isAuthLoading stays true until
          // the store is completely populated.
          case 'INITIAL_SESSION': {
            if (session?.user && session.access_token) {
              await syncProfileToStore(
                session.user.id,
                session.user.email ?? null,
                session.access_token,
              );
            }
            clearTimeout(safetyTimer);
            // setIsAuthLoading AFTER the full sync — not before
            setIsAuthLoading(false);
            console.log('[useAuth] INITIAL_SESSION complete — isAuthLoading: false');
            break;
          }

          // ── SIGNED_IN ────────────────────────────────────────────────────
          // Fires after Magic Link click, Google OAuth redirect, or when
          // the session is recovered from a URL hash (#access_token=...).
          case 'SIGNED_IN': {
            if (session?.user && session.access_token) {
              await syncProfileToStore(
                session.user.id,
                session.user.email ?? null,
                session.access_token,
              );
            }
            // SIGNED_IN that fires AFTER INITIAL_SESSION must also unblock
            // loading in case INITIAL_SESSION fired without a user but
            // SIGNED_IN fires right after (Magic Link redirect race).
            if (useAppStore.getState().isAuthLoading) {
              clearTimeout(safetyTimer);
              setIsAuthLoading(false);
            }
            break;
          }

          // ── TOKEN_REFRESHED ───────────────────────────────────────────────
          // JWT expired and was silently refreshed.  Re-sync profile +
          // loadSavedProgress (the guard skips if store already has data).
          case 'TOKEN_REFRESHED': {
            if (session?.user && session.access_token) {
              await syncProfileToStore(
                session.user.id,
                session.user.email ?? null,
                session.access_token,
              );
            }
            break;
          }

          // ── SIGNED_OUT ───────────────────────────────────────────────────
          case 'SIGNED_OUT': {
            clearAuth();
            console.log('[useAuth] SIGNED_OUT — store cleared');
            break;
          }

          default:
            break;
        }
      },
    );

    // Cleanup: cancel timer + unsubscribe on unmount
    return () => {
      clearTimeout(safetyTimer);
      subscription.unsubscribe();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Exposed auth actions ──────────────────────────────────────────────────

  const signInWithEmail = async (email: string): Promise<string | null> => {
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    if (error) {
      console.error('[useAuth] Magic Link error:', error.message);
      return error.message;
    }
    return null;
  };

  const signInWithGoogle = async (): Promise<void> => {
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin,
        scopes: 'openid email profile',
      },
    });
  };

  const signOut = async (): Promise<void> => {
    await supabase.auth.signOut();
    // clearAuth() is called by the SIGNED_OUT handler above
  };

  return { signInWithEmail, signInWithGoogle, signOut };
}
