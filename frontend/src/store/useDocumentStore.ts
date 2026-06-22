/**
 * useDocumentStore — Store 5 of 5
 * ─────────────────────────────────────────────────────────────────────────────
 * Handbook §4.2 — owns: live resume document, diff proposals, ATS score,
 * landing page pending state.
 *
 * Survival rule (PRD §1.2 + §3):
 *   This store SURVIVES route changes. Navigating from /workspace back to
 *   /dashboard never resets CV/JD context. Only "Change Documents" (explicit
 *   user intent + confirmation) or clearDocument() should reset it.
 *
 * Persistence flow (Phase 7):
 *   1. LandingPage sets pendingCvFile + pendingJdText + pendingAtsScore + pendingAtsGaps
 *      when user clicks a soft-gate CTA (before AuthModal opens).
 *   2. DashboardPage calls persistResume() on mount when pending state is present.
 *   3. persistResume() INSERTs to resumes table, sets activeResumeId, clears pending.
 *   4. Subsequent dashboard mounts call loadLatestResume() (no pending state → DB read).
 *
 * Sandwich diff rules (PRD §4.5):
 *   - Maximum ONE active pendingDiff at a time.
 *   - improveBullet() → POST /api/rewrite-section → sets pendingDiff.
 *   - applyDiff() clears pendingDiff (WorkspacePage updates local bullet text).
 *   - rejectDiff() clears pendingDiff only — no API call, no counter consumed.
 *
 * Phase 8 additions:
 *   - improvingBulletId: tracks which bullet is waiting for the AI response.
 *   - activeJobDescription: the full JD text for passing to the rewrite API.
 *   - improveBullet(): async thunk that calls POST /api/rewrite-section.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { create } from 'zustand';
import { insertResume, fetchLatestResume } from '@/lib/db';
import { improveBullet as apiBulletImprove, uploadResume as apiUploadResume, getAtsScore as apiGetAtsScore, ApiError } from '@/lib/api';
import { useToastStore } from '@/store/useToastStore';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PendingDiff {
  /** Dot-path to the resume field being edited. e.g. "experience[1].bullets[2]" */
  fieldPath:    string;
  originalText: string;
  proposedText: string;
  /** Predicted ATS score increase (3–8). Source: RewriteResponse.predicted_score_increase */
  scoreImpact:  number;
}

export type ResumeData    = Record<string, unknown>;
export type AnalysisResult = Record<string, unknown>;

interface DocumentState {
  // ── Landing page pending state (PRD §2.4) ─────────────────────────────────
  pendingCvFile:    File | null;
  pendingJdText:    string;
  /** ATS score from the landing page mock/real scan — persisted with the resume row */
  pendingAtsScore:  number | null;
  /** Gap strings from the landing page scan */
  pendingAtsGaps:   string[];

  // ── Active resume (set after persistResume or loadLatestResume) ───────────
  /** Supabase resumes.id of the currently active document. Null until first persist. */
  activeResumeId:       string | null;
  /** Filename shown in DashboardPage ContextBar */
  activeCvFilename:     string | null;
  /** JD snippet for ContextBar display (first 60 chars of job_description) */
  activeJdSnippet:      string | null;
  /** Full job description — passed to rewrite API for keyword alignment */
  activeJobDescription: string | null;
  /** Whether the dashboard is fetching resume data from DB */
  isLoadingResume:      boolean;

  // ── ATS score state ────────────────────────────────────────────────────────
  currentAtsScore: number | null;
  realAtsScore:    number | null;
  atsGaps:         string[];

  // ── Live document state ────────────────────────────────────────────────────
  resumeData:     ResumeData | null;
  /** Plain text extracted from the uploaded resume file via /api/upload-resume.
   *  Stored in DB as content_json.raw_text so it survives F5 refresh.
   *  WorkspacePage derives its section list from this string. */
  resumeRawText:  string | null;
  pendingDiff:    PendingDiff | null;

  // ── AI improvement state (Phase 8) ────────────────────────────────────────
  /**
   * Phase 2 — Target Acquisition.
   * ID of the bullet the user has selected as the active AI target.
   * Null = no target acquired → ChatInput is disabled.
   * Set by clicking an EditableBullet; cleared by clicking outside or accepting a diff.
   */
  activeBulletId: string | null;
  setActiveBulletId: (id: string | null) => void;

  /** ID of the bullet currently being AI-rewritten. Null when idle. */
  improvingBulletId: string | null;
  /**
   * True for 3 seconds after a rewrite API call fails (non-abort).
   * Drives the MacMascot into 'warning' state so the user knows something
   * went wrong without a modal interrupting their flow.
   * Automatically reset to false at the start of the next improveBullet call.
   */
  lastRewriteFailed: boolean;

  // ── Analysis state ─────────────────────────────────────────────────────────
  skillGaps:      string[];
  matchedSkills:  string[];
  missingSkills:  string[];
  analysisResult: AnalysisResult | null;
  isAnalyzing:    boolean;
  analysisError:  string | null;

  // ── Actions ────────────────────────────────────────────────────────────────
  setPendingCvFile:   (file: File | null) => void;
  setPendingJdText:   (text: string) => void;
  setPendingAtsScore: (score: number | null) => void;
  setPendingAtsGaps:  (gaps: string[]) => void;

  /**
   * INSERT a new resume row from the soft-gate pending state.
   * Called by DashboardPage on mount when pendingCvFile is non-null.
   * Clears all pending state on success.
   */
  persistResume: (userId: string) => Promise<void>;

  /**
   * SELECT the user's most recent resume row from Supabase.
   * Called by DashboardPage on mount when pendingCvFile is null (returning visit).
   * Also called by WorkspacePage on mount after a page refresh to re-hydrate the store.
   */
  loadLatestResume: (userId: string) => Promise<void>;

  /**
   * Upload a CV file directly (used by the Dashboard "Fix My Resume" button).
   *
   * Flow:
   *   1. POST /api/upload-resume → parsed plain text
   *   2. INSERT resumes row with content_json: { raw_text }
   *   3. Sets activeResumeId + resumeRawText in store
   *
   * Returns true on success, false on any error (error toast shown internally).
   * The caller navigates to /workspace on true.
   */
  uploadResumeFile: (file: File, userId: string) => Promise<boolean>;

  updateResumeData: (data: ResumeData) => void;

  setPendingDiff: (diff: PendingDiff | null) => void;
  applyDiff:      () => void;
  rejectDiff:     () => void;

  /**
   * POST /api/rewrite-section — ask the AI to improve a specific resume bullet.
   *
   * Flow:
   *   1. Sets improvingBulletId → bullet shows loading skeleton.
   *   2. Clears any existing pendingDiff (one diff at a time).
   *   3. Calls POST /api/rewrite-section with bullet text + JD context.
   *   4a. Success → sets pendingDiff with the AI suggestion.
   *   4b. Error   → shows error toast, leaves bullet as-is.
   *   5. Clears improvingBulletId.
   *
   * @param bulletId      ID of the targeted bullet (used as fieldPath in the diff)
   * @param bulletText    Current text of the bullet to rewrite
   * @param resumeContext Condensed text of other bullets (for dedup prevention)
   * @param signal        Optional AbortSignal for request cancellation
   */
  improveBullet: (
    bulletId:      string,
    bulletText:    string,
    resumeContext: string,
    signal?:       AbortSignal,
  ) => Promise<void>;

  /**
   * Phase 4 — expose improvingBulletId as a direct setter so the page can
   * drive the SandwichDiffInline loading skeleton from the mock (and later real)
   * rewrite flow without going through the full improveBullet() thunk.
   */
  setImprovingBulletId: (id: string | null) => void;

  /**
   * Remediation Step 1 — call POST /api/ats-score with the real resume text
   * and job description. Populates currentAtsScore, missingSkills, matchedSkills,
   * atsGaps from the backend's semantic embedding analysis.
   * No-op (silent) if either arg is blank. Never throws — silent-fail on error.
   */
  runAtsAnalysis: (resumeText: string, jobDescription: string) => Promise<void>;

  bumpAtsScore: (delta: number) => void;

  setAnalysisResult: (
    result: AnalysisResult,
    opts?: { skillGaps?: string[]; matchedSkills?: string[]; missingSkills?: string[] }
  ) => void;
  setIsAnalyzing:   (value: boolean) => void;
  setAnalysisError: (error: string | null) => void;

  clearDocument: () => void;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useDocumentStore = create<DocumentState>((set, get) => ({
  // ── Initial state ──────────────────────────────────────────────────────────
  pendingCvFile:        null,
  pendingJdText:        '',
  pendingAtsScore:      null,
  pendingAtsGaps:       [],
  activeResumeId:       null,
  activeCvFilename:     null,
  activeJdSnippet:      null,
  activeJobDescription: null,
  isLoadingResume:      false,
  currentAtsScore:      null,
  realAtsScore:         null,
  atsGaps:              [],
  resumeData:           null,
  resumeRawText:        null,
  pendingDiff:          null,
  activeBulletId:       null,
  improvingBulletId:    null,
  lastRewriteFailed:    false,
  skillGaps:            [],
  matchedSkills:        [],
  missingSkills:        [],
  analysisResult:       null,
  isAnalyzing:          false,
  analysisError:        null,

  // ── Actions ────────────────────────────────────────────────────────────────
  setPendingCvFile:   (file)  => set({ pendingCvFile: file }),
  setPendingJdText:   (text)  => set({ pendingJdText: text }),
  setPendingAtsScore: (score) => set({ pendingAtsScore: score }),
  setPendingAtsGaps:  (gaps)  => set({ pendingAtsGaps: gaps }),

  persistResume: async (userId) => {
    const { pendingCvFile, pendingJdText, pendingAtsScore, pendingAtsGaps } = get();
    if (!pendingJdText.trim()) return; // nothing to persist

    set({ isLoadingResume: true });

    // ── Step 1: parse the CV file to plain text ─────────────────────────────
    // Upload the file to /api/upload-resume BEFORE the DB insert so we can
    // store the parsed raw text in content_json for workspace hydration.
    let parsedResumeText: string | null = null;
    if (pendingCvFile) {
      try {
        const uploadResult = await apiUploadResume(pendingCvFile);
        parsedResumeText = uploadResult.text;
        console.info(
          `[useDocumentStore] Resume parsed — ${uploadResult.char_count} chars from ${uploadResult.filename}`,
        );
      } catch (uploadErr) {
        // Non-fatal: workspace falls back to INITIAL_SECTIONS if parsing fails.
        // The resume row is still created with the JD and metadata.
        console.warn('[useDocumentStore] /api/upload-resume failed (non-fatal):', uploadErr);
      }
    }

    // ── Step 2: persist the resume row to Supabase ───────────────────────────
    const { data, error } = await insertResume({
      user_id:           userId,
      cv_filename:       pendingCvFile?.name ?? null,
      job_description:   pendingJdText,
      current_ats_score: pendingAtsScore,
      ats_gaps:          pendingAtsGaps,
      // Store parsed text in content_json so it survives F5 refresh
      content_json:      parsedResumeText ? { raw_text: parsedResumeText } : undefined,
    });

    set({ isLoadingResume: false });

    if (error || !data) {
      console.error('[useDocumentStore] persistResume failed:', error);
      useToastStore.getState().show('Failed to save your documents. Your session is still active.', 'error');
      return;
    }

    set({
      activeResumeId:       data.id,
      activeCvFilename:     data.cv_filename,
      activeJdSnippet:      data.job_description?.slice(0, 60) ?? null,
      activeJobDescription: data.job_description ?? null,
      currentAtsScore:      data.current_ats_score,
      realAtsScore:         data.current_ats_score,
      atsGaps:              data.ats_gaps as string[],
      resumeRawText:        parsedResumeText,
      // Clear pending state — consumed
      pendingCvFile:        null,
      pendingJdText:        '',
      pendingAtsScore:      null,
      pendingAtsGaps:       [],
    });

    // Kick off real ATS analysis now that both resume and JD are available
    if (parsedResumeText && data.job_description) {
      void get().runAtsAnalysis(parsedResumeText, data.job_description);
    }
  },

  loadLatestResume: async (userId) => {
    set({ isLoadingResume: true });

    const { data, error } = await fetchLatestResume(userId);

    set({ isLoadingResume: false });

    if (error) {
      console.error('[useDocumentStore] loadLatestResume failed:', error);
      useToastStore.getState().show('Could not load your saved documents.', 'error');
      return;
    }

    if (!data) return; // first-time user, no resume yet — show empty state

    // Read back the parsed resume text stored during persistResume
    const rawText = typeof data.content_json?.raw_text === 'string'
      ? data.content_json.raw_text as string
      : null;

    set({
      activeResumeId:       data.id,
      activeCvFilename:     data.cv_filename,
      activeJdSnippet:      data.job_description?.slice(0, 60) ?? null,
      activeJobDescription: data.job_description ?? null,
      currentAtsScore:      data.current_ats_score,
      realAtsScore:         data.current_ats_score,
      atsGaps:              data.ats_gaps as string[],
      resumeRawText:        rawText,
    });

    // Re-run ATS analysis on refresh so the score reflects the current resume + JD
    if (rawText && data.job_description) {
      void get().runAtsAnalysis(rawText, data.job_description);
    }
  },

  // ── Direct upload (Dashboard "Fix My Resume" button) ─────────────────────

  uploadResumeFile: async (file, userId) => {
    set({ isLoadingResume: true });

    // Step 1: parse the file via /api/upload-resume
    let parsedText: string;
    try {
      const result = await apiUploadResume(file);
      parsedText = result.text;
    } catch (err: unknown) {
      set({ isLoadingResume: false });
      const msg =
        err instanceof ApiError
          ? `Could not parse CV: ${err.detail}`
          : 'Could not parse your CV. Try a PDF or DOCX file.';
      useToastStore.getState().show(msg, 'error');
      return false;
    }

    // Step 2: insert resume row — carry over any existing JD if present
    const { activeJobDescription, pendingJdText } = get();
    const jd = activeJobDescription ?? pendingJdText ?? '';

    const { data, error } = await insertResume({
      user_id:           userId,
      cv_filename:       file.name,
      job_description:   jd,
      current_ats_score: null,
      ats_gaps:          [],
      content_json:      { raw_text: parsedText },
    });

    set({ isLoadingResume: false });

    if (error || !data) {
      useToastStore.getState().show('Could not save your resume. Please try again.', 'error');
      return false;
    }

    // Step 3: hydrate store with the new resume
    set({
      activeResumeId:       data.id,
      activeCvFilename:     data.cv_filename,
      activeJdSnippet:      data.job_description?.slice(0, 60) ?? null,
      activeJobDescription: data.job_description ?? null,
      currentAtsScore:      null,
      realAtsScore:         null,
      atsGaps:              [],
      resumeRawText:        parsedText,
      // Clear any stale pending state from the landing page flow
      pendingCvFile:        null,
      pendingJdText:        '',
      pendingAtsScore:      null,
      pendingAtsGaps:       [],
    });

    // Step 4: run real ATS analysis — fire and forget, never blocks navigation
    if (jd) {
      void get().runAtsAnalysis(parsedText, jd);
    }

    return true;
  },

  updateResumeData: (data) => set({ resumeData: data }),

  setPendingDiff: (diff) => set({ pendingDiff: diff }),

  applyDiff: () => {
    set({ pendingDiff: null });
    // Caller (WorkspacePage) is responsible for applying the text change to
    // local section state. DB persistence happens in Phase 9 via updateResumeScore.
  },

  rejectDiff: () => set({ pendingDiff: null }),

  // ── Phase 2: target acquisition ───────────────────────────────────────────

  setActiveBulletId: (id) => set({ activeBulletId: id }),

  // ── Phase 4: expose improvingBulletId for mock/real rewrite flow ──────────

  setImprovingBulletId: (id) => set({ improvingBulletId: id }),

  // ── Remediation Step 1: real ATS analysis via backend ─────────────────────

  runAtsAnalysis: async (resumeText, jobDescription) => {
    if (!resumeText?.trim() || !jobDescription?.trim()) return;

    set({ isAnalyzing: true, analysisError: null });
    try {
      const result = await apiGetAtsScore({
        resume_text:     resumeText,
        job_description: jobDescription,
      });
      set({
        currentAtsScore: result.score,
        realAtsScore:    result.score,
        matchedSkills:   result.matched_skills,
        missingSkills:   result.missing_skills.map(m => m.skill),
        atsGaps:         result.skill_gaps,
      });
    } catch (err) {
      // Silent fail — ATS analysis must never block resume editing.
      console.warn('[useDocumentStore] runAtsAnalysis failed (non-fatal):', err);
    } finally {
      set({ isAnalyzing: false });
    }
  },

  // ── Phase 8: AI bullet improvement ────────────────────────────────────────

  improveBullet: async (bulletId, bulletText, resumeContext, signal) => {
    const { activeJobDescription, pendingDiff } = get();

    // If another bullet already has a pending diff, clear it first
    // (PRD §4.5: maximum ONE active pendingDiff at a time)
    if (pendingDiff && pendingDiff.fieldPath !== bulletId) {
      set({ pendingDiff: null });
    }

    // Mark this bullet as loading (shows skeleton in SandwichDiffInline).
    // Also clear any previous error flag so the mascot returns to processing.
    set({ improvingBulletId: bulletId, lastRewriteFailed: false });

    try {
      const response = await apiBulletImprove(
        {
          section:         'Experience bullet',
          old_text:        bulletText,
          job_description: activeJobDescription ?? '',
          resume_context:  resumeContext,
        },
        { signal },
      );

      // Populate the diff with real AI data
      set({
        pendingDiff: {
          fieldPath:    bulletId,
          originalText: bulletText,
          proposedText: response.new_text,
          scoreImpact:  response.predicted_score_increase,
        },
      });
    } catch (err: unknown) {
      // AbortError means the user cancelled (clicked another bullet) — silent
      if (err instanceof DOMException && err.name === 'AbortError') return;

      // Surface meaningful error messages to the user
      if (err instanceof ApiError) {
        const msg = err.isServerError
          ? 'AI rewrite unavailable — the backend returned an error. Please try again.'
          : err.isNetworkError
            ? 'Could not reach the AI backend. Is the server running?'
            : `AI rewrite failed (${err.status}).`;
        useToastStore.getState().show(msg, 'error');
      } else {
        useToastStore.getState().show('AI rewrite failed unexpectedly.', 'error');
      }

      // Drive mascot into 'warning' state for 3 s, then auto-reset to idle
      set({ lastRewriteFailed: true });
      setTimeout(() => set({ lastRewriteFailed: false }), 3000);

      console.error('[useDocumentStore] improveBullet error:', err);
    } finally {
      // Always clear the loading indicator, even on error
      set({ improvingBulletId: null });
    }
  },

  bumpAtsScore: (delta) =>
    set(s => ({
      currentAtsScore: s.currentAtsScore !== null ? s.currentAtsScore + delta : delta,
    })),

  setAnalysisResult: (result, opts = {}) =>
    set({
      analysisResult: result,
      ...(opts.skillGaps     !== undefined && { skillGaps:     opts.skillGaps }),
      ...(opts.matchedSkills !== undefined && { matchedSkills: opts.matchedSkills }),
      ...(opts.missingSkills !== undefined && { missingSkills: opts.missingSkills }),
    }),

  setIsAnalyzing:   (value) => set({ isAnalyzing: value }),
  setAnalysisError: (error) => set({ analysisError: error }),

  clearDocument: () =>
    set({
      pendingCvFile:        null,
      pendingJdText:        '',
      pendingAtsScore:      null,
      pendingAtsGaps:       [],
      activeResumeId:       null,
      activeCvFilename:     null,
      activeJdSnippet:      null,
      activeJobDescription: null,
      currentAtsScore:      null,
      realAtsScore:         null,
      atsGaps:              [],
      resumeData:           null,
      resumeRawText:        null,
      pendingDiff:          null,
      activeBulletId:       null,
      improvingBulletId:    null,
      lastRewriteFailed:    false,
      skillGaps:            [],
      matchedSkills:        [],
      missingSkills:        [],
      analysisResult:       null,
      isAnalyzing:          false,
      analysisError:        null,
    }),
}));
