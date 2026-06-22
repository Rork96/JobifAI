/**
 * lib/api.ts — Typed FastAPI client + frontend mocks
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
import type { ResumeSection } from '@/lib/types';

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

// ── Endpoint: /api/parse-job ──────────────────────────────────────────────────

export interface ParseJobRequest {
  /** URL of the job posting to scrape (mutually exclusive with text) */
  url?:  string;
  /** Raw pasted job description text — bypasses scraping */
  text?: string;
}

export interface ParseJobResponse {
  success:    boolean;
  text:       string;
  title:      string;
  /** "url" | "text" | "error" */
  source:     string;
  /** User-facing message when success=false */
  error_hint: string;
  char_count: number;
}

/**
 * Extract a job description from a URL (scraper) or normalise pasted raw text.
 *
 * Always returns HTTP 200 — check `response.success` before using `response.text`.
 * When `success === false`, show `error_hint` and ask the user to paste manually.
 */
export async function parseJob(
  req: ParseJobRequest,
  opts?: { signal?: AbortSignal },
): Promise<ParseJobResponse> {
  return apiPost<ParseJobRequest, ParseJobResponse>('/api/parse-job', req, opts);
}

// ── Endpoint: /api/coach ──────────────────────────────────────────────────────

export interface ConversationTurn {
  role:    'user' | 'assistant';
  content: string;
}

export interface CoachRequest {
  message:              string;
  job_description?:     string;
  resume_context?:      string;
  focused_bullet?:      string;
  conversation_history?: ConversationTurn[];
}

export interface CoachResponse {
  response: string;
}

/**
 * Send a coaching message to Mac and receive a contextual response.
 * Uses the current resume + JD + focused bullet as context.
 *
 * @param req     Coach message payload
 * @param signal  Optional AbortSignal for cancellation
 */
export async function coachMessage(
  req: CoachRequest,
  opts?: { signal?: AbortSignal },
): Promise<CoachResponse> {
  return apiPost<CoachRequest, CoachResponse>('/api/coach', req, opts);
}

// ── Endpoint: POST /api/v1/rewrite ────────────────────────────────────────────

/**
 * Response from POST /api/v1/rewrite.
 * Mirrors backend's RewriteResponse Pydantic model (backend/schemas.py).
 */
export interface RewriteResponse {
  proposedText: string;  // empty string "" when the gatekeeper rejects the instruction
  coachMessage: string;
}

/**
 * Ask the Surgeon agent to rewrite a single resume bullet.
 *
 * @param originalText   The exact bullet text the user clicked
 * @param jobDescription Full JD string from the store, or null if none pasted
 * @param userMessage    Free-text instruction typed by the user in the chat
 * @param resumeContext  JSON-stringified ResumeSection[] — Mac reads the full
 *                       document to prevent cross-bullet phrasing duplication
 * @throws ApiError      On non-2xx responses
 */
export const generateRewrite = async (
  originalText: string,
  jobDescription: string | null,
  userMessage: string,
  resumeContext: string | null = null,
): Promise<RewriteResponse> => {
  let response: Response;
  try {
    response = await fetch('http://127.0.0.1:8000/api/v1/rewrite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ originalText, jobDescription, userMessage, resumeContext }),
    });
  } catch (err: unknown) {
    throw new ApiError(
      0,
      (err as Error).message ?? 'Network request failed',
      '/api/v1/rewrite',
    );
  }

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const json = await response.json() as { detail?: string };
      detail = json.detail ?? detail;
    } catch { /* ignore */ }
    throw new ApiError(response.status, detail, '/api/v1/rewrite');
  }

  return response.json() as Promise<RewriteResponse>;
};

// ── Endpoint: POST /api/v1/chat ───────────────────────────────────────────────

export interface ChatResponse {
  coachMessage: string;
}

/**
 * Send a free-form message to the Mac mentor agent.
 * Used when NO bullet is selected — the mentor answers general career / resume
 * questions and leverages ATS context when available.
 *
 * @param userMessage    The user's free-text message
 * @param jobDescription Full JD from the store, or null
 * @param atsScore       Current ATS score, or null if not yet evaluated
 * @param missingKeywords Top gap keywords from the evaluation
 * @param resumeContext  JSON-stringified ResumeSection[] — Mac reads the
 *                       full document so advice is never generic
 * @throws ApiError on non-2xx responses
 */
export const generateChatResponse = async (
  userMessage: string,
  jobDescription: string | null,
  atsScore: number | null,
  missingKeywords: string[],
  resumeContext: string | null = null,
): Promise<ChatResponse> => {
  let response: Response;
  try {
    response = await fetch('http://127.0.0.1:8000/api/v1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userMessage, jobDescription, atsScore, missingKeywords, resumeContext }),
    });
  } catch (err: unknown) {
    throw new ApiError(
      0,
      (err as Error).message ?? 'Network request failed',
      '/api/v1/chat',
    );
  }

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const json = await response.json() as { detail?: string };
      detail = json.detail ?? detail;
    } catch { /* ignore */ }
    throw new ApiError(response.status, detail, '/api/v1/chat');
  }

  return response.json() as Promise<ChatResponse>;
};

// ── Endpoint: POST /api/v1/parse (fast path) ─────────────────────────────────

export interface ParseResponse {
  candidateName: string;
  contactInfo:   string[];
  sections:      ResumeSection[];
}

/**
 * Parse raw resume text into structured sections.
 * Fast path — returns sections only, no ATS scoring.
 * Resolves in ~2-4 s so the UI can navigate to Workspace immediately.
 *
 * @param rawText  Plain text extracted from the uploaded resume file
 * @throws ApiError on non-2xx responses
 */
export const parseResume = async (
  rawText: string,
): Promise<ParseResponse> => {
  let response: Response;
  try {
    response = await fetch('http://127.0.0.1:8000/api/v1/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rawText }),
    });
  } catch (err: unknown) {
    throw new ApiError(0, (err as Error).message ?? 'Network request failed', '/api/v1/parse');
  }

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try { const j = await response.json() as { detail?: string }; detail = j.detail ?? detail; }
    catch { /* ignore */ }
    throw new ApiError(response.status, detail, '/api/v1/parse');
  }

  return response.json() as Promise<ParseResponse>;
};


// ── Endpoint: POST /api/v1/evaluate (background path) ────────────────────────

/** Mirrors backend schemas.WeakBullet — single source of truth is the Pydantic model. */
export interface WeakBullet {
  id:         string;   // bullet.id from the parsed resume
  label:      string;   // short 2-3 word human label, e.g. "Acme Corp Role"
  suggestion: string;   // one-sentence coaching prompt, e.g. "Add deployment metrics."
}

export interface EvaluateResponse {
  atsScore:        number;
  missingKeywords: string[];
  weakBullets:     WeakBullet[];
}

/**
 * Score an already-parsed resume against a job description.
 * Background path — faster than before (~2-4 s) because the backend no
 * longer re-runs the parser.  Call after /parse has loaded the workspace.
 *
 * @param parsedResume   Sections object returned by parseResume()
 * @param jobDescription Full JD text for ATS keyword alignment
 * @throws ApiError on non-2xx responses
 */
export const evaluateResume = async (
  parsedResume: { sections: ResumeSection[] },
  jobDescription: string,
): Promise<EvaluateResponse> => {
  let response: Response;
  try {
    response = await fetch('http://127.0.0.1:8000/api/v1/evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parsedResume, jobDescription }),
    });
  } catch (err: unknown) {
    throw new ApiError(0, (err as Error).message ?? 'Network request failed', '/api/v1/evaluate');
  }

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try { const j = await response.json() as { detail?: string }; detail = j.detail ?? detail; }
    catch { /* ignore */ }
    throw new ApiError(response.status, detail, '/api/v1/evaluate');
  }

  return response.json() as Promise<EvaluateResponse>;
};
