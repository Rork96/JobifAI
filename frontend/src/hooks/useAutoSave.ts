/**
 * hooks/useAutoSave.ts — Debounced Auto-Save Hook
 * ─────────────────────────────────────────────────────────────────────────────
 * Watches `resumeData`, `messages`, and `currentAtsScore` in the Zustand store.
 * 2000 ms after the last change, fires POST /api/user/save-progress so the
 * user's draft is silently persisted without any manual "Save" action.
 *
 * DEBOUNCE STRATEGY:
 *   We use a `useRef` timeout handle, not `lodash.debounce`, to avoid adding a
 *   dependency and to give us clean React lifecycle integration.  Each time the
 *   watched values change:
 *     1. Clear the previous pending timeout (if any).
 *     2. Schedule a new one 2000 ms in the future.
 *   When the component unmounts, the cleanup function clears the pending timeout
 *   so we never fire a save against an unmounted component.
 *
 * AUTHENTICATION:
 *   Reads the Supabase access token from `supabase.auth.getSession()` at
 *   save-time (not at hook-mount-time), so token refreshes are always reflected.
 *   If no session exists the save is silently skipped — unauthenticated users
 *   have no row to write to.
 *
 * STATUS FLAG:
 *   Sets `isSaving` in the Zustand AuthSlice to `true` while the request is
 *   in-flight and `false` when it resolves (success or failure).
 *   The ChatPanel / TopBar can subscribe to `isSaving` to show "Saving…"
 *
 * USAGE:
 *   Call this hook ONCE inside the main workspace component (e.g. App.tsx or
 *   the parent of ChatPanel + DocumentPreview).  It does not return anything.
 *
 *   ```tsx
 *   // In WorkspaceLayout.tsx or App.tsx:
 *   useAutoSave();
 *   ```
 *
 * REQUIRED DB MIGRATION (run once in Supabase SQL editor):
 * ─────────────────────────────────────────────────────────────────────────────
 *   ALTER TABLE public.resumes
 *     ADD COLUMN IF NOT EXISTS chat_history_json jsonb DEFAULT '[]'::jsonb;
 *
 *   CREATE UNIQUE INDEX IF NOT EXISTS resumes_user_id_draft_idx
 *     ON public.resumes (user_id)
 *     WHERE (job_title = '__autosave__');
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useEffect, useRef } from 'react';
import { supabase }          from '@/lib/supabase';
import { useAppStore }       from '@/store/useAppStore';

// How long to wait after the last change before firing the save.
const DEBOUNCE_MS = 2_000;

// Backend endpoint — keep in sync with backend/routers/user.py
const SAVE_ENDPOINT = '/api/user/save-progress';

export function useAutoSave(): void {
  // ── Watched state ──────────────────────────────────────────────────────────
  // Each of these subscriptions is a primitive selector so Zustand only
  // triggers a re-run when that exact value changes (no shallow-equal needed).
  const resumeData      = useAppStore((s) => s.resumeData);
  const messages        = useAppStore((s) => s.messages);
  const currentAtsScore = useAppStore((s) => s.currentAtsScore);

  // ── Actions (stable references — never cause re-renders) ──────────────────
  const setIsSaving = useAppStore((s) => s.setIsSaving);

  // ── Timeout handle ────────────────────────────────────────────────────────
  // `useRef` so mutations don't trigger re-renders, and the value persists
  // across renders (unlike a local variable which resets each render cycle).
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // ── 1. Clear any pending save ──────────────────────────────────────────
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
    }

    // ── 2. Schedule new save ────────────────────────────────────────────────
    timeoutRef.current = setTimeout(async () => {
      // ── 2a. Get the current Supabase session ─────────────────────────────
      // We fetch the session here (inside the timeout callback) so we always
      // use the most-recently-refreshed token, not a stale closure value.
      const { data: { session } } = await supabase.auth.getSession();

      if (!session?.access_token) {
        // User is not authenticated — nothing to save.
        // This is expected for unauthenticated drafts; fail silently.
        return;
      }

      // ── 2b. Fire the save ─────────────────────────────────────────────────
      setIsSaving(true);

      try {
        const response = await fetch(SAVE_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            resume_data: resumeData,
            ats_score:   currentAtsScore,
            // Serialise messages to plain objects — ChatMessage has `id` and
            // `timestamp` that the backend stores as JSON and replays verbatim.
            messages: messages.map(({ role, content }) => ({ role, content })),
          }),
        });

        if (!response.ok) {
          // Non-2xx: log but don't throw — a failed auto-save should never
          // crash the UI or interrupt the user's workflow.
          const body = await response.text().catch(() => '(no body)');
          console.warn(
            `[useAutoSave] Save failed — HTTP ${response.status}: ${body}`,
          );
        }
        // On success we intentionally do NOT show a toast — the "Saving…"
        // indicator disappearing is feedback enough for an auto-save.

      } catch (err) {
        // Network error — log quietly so it doesn't surface as an uncaught
        // promise rejection.
        console.warn('[useAutoSave] Network error during save:', err);
      } finally {
        setIsSaving(false);
      }
    }, DEBOUNCE_MS);

    // ── Cleanup: cancel the pending save if the component unmounts ──────────
    // Without this, the timeout fires against a dead component reference and
    // we'd see the "Can't perform a React state update on an unmounted
    // component" warning (or a stale save with out-of-date data).
    return () => {
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // We intentionally exclude `setIsSaving` (stable action ref).
    // resumeData and messages are objects — identity changes on every update,
    // which is what we WANT: any mutation to the resume or chat triggers the debounce.
  }, [resumeData, messages, currentAtsScore]);
}
