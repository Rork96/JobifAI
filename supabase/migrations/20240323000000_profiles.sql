-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: profiles — One row per authenticated user.
-- Owns: premium flag, Stripe billing state, free-tier credits, locale prefs.
--
-- Run in Supabase Dashboard → SQL Editor → New query → paste + Run
-- Safe to run multiple times (all DDL uses IF NOT EXISTS / OR REPLACE / DROP IF EXISTS).
--
-- Columns:
--   Core        — email, is_premium, locale, credits_*, hardcore_mode
--   Stripe      — stripe_customer_id, subscription_status, stripe_price_id,
--                 current_period_end, cancel_at_period_end
--   Audit       — created_at, updated_at (auto-bumped by trigger)
--
-- Relationships:
--   id  →  auth.users(id)  ON DELETE CASCADE
--   ON DELETE CASCADE ensures the profile row is wiped when the auth account
--   is deleted (e.g. via "Delete my account" in Settings).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Table ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.profiles (
  -- PK = auth.users UUID — no surrogate key; one row per user, enforced at schema level.
  id                   uuid         PRIMARY KEY
                                    REFERENCES auth.users(id) ON DELETE CASCADE,

  -- ── Identity ──────────────────────────────────────────────────────────────
  -- Denormalised from auth.users.email for display and Stripe pre-fill.
  -- Kept in sync by the handle_new_user trigger + explicit upsert on every login.
  email                text         NOT NULL DEFAULT '',

  -- ── Premium flag ──────────────────────────────────────────────────────────
  -- Source of truth for all quota gates.  Flipped to true by the stripe-webhook
  -- function on checkout.session.completed; back to false on subscription.deleted.
  is_premium           boolean      NOT NULL DEFAULT false,

  -- ── Free-tier credits ─────────────────────────────────────────────────────
  -- Decremented by the backend on each AI call (POST /api/resume/rewrite, etc.).
  -- Frontend reads them for display; server is authoritative.
  credits_rewrites     integer      NOT NULL DEFAULT 3,
  credits_interviews   integer      NOT NULL DEFAULT 1,

  -- ── UI preferences ────────────────────────────────────────────────────────
  locale               text         NOT NULL DEFAULT 'en',
  hardcore_mode        boolean      NOT NULL DEFAULT false,

  -- ── Stripe billing ────────────────────────────────────────────────────────
  -- stripe_customer_id is set by the webhook on first successful checkout.
  -- Used to look up subscription events that don't carry client_reference_id.
  stripe_customer_id   text         UNIQUE,

  -- subscription_status mirrors Stripe subscription.status:
  --   'incomplete' (default, pre-purchase) | 'active' | 'past_due' |
  --   'canceled' | 'unpaid' | 'trialing'
  -- For 24-hour passes (one-time payment) we set this to 'active' immediately.
  subscription_status  text         NOT NULL DEFAULT 'incomplete',

  -- The Stripe price ID that was purchased — used by the webhook to distinguish
  -- between pro monthly and 24h pass for any future entitlement logic.
  stripe_price_id      text,

  -- current_period_end: UTC timestamp when the current billing period ends.
  -- Null for 24h passes (not a recurring subscription).
  current_period_end   timestamptz,

  -- cancel_at_period_end: true when the user has requested cancellation but
  -- the subscription is still active until current_period_end.
  cancel_at_period_end boolean      NOT NULL DEFAULT false,

  -- ── Audit ─────────────────────────────────────────────────────────────────
  created_at           timestamptz  NOT NULL DEFAULT now(),
  updated_at           timestamptz  NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.profiles IS
  'One row per user. id = auth.users.id. Owns premium flag + Stripe billing state.';
COMMENT ON COLUMN public.profiles.is_premium IS
  'True when the user has an active subscription or 24h pass. Set by stripe-webhook.';
COMMENT ON COLUMN public.profiles.subscription_status IS
  'Mirrors Stripe subscription.status. ''incomplete'' = never purchased.';
COMMENT ON COLUMN public.profiles.stripe_customer_id IS
  'Stripe Customer ID. Set on first checkout. Used to match subscription events.';
COMMENT ON COLUMN public.profiles.stripe_price_id IS
  'The Stripe Price ID the user purchased. Null until first checkout.';
COMMENT ON COLUMN public.profiles.current_period_end IS
  'UTC end of the current billing period. Null for one-time 24h pass purchases.';


-- ── updated_at trigger ────────────────────────────────────────────────────────
-- Re-use the set_updated_at() function created in 20240322000000_user_data.sql.
-- Both migrations define it as OR REPLACE so the order of execution is safe.

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_profiles_updated ON public.profiles;
CREATE TRIGGER on_profiles_updated
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ── Auto-create profile on sign up ────────────────────────────────────────────
-- Fired AFTER every INSERT on auth.users (new sign-up via email or OAuth).
-- ON CONFLICT (id) DO NOTHING makes this idempotent — safe if the user was
-- already inserted via upsert in fetchProfile().

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, email)
  VALUES (NEW.id, COALESCE(NEW.email, ''))
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


-- ── Row Level Security ────────────────────────────────────────────────────────
-- Enabled for direct frontend reads (anon key + user JWT).
-- The stripe-webhook Edge Function uses the service-role key — bypasses RLS.
-- The FastAPI backend uses the service-role key — bypasses RLS but validates
-- ownership via get_authenticated_user_id().

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Drop first so this script is idempotent.
DROP POLICY IF EXISTS "profiles: read own"   ON public.profiles;
DROP POLICY IF EXISTS "profiles: insert own" ON public.profiles;
DROP POLICY IF EXISTS "profiles: update own" ON public.profiles;
DROP POLICY IF EXISTS "profiles: delete own" ON public.profiles;

-- SELECT: users can only read their own row.
CREATE POLICY "profiles: read own"
  ON public.profiles FOR SELECT
  USING (auth.uid() = id);

-- INSERT: users can only create a row where id = their own UID.
-- This allows the fetchProfile() self-heal upsert on first login.
CREATE POLICY "profiles: insert own"
  ON public.profiles FOR INSERT
  WITH CHECK (auth.uid() = id);

-- UPDATE: users can update their own row.
-- Stripe-critical columns (is_premium, subscription_status, etc.) are updated
-- by the stripe-webhook Edge Function using the service-role key, which bypasses
-- this policy — users cannot grant themselves premium via the frontend.
CREATE POLICY "profiles: update own"
  ON public.profiles FOR UPDATE
  USING  (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- DELETE: user can wipe their own row (used by "Delete My Account").
CREATE POLICY "profiles: delete own"
  ON public.profiles FOR DELETE
  USING (auth.uid() = id);


-- ── Grant ─────────────────────────────────────────────────────────────────────
-- Allow the authenticated role (anon key + user JWT) to perform all operations.
-- RLS policies above still gate row access.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.profiles
  TO authenticated;
