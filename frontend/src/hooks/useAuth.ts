/**
 * hooks/useAuth.ts — Supabase Auth Integration
 * ─────────────────────────────────────────────────────────────────────────────
 * ARCHITECTURE: Dual-path init — belt-and-suspenders.
 *
 * WHY dual-path?
 *   onAuthStateChange's INITIAL_SESSION can fire with session=null even when
 *   the user has a valid token in localStorage (e.g. token refresh race,
 *   Supabase SDK version quirks, cold-start timing).  When that happens the
 *   old single-path design made zero network requests — app looked brain-dead.
 *
 * TWO PATHS run in parallel on mount:
 *
 *   Path A  getSession()          — reads localStorage directly; ALWAYS fires;
 *                                   does NOT depend on the Supabase event system.
 *
 *   Path B  onAuthStateChange()   — covers INITIAL_SESSION + all future events
 *                                   (SIGNED_IN, TOKEN_REFRESHED, SIGNED_OUT).
 *
 * DEDUP:  `syncComplete` flag — whichever path fires first with a live session
 *         wins; the second path skips the sync to avoid double-fetching.
 *
 * SAFETY: 3 s failsafe timer unblocks the app if BOTH paths fail
 *         (misconfigured SDK, network down, CSP block on Supabase CDN).
 *
 * EVENT MATRIX:
 *   getSession()     → full sync + setIsAuthLoading(false)  [primary — always fires]
 *   INITIAL_SESSION  → full sync + setIsAuthLoading(false)  [backup]
 *   SIGNED_IN        → full sync + setIsAuthLoading(false)  [new login / magic link]
 *   TOKEN_REFRESHED  → full sync (loadSavedProgress guard skips if data exists)
 *   SIGNED_OUT       → clearAuth()
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useEffect }                   from 'react';
import { supabase, type Profile }       from '@/lib/supabase';
import { useAppStore }                  from '@/store/useAppStore';
import type { ResumeData, ChatMessage } from '@/types';

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS (module-level — not recreated on each render)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Restore the user's last auto-saved draft from the backend into Zustand.
 *
 * GUARD: skips if resumeData is already populated (in-session navigation,
 *        hot-reload, TOKEN_REFRESHED on an active session).
 *
 * ATOMIC: resumeData + currentAtsScore + messages land in ONE setState so no
 *         component sees partial state.
 *
 * @param accessToken  Supabase JWT — forwarded in the Authorization header.
 * @param force        Pass true to bypass the "store populated" guard
 *                     (used when we know the page was just refreshed).
 */
async function loadSavedProgress(accessToken: string, force = false): Promise<void> {
  const currentResumeData = useAppStore.getState().resumeData;
  const hasData = Object.keys(currentResumeData).length > 0;

  if (hasData && !force) {
    console.log('[useAuth] loadSavedProgress — store already populated, skipping restore');
    return;
  }

  console.warn('[useAuth] ▶ loadSavedProgress — firing GET /api/user/load-progress…');

  try {
    const res = await fetch('/api/user/load-progress', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    console.log('[useAuth] loadSavedProgress — HTTP', res.status);

    if (!res.ok) {
      console.warn('[useAuth] loadSavedProgress — non-OK response (status', res.status, '), skipping restore');
      return;
    }

    const payload: {
      found:       boolean;
      resume_data: Partial<ResumeData>;
      ats_score:   number | null;
      messages:    Array<{ role: string; content: string }>;
    } = await res.json();

    console.log('[useAuth] loadSavedProgress — payload received:', {
      found:       payload.found,
      score:       payload.ats_score,
      msgCount:    payload.messages?.length ?? 0,
      resumeKeys:  Object.keys(payload.resume_data ?? {}).length,
    });

    if (!payload.found || Object.keys(payload.resume_data ?? {}).length === 0) {
      console.log('[useAuth] loadSavedProgress — no saved draft (new user / empty draft)');
      return;
    }

    // Build full ChatMessage objects with stable IDs and ordered timestamps.
    const now = Date.now();
    const restoredMessages: ChatMessage[] = (payload.messages ?? []).map((m, i) => ({
      id:        `restored_${now}_${i}`,
      role:      m.role as ChatMessage['role'],
      content:   m.content,
      timestamp: now - (payload.messages.length - 1 - i) * 100,
    }));

    // ── Single atomic write ─────────────────────────────────────────────────
    // All fields in ONE setState — no component ever sees resumeData without
    // the score, or the score without messages.
    useAppStore.setState({
      resumeData:      payload.resume_data as Partial<ResumeData>,
      currentAtsScore: payload.ats_score ?? 0,
      realAtsScore:    payload.ats_score ?? null,
      messages:        restoredMessages,
    });

    console.warn(
      `[useAuth] ✅ Session RESTORED — score: ${payload.ats_score} | msgs: ${restoredMessages.length} | resumeKeys: ${Object.keys(payload.resume_data).join(', ')}`,
    );
  } catch (err) {
    console.error('[useAuth] loadSavedProgress — fetch threw:', err);
  }
}

/**
 * Fetch the user's `profiles` row (is_premium) then restore their saved draft.
 * Called after every auth event that supplies a live session.
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
    console.log('[useAuth] ⚡ Initialising — isAuthLoading: true');

    // Dedup flag: whichever of the two init paths fires first with a valid
    // session wins.  The second path skips syncProfileToStore to avoid
    // double-fetching /api/user/load-progress.
    let syncComplete = false;

    // Helper: clear loading state exactly once
    const markLoadingDone = (source: string) => {
      if (useAppStore.getState().isAuthLoading) {
        clearTimeout(safetyTimer);
        useAppStore.getState().setIsAuthLoading(false);
        console.log(`[useAuth] isAuthLoading: false (source: ${source})`);
      }
    };

    // ── 3 s safety timer ─────────────────────────────────────────────────────
    // If BOTH paths fail (misconfigured SDK, network down, CSP block),
    // unblock the app after 3 s so the user isn't stuck on a blank screen.
    const safetyTimer = setTimeout(() => {
      console.warn('[useAuth] ⚠️ Safety timeout (3 s) — forcing isAuthLoading: false');
      useAppStore.getState().setIsAuthLoading(false);
    }, 3_000);

    // ── PATH A: getSession() ──────────────────────────────────────────────────
    // Reads the Supabase session from localStorage directly.
    // DOES NOT depend on the event system — guaranteed to settle.
    // This is the PRIMARY init path.
    supabase.auth.getSession()
      .then(async ({ data: { session }, error }) => {
        if (error) {
          console.warn('[useAuth] getSession() error:', error.message);
        }

        console.log(
          '[useAuth] PATH A getSession() →',
          session?.user?.id ?? 'no session',
        );

        if (session?.user && session.access_token) {
          if (!syncComplete) {
            syncComplete = true;
            console.warn('[useAuth] AUTH DETECTED: TRIGGERING LOAD PROGRESS (getSession path)');
            await syncProfileToStore(
              session.user.id,
              session.user.email ?? null,
              session.access_token,
            );
          } else {
            console.log('[useAuth] getSession() — sync already complete, skipping');
          }
        } else {
          console.log('[useAuth] getSession() — no active session (user is logged out)');
        }

        markLoadingDone('getSession');
      })
      .catch((err) => {
        console.error('[useAuth] getSession() threw:', err);
        markLoadingDone('getSession-error');
      });

    // ── PATH B: onAuthStateChange ─────────────────────────────────────────────
    // Backup for INITIAL_SESSION + all future events (sign-in, sign-out, etc.)
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        console.log(`[useAuth] EVENT: ${event} — user: ${session?.user?.id ?? 'none'}`);

        switch (event) {

          // ── INITIAL_SESSION ────────────────────────────────────────────────
          // Backup init path — handles the case where getSession() succeeds
          // but INITIAL_SESSION fires with a fresher token.
          case 'INITIAL_SESSION': {
            if (session?.user && session.access_token) {
              if (!syncComplete) {
                syncComplete = true;
                console.warn('[useAuth] AUTH DETECTED: TRIGGERING LOAD PROGRESS (INITIAL_SESSION)');
                await syncProfileToStore(
                  session.user.id,
                  session.user.email ?? null,
                  session.access_token,
                );
              } else {
                console.log('[useAuth] INITIAL_SESSION — sync already complete, skipping');
              }
            }
            // Always unblock loading on INITIAL_SESSION regardless of session state
            markLoadingDone('INITIAL_SESSION');
            break;
          }

          // ── SIGNED_IN ──────────────────────────────────────────────────────
          // Fires after Magic Link click, Google OAuth redirect, or URL hash
          // recovery (#access_token=...).  Always triggers a fresh sync.
          case 'SIGNED_IN': {
            if (session?.user && session.access_token) {
              console.warn('[useAuth] AUTH DETECTED: TRIGGERING LOAD PROGRESS (SIGNED_IN)');
              // Reset syncComplete so returning users always get their data back
              syncComplete = true;
              await syncProfileToStore(
                session.user.id,
                session.user.email ?? null,
                session.access_token,
              );
            }
            markLoadingDone('SIGNED_IN');
            break;
          }

          // ── TOKEN_REFRESHED ────────────────────────────────────────────────
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

          // ── SIGNED_OUT ─────────────────────────────────────────────────────
          case 'SIGNED_OUT': {
            syncComplete = false;
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
