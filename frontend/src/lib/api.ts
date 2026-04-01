/**
 * lib/api.ts — Typed FastAPI client
 * ─────────────────────────────────────────────────────────────────────────────
 * Single source of truth for all HTTP calls to the backend.
 *
 * Design decisions:
 *   1. Base URL is VITE_API_BASE_URL (defaults to localhost:8000 in dev).
 *   2. Every request attaches the Supabase JWT as Authorization: Bearer so the
 *      backend can identify the caller via its get_authenticated_user_id dep.
 *   3. Functions never throw network-level errors to callers — they raise
 *      ApiError which callers can inspect for status code + detail.
 *   4. AbortController integration: pass signal to cancel in-flight requests
 *      (used by WorkspacePage to cancel if the user clicks a different bullet).
 *
 * Usage:
 *   import { improveBullet } from '@/lib/api';
 *   const result = await improveBullet({ section: 'Experience', old_text: '…' });
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { supabase } from '@/lib/supabase';

// ── Config ─────────────────────────────────────────────────────────────────────

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)
  ?? 'http://localhost:8000';

// ── Error type ─────────────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: string,
    public readonly path: string,
  ) {
    super(`API ${status} — ${path}: ${detail}`);
    this.name = 'ApiError';
  }

  /** True for 5xx server errors (backend down / Gemini unavailable) */
  get isServerError() { return this.status >= 500; }

  /** True for 4xx client errors (bad request, auth) */
  get isClientError() { return this.status >= 400 && this.status < 500; }

  /** True for network-level failures (offline, timeout, CORS) */
  get isNetworkError() { return this.status === 0; }
}

// ── Core fetch helper ──────────────────────────────────────────────────────────

async function getAuthToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

async function apiPost<TReq, TRes>(
  path: string,
  body: TReq,
  opts?: { signal?: AbortSignal },
): Promise<TRes> {
  const token = await getAuthToken();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: opts?.signal,
    });
  } catch (err: unknown) {
    // Network-level failure (offline, CORS block, timeout from AbortController)
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err; // re-throw AbortError so callers can detect cancellation
    }
    throw new ApiError(0, (err as Error).message ?? 'Network request failed', path);
  }

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const json = await response.json() as { detail?: string };
      detail = json.detail ?? detail;
    } catch {
      // ignore parse error — use the default detail string above
    }
    throw new ApiError(response.status, detail, path);
  }

  return response.json() as Promise<TRes>;
}

// ── Endpoint: /api/rewrite-section ────────────────────────────────────────────

/**
 * Request payload for POST /api/rewrite-section.
 * Mirrors backend's RewriteRequest Pydantic model.
 */
export interface ImproveBulletRequest {
  /** Human-readable section label sent as context (e.g. "Experience bullet") */
  section:          string;
  /** The exact bullet text to rewrite — AI preserves all factual claims */
  old_text:         string;
  /** Full job description for ATS keyword alignment (up to 2000 chars used) */
  job_description?: string;
  /** Other bullets from the resume — prevents the AI duplicating existing content */
  resume_context?:  string;
}

/**
 * Response from POST /api/rewrite-section.
 * Mirrors backend's RewriteResponse Pydantic model.
 */
export interface ImproveBulletResponse {
  section:                  string;
  old_text:                 string;
  new_text:                 string;
  predicted_score_increase: number;  // integer 3–8
}

/**
 * Ask the AI to rewrite a single resume bullet point.
 *
 * @param req         Bullet + context payload
 * @param opts.signal AbortSignal for request cancellation
 * @returns           Structured diff (old_text + new_text + score delta)
 * @throws            ApiError on non-2xx · DOMException(AbortError) on cancel
 */
export async function improveBullet(
  req: ImproveBulletRequest,
  opts?: { signal?: AbortSignal },
): Promise<ImproveBulletResponse> {
  return apiPost<ImproveBulletRequest, ImproveBulletResponse>(
    '/api/rewrite-section',
    req,
    opts,
  );
}

// ── Endpoint: /api/upload-resume ─────────────────────────────────────────────

export interface UploadResumeResponse {
  text:       string;
  filename:   string;
  char_count: number;
}

/**
 * Upload a resume file (PDF, DOCX, TXT) and get back extracted plain text.
 * Used by useDocumentStore.persistResume() to hydrate the workspace with real
 * resume content instead of falling back to hardcoded mock sections.
 *
 * @param file   The File object selected by the user in CvDropZone
 * @param signal Optional AbortSignal for cancellation
 */
export async function uploadResume(
  file: File,
  opts?: { signal?: AbortSignal },
): Promise<UploadResumeResponse> {
  const token = await getAuthToken();

  const formData = new FormData();
  formData.append('file', file);

  const headers: Record<string, string> = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}/api/upload-resume`, {
      method: 'POST',
      headers,  // NOTE: do NOT set Content-Type — browser sets multipart boundary automatically
      body: formData,
      signal: opts?.signal,
    });
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, (err as Error).message ?? 'Network request failed', '/api/upload-resume');
  }

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const json = await response.json() as { detail?: string };
      detail = json.detail ?? detail;
    } catch { /* ignore */ }
    throw new ApiError(response.status, detail, '/api/upload-resume');
  }

  return response.json() as Promise<UploadResumeResponse>;
}

// ── Endpoint: /api/ats-score ──────────────────────────────────────────────────

export interface AtsScoreRequest {
  resume_text:     string;
  job_description: string;
}

export interface MissingSkill {
  skill:             string;
  impact_percentage: number;
}

export interface AtsScoreResponse {
  score:          number;
  skill_gaps:     string[];
  matched_skills: string[];
  missing_skills: MissingSkill[];
}

export async function getAtsScore(
  req: AtsScoreRequest,
  opts?: { signal?: AbortSignal },
): Promise<AtsScoreResponse> {
  return apiPost<AtsScoreRequest, AtsScoreResponse>('/api/ats-score', req, opts);
}
