-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: user_data — Single-row-per-user cloud persistence
-- Run in Supabase Dashboard → SQL Editor → New query → paste + Run
-- Safe to run multiple times (all DDL is IF NOT EXISTS / OR REPLACE).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Table ─────────────────────────────────────────────────────────────────────
-- One row per authenticated user.
-- `id` IS the user's auth.users UUID — no separate user_id column.
-- This enforces the 1-row-per-user contract at the schema level.
-- ON DELETE CASCADE wipes the row automatically when the auth account is deleted.

CREATE TABLE IF NOT EXISTS public.user_data (
  id               uuid         PRIMARY KEY
                                REFERENCES auth.users(id) ON DELETE CASCADE,

  -- ── Resume state ────────────────────────────────────────────────────────────
  -- Full Zustand ResumeData object (targetTitle, summary, experiences, skills…).
  -- Upserted on every debounced auto-save from the frontend.
  resume_data      jsonb        NOT NULL DEFAULT '{}'::jsonb,

  -- Full ATSAnalysisResponse returned by POST /api/analyze.
  -- Null until the user completes at least one analysis run.
  -- Persisted so the score ring + ghost keyword carousel survive a page refresh.
  analysis_result  jsonb                 DEFAULT NULL,

  -- Chat message history: [{role: "user"|"assistant", content: "..."}].
  -- Restored on load so the conversation picks up where it left off.
  chat_history     jsonb        NOT NULL DEFAULT '[]'::jsonb,

  -- ── Account tier ────────────────────────────────────────────────────────────
  -- Denormalised mirror of profiles.is_premium for fast hydration reads.
  -- Updated by the Stripe webhook handler (POST /api/webhooks/stripe).
  -- Frontend should treat profiles.is_premium as the source of truth.
  is_premium       boolean      NOT NULL DEFAULT false,

  -- ── Audit ───────────────────────────────────────────────────────────────────
  updated_at       timestamptz  NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.user_data IS
  'One row per user. id = auth.users.id. Auto-saved from the frontend on every meaningful state change.';
COMMENT ON COLUMN public.user_data.resume_data IS
  'Zustand ResumeData (JSON). Upserted by POST /api/user/save-progress.';
COMMENT ON COLUMN public.user_data.analysis_result IS
  'ATSAnalysisResponse from /api/analyze. Null until first analysis run.';
COMMENT ON COLUMN public.user_data.chat_history IS
  'Array of {role, content} objects. Full conversation restored on page refresh.';
COMMENT ON COLUMN public.user_data.is_premium IS
  'Denormalised from profiles.is_premium. Updated by Stripe webhook.';


-- ── updated_at trigger ────────────────────────────────────────────────────────
-- Automatically bumps updated_at on every UPDATE so the client can display
-- "Saved X minutes ago" without an extra round-trip.

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_user_data_updated ON public.user_data;
CREATE TRIGGER on_user_data_updated
  BEFORE UPDATE ON public.user_data
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ── Row Level Security ────────────────────────────────────────────────────────
-- Enabled for frontend direct-SDK reads (anon key).
-- The FastAPI backend uses the service-role key (bypasses RLS) but still
-- validates ownership manually via the JWT in get_authenticated_user_id().

ALTER TABLE public.user_data ENABLE ROW LEVEL SECURITY;

-- Drop first so this script is idempotent (safe to re-run after changes).
DROP POLICY IF EXISTS "user_data: read own"   ON public.user_data;
DROP POLICY IF EXISTS "user_data: insert own" ON public.user_data;
DROP POLICY IF EXISTS "user_data: update own" ON public.user_data;
DROP POLICY IF EXISTS "user_data: delete own" ON public.user_data;

-- SELECT: user can only read their own row.
CREATE POLICY "user_data: read own"
  ON public.user_data FOR SELECT
  USING (auth.uid() = id);

-- INSERT: user can only create a row where id = their own UID.
CREATE POLICY "user_data: insert own"
  ON public.user_data FOR INSERT
  WITH CHECK (auth.uid() = id);

-- UPDATE: user can only modify their own row, and cannot change the id.
CREATE POLICY "user_data: update own"
  ON public.user_data FOR UPDATE
  USING  (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- DELETE: user can wipe their own row (used by "Clear All Data" in Settings).
CREATE POLICY "user_data: delete own"
  ON public.user_data FOR DELETE
  USING (auth.uid() = id);


-- ── Grant ─────────────────────────────────────────────────────────────────────
-- Allow the authenticated role (used by the anon key when a user is signed in)
-- to perform all operations.  The RLS policies above still gate row access.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.user_data
  TO authenticated;
