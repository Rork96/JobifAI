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
  id:                  string;
  email:               string;
  is_premium:          boolean;
  locale:              string;
  credits_rewrites:    number;
  credits_interviews:  number;
  hardcore_mode:       boolean;
  stripe_customer_id:  string | null;
  created_at:          string;
  updated_at:          string;
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

/**
 * Fetch the profile row for the currently authenticated user.
 * Returns null if no row exists yet (new user whose trigger hasn't fired).
 */
export async function fetchProfile(userId: string): Promise<{
  data: ProfileRow | null;
  error: string | null;
}> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, email, is_premium, locale, credits_rewrites, credits_interviews, hardcore_mode, stripe_customer_id, created_at, updated_at')
    .eq('id', userId)
    .single();

  if (error && error.code !== 'PGRST116') { // PGRST116 = "no rows"
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
    .single();

  if (error) return { data: null, error: error.message };
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
