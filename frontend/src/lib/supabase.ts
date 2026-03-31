/**
 * lib/supabase.ts — Supabase Browser Client (Singleton)
 * ─────────────────────────────────────────────────────────────────────────────
 * Creates ONE shared Supabase client for the entire frontend.
 *
 * WHY a singleton?
 *   The Supabase client maintains a persistent WebSocket connection for
 *   realtime subscriptions and handles the auth token refresh cycle
 *   internally.  Creating multiple instances would create duplicate
 *   connections and cause race conditions in the token refresh loop.
 *
 * ENVIRONMENT VARIABLES:
 *   VITE_SUPABASE_URL      — Your project's REST / WS endpoint
 *   VITE_SUPABASE_ANON_KEY — The public "anon" JWT key (safe to expose)
 *
 *   These are prefixed with VITE_ so Vite's import.meta.env exposes them
 *   to the browser bundle.  The service-role key MUST NEVER go in the
 *   frontend — it lives only in the FastAPI backend .env.
 *
 * STORAGE:
 *   Default: localStorage.  The JWT + refresh token are persisted so the
 *   user stays logged in across page refreshes.
 *
 * AUTH FLOW SUPPORTED:
 *   1. Magic Link (passwordless email) — `signInWithOtp({ email })`
 *   2. Google OAuth                   — `signInWithOAuth({ provider: 'google' })`
 *   3. Session restore on load        — `getSession()` in useAuth.ts
 *   4. Sign out                       — `signOut()` in useAuth.ts
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createClient } from '@supabase/supabase-js';

// Vite replaces import.meta.env.* at build time with the values from .env
const supabaseUrl  = import.meta.env.VITE_SUPABASE_URL  as string;
const supabaseAnon = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!supabaseUrl || !supabaseAnon) {
  // This error fires at import time — catches misconfigured builds immediately
  // rather than mysterious auth failures later.
  throw new Error(
    '[JobifAI] Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. '
    + 'Check your .env file.'
  );
}

/**
 * The single shared Supabase browser client.
 *
 * Import this wherever you need Supabase access:
 *   import { supabase } from '@/lib/supabase';
 */
export const supabase = createClient(supabaseUrl, supabaseAnon, {
  auth: {
    // Persist session across page refreshes using localStorage.
    // Set to false for pure server-side rendering environments.
    persistSession:     true,
    // Automatically refresh the JWT before it expires (every ~60 min).
    autoRefreshToken:   true,
    // Detect the auth callback URL on page load (Magic Link + OAuth redirect).
    detectSessionInUrl: true,
  },
});

// ── Type helpers ──────────────────────────────────────────────────────────────

/** The shape of a row from the `public.profiles` table. */
export interface Profile {
  id:                 string;
  email:              string;
  stripe_customer_id: string | null;
  is_premium:         boolean;
  created_at:         string;
  updated_at:         string;
}

/** The shape of a row from the `public.resumes` table. */
export interface ResumeRow {
  id:                string;
  user_id:           string;
  job_title:         string | null;
  content_json:      Record<string, unknown>;
  current_ats_score: number | null;
  job_description:   string | null;
  created_at:        string;
  updated_at:        string;
}

/**
 * The shape of a row from the `public.user_data` table.
 *
 * One row per user — `id` IS the auth.users UUID (no separate user_id column).
 * Created by: supabase/migrations/20240322000000_user_data.sql
 *
 * Columns:
 *   id               — auth.users.id (PK, FK with ON DELETE CASCADE)
 *   resume_data      — Zustand ResumeData (targetTitle, experiences, skills…)
 *   analysis_result  — Full ATSAnalysisResponse from /api/analyze
 *   chat_history     — [{role, content}] message array
 *   is_premium       — denormalised from profiles.is_premium
 *   updated_at       — auto-bumped by DB trigger on every UPDATE
 */
export interface UserData {
  id:              string;
  resume_data:     Record<string, unknown>;
  analysis_result: Record<string, unknown> | null;
  chat_history:    Array<{ role: string; content: string }>;
  is_premium:      boolean;
  updated_at:      string;
}
