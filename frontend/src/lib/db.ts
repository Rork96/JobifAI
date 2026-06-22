/**
 * lib/db.ts — Typed Supabase query helpers
 * ─────────────────────────────────────────────────────────────────────────────
 * Thin wrappers around supabase-js that:
 *   1. Return strongly-typed results matching our DB schema
 *   2. Never throw — always return { data, error } so callers decide UX
 *   3. Are pure functions (no Zustand imports) so they're testable in isolation
 *
 * Consumers:
 *   useAuthStore   → fetchProfile, upsertProfile
 *   useDocumentStore → persistResume, fetchLatestResume
 *   DashboardPage  → fetchLatestResume on mount
 *
 * Column map (DB → store):
 *   profiles.credits_rewrites   → useAuthStore.freeRewrites
 *   profiles.credits_interviews → useAuthStore.freeInterviews
 *   profiles.hardcore_mode      → useSessionStore.isHardcoreMode
 *   profiles.locale             → useSessionStore.userLang
 *   resumes.current_ats_score   → useDocumentStore.currentAtsScore
 *   resumes.ats_gaps            → useDocumentStore.atsGaps
 *   resumes.cv_filename         → displayed in DashboardPage ContextBar
 *   resumes.job_description     → useSessionStore.jobDescription
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { supabase } from '@/lib/supabase';

// ── DB row types ──────────────────────────────────────────────────────────────

export interface ProfileRow {
  id:                   string;
  email:                string;
  is_premium:           boolean;
  locale:               string;
  credits_rewrites:     number;
  credits_interviews:   number;
  hardcore_mode:        boolean;
  stripe_customer_id:   string | null;
  subscription_status:  string | null;
  stripe_price_id:      string | null;
  current_period_end:   string | null;
  cancel_at_period_end: boolean;
  created_at:           string;
  updated_at:           string;
}

export interface ResumeRow {
  id:                string;
  user_id:           string;
  cv_filename:       string | null;
  job_title:         string | null;
  content_json:      Record<string, unknown>;
  current_ats_score: number | null;
  ats_gaps:          string[];
  job_description:   string | null;
  created_at:        string;
  updated_at:        string;
}

// ── Profile helpers ───────────────────────────────────────────────────────────

// Core columns guaranteed to exist on every environment (pre-Stripe migration too).
const PROFILE_SELECT_CORE = 'id, email, is_premium, locale, credits_rewrites, credits_interviews, hardcore_mode, created_at, updated_at';
// Extended columns added by the Stripe billing migration (Phase 12.1).
// Selected separately so a missing column fails gracefully at parse time, not query time.
const PROFILE_SELECT_STRIPE = 'stripe_customer_id, subscription_status, stripe_price_id, current_period_end, cancel_at_period_end';
const PROFILE_SELECT = `${PROFILE_SELECT_CORE}, ${PROFILE_SELECT_STRIPE}`;

/**
 * Ensure the profile row exists, then fetch it.
 *
 * Phase 11.18: replaces the old fetchProfile + trigger-only pattern.
 * The DB trigger is unreliable for existing users who signed up before it was
 * installed. This function self-heals: if the row is missing it creates it via
 * INSERT … ON CONFLICT DO NOTHING, then always fetches the full row.
 *
 * This guarantees `resumes.user_id` has a valid FK target before any save.
 */
export async function fetchProfile(userId: string, email?: string): Promise<{
  data: ProfileRow | null;
  error: string | null;
}> {
  // Step 1 — Ensure the row exists.
  // INSERT … ON CONFLICT (id) DO NOTHING — safe on every login, never clobbers
  // existing premium/credits.  We use upsert with ignoreDuplicates so a missing
  // row is created with sane defaults while existing rows are left untouched.
  if (email) {
    const { error: upsertErr } = await supabase
      .from('profiles')
      .upsert(
        { id: userId, email, subscription_status: 'incomplete' },
        { onConflict: 'id', ignoreDuplicates: true },
      );

    if (upsertErr) {
      console.warn('⚠️ [DB] fetchProfile upsert failed (non-fatal):', upsertErr.message);
      // Non-fatal — the select below may still succeed if the row already exists.
    }
  }

  // Step 2 — Try full column set (requires Phase 12.1 Stripe migration).
  // Fall back to core columns if the Stripe columns don't exist yet on this env.
  let { data, error } = await supabase
    .from('profiles')
    .select(PROFILE_SELECT)
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    // PGRST204 / column-not-found: Stripe migration not yet applied — retry with core cols.
    console.warn('⚠️ [DB] fetchProfile full-select failed, retrying with core columns:', error.message);
    ({ data, error } = await supabase
      .from('profiles')
      .select(PROFILE_SELECT_CORE)
      .eq('id', userId)
      .maybeSingle());
  }

  if (error) {
    return { data: null, error: error.message };
  }
  return { data: data as ProfileRow | null, error: null };
}

/**
 * Patch mutable profile fields. Called by:
 *   - Settings page when user changes locale or hardcore_mode
 *   - After accepting a diff (decrements credits server-side, then re-fetches)
 */
export async function upsertProfile(
  userId: string,
  patch: Partial<Pick<ProfileRow, 'locale' | 'hardcore_mode' | 'credits_rewrites' | 'credits_interviews'>>
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('profiles')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', userId);

  return { error: error?.message ?? null };
}

// ── Resume record (Phase 11.4 schema) ────────────────────────────────────────

/**
 * Matches the `public.resumes` table created in Phase 11.4.
 *   id         — uuid PK
 *   user_id    — FK to auth.users
 *   title      — display name (e.g. "Pavlo Tsyhanash's Resume")
 *   content    — full document state JSON (sections, name, contactInfo, JD)
 *   ats_score  — integer 0-100
 *   created_at / updated_at — auto-managed by DB trigger
 */
export interface ResumeRecord {
  id:         string;
  user_id:    string;
  title:      string;
  content:    Record<string, unknown>;
  ats_score:  number;
  created_at: string;
  updated_at: string;
}

/**
 * Upsert a resume. Returns the row ID on success, null on any failure.
 * Uses maybeSingle() to avoid 406 errors when Supabase returns 0 rows,
 * and wraps everything in try/catch so the promise never hangs silently.
 */
export async function saveResume(
  userId:   string,
  resumeId: string | null,
  title:    string,
  content:  Record<string, unknown>,
  atsScore: number,
): Promise<string | null> {
  try {
    // Sanitise: strip any non-serialisable values that could silently corrupt the payload
    const cleanContent = JSON.parse(JSON.stringify(content));

    const row: Record<string, unknown> = {
      user_id:    userId,
      title:      title || 'Untitled Resume',
      content:    cleanContent,
      ats_score:  atsScore || 0,
      updated_at: new Date().toISOString(),
    };
    if (resumeId) row.id = resumeId;

    const { data, error } = await supabase
      .from('resumes')
      .upsert(row, { onConflict: 'id' })
      .select('id')
      .maybeSingle();

    if (error) {
      console.error('❌ [DB] SUPABASE ERROR:', error.message, error.code, error.details);
      return null;
    }

    if (!data) {
      console.error('❌ [DB] NO DATA RETURNED — upsert succeeded but select returned nothing');
      return null;
    }

    return data.id as string;
  } catch (err) {
    console.error('❌ [DB] CRITICAL CRASH in saveResume:', err);
    return null;
  }
}

/**
 * Fetch all resumes for a user, newest first.
 * `content` is intentionally excluded — only metadata for the dashboard grid.
 *
 * Wrapped in Promise.race with a 4-second hard timeout so a hung Supabase
 * connection can never stall the Dashboard indefinitely.  Always resolves to
 * an array — never throws — so callers need no try/catch.
 */
export async function getUserResumes(
  userId: string,
): Promise<Omit<ResumeRecord, 'content'>[]> {
  const fetchPromise = supabase
    .from('resumes')
    .select('id, title, ats_score, updated_at, user_id')
    .eq('user_id', userId.trim())
    .order('updated_at', { ascending: false });

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('DB_TIMEOUT')), 4_000),
  );

  try {
    const { data, error } = await Promise.race([fetchPromise, timeoutPromise]) as Awaited<typeof fetchPromise>;
    if (error) {
      console.error('❌ [DB] getUserResumes error:', error.message, error.code);
      return [];
    }
    return (data ?? []) as Omit<ResumeRecord, 'content'>[];
  } catch (err) {
    const isTimeout = err instanceof Error && err.message === 'DB_TIMEOUT';
    console.error(
      isTimeout
        ? '❌ [DB] getUserResumes: 4 s hard timeout — Supabase query never resolved'
        : '❌ [DB] getUserResumes: unexpected error:',
      err,
    );
    return [];
  }
}

/**
 * Fetch a single resume by id — used by WorkspacePage on mount when
 * navigated to /workspace/:id. Includes full `content` JSON.
 */
export async function getResumeById(id: string): Promise<{
  data: ResumeRecord | null;
  error: string | null;
}> {
  // maybeSingle() returns { data: null, error: null } for a missing row instead
  // of PGRST116 — the caller already handles data === null gracefully.
  const { data, error } = await supabase
    .from('resumes')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    console.error('[db] getResumeById error:', error.message, error.code);
    return { data: null, error: error.message };
  }
  return { data: data as ResumeRecord | null, error: null };
}

// ── Resume (document) helpers ─────────────────────────────────────────────────

/**
 * INSERT a new resume row after the soft-gate login.
 * Called by useDocumentStore.persistResume() with the pending CV/JD from landing.
 */
export async function insertResume(payload: {
  user_id:           string;
  cv_filename:       string | null;
  job_description:   string;
  current_ats_score: number | null;
  ats_gaps:          string[];
  /** Optional structured data to store alongside the resume row (e.g. parsed raw text). */
  content_json?:     Record<string, unknown>;
}): Promise<{ data: ResumeRow | null; error: string | null }> {
  // maybeSingle() instead of single() — prevents PGRST116 if RLS silently
  // blocks the INSERT (e.g. missing profiles FK row on first login).
  const { data, error } = await supabase
    .from('resumes')
    .insert({
      user_id:           payload.user_id,
      cv_filename:       payload.cv_filename,
      job_description:   payload.job_description,
      content_json:      payload.content_json ?? {},
      current_ats_score: payload.current_ats_score,
      ats_gaps:          payload.ats_gaps,
    })
    .select()
    .maybeSingle();

  if (error) return { data: null, error: error.message };
  if (!data)  return { data: null, error: 'Insert succeeded but returned no row — RLS may have blocked it' };
  return { data: data as ResumeRow, error: null };
}

/**
 * Fetch the user's most recently updated resume row.
 * Used by DashboardPage to populate the Context Bar on mount.
 */
export async function fetchLatestResume(userId: string): Promise<{
  data: ResumeRow | null;
  error: string | null;
}> {
  const { data, error } = await supabase
    .from('resumes')
    .select('*')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return { data: null, error: error.message };
  return { data: data as ResumeRow | null, error: null };
}

/**
 * Delete a single resume by id.
 * RLS enforces ownership — only the owning user can delete their row.
 * Uses .select() to verify the row was actually deleted (not silently 0 rows).
 */
export async function deleteResume(resumeId: string): Promise<{ error: string | null }> {
  const { error, count } = await supabase
    .from('resumes')
    .delete({ count: 'exact' })
    .eq('id', resumeId);

  if (error) {
    console.error('❌ [DB] deleteResume FAILED:', error.message, error.code, error.details);
    return { error: error.message };
  }

  if (count === 0) {
    console.error('❌ [DB] deleteResume: query succeeded but 0 rows deleted — RLS may have blocked it. id:', resumeId);
    return { error: 'Delete was blocked — you may not own this resume or it no longer exists.' };
  }

  console.log(`✅ [DB] deleteResume: deleted ${count} row(s) for id ${resumeId}`);
  return { error: null };
}

/**
 * Delete all resumes for a user — used by the "Delete All Data" danger zone.
 * RLS also enforces this, but we're explicit about the user_id filter.
 */
export async function deleteAllUserData(userId: string): Promise<{ error: string | null }> {
  const { error, count } = await supabase
    .from('resumes')
    .delete({ count: 'exact' })
    .eq('user_id', userId);

  if (error) {
    console.error('❌ [DB] deleteAllUserData FAILED:', error.message, error.code, error.details);
    return { error: error.message };
  }

  console.log(`✅ [DB] deleteAllUserData: deleted ${count} row(s) for user ${userId}`);
  return { error: null };
}

/**
 * Patch resume content after diff accept.
 * Called by useDocumentStore.applyDiff() once PATCH /api/resume/accept-diff succeeds.
 */
export async function updateResumeScore(
  resumeId: string,
  patch: Partial<Pick<ResumeRow, 'current_ats_score' | 'content_json' | 'ats_gaps'>>
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('resumes')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', resumeId);

  return { error: error?.message ?? null };
}
