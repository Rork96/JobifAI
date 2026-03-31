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
 *   - applyDiff() → PATCH /api/resume/accept-diff then clears pendingDiff.
 *   - rejectDiff() clears pendingDiff only — no API call, no counter consumed.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { create } from 'zustand';
import { insertResume, fetchLatestResume } from '@/lib/db';
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
  activeResumeId:   string | null;
  /** Filename shown in DashboardPage ContextBar */
  activeCvFilename: string | null;
  /** JD snippet for ContextBar display (first 60 chars of job_description) */
  activeJdSnippet:  string | null;
  /** Whether the dashboard is fetching resume data from DB */
  isLoadingResume:  boolean;

  // ── ATS score state ────────────────────────────────────────────────────────
  currentAtsScore: number | null;
  realAtsScore:    number | null;
  atsGaps:         string[];

  // ── Live document state ────────────────────────────────────────────────────
  resumeData:  ResumeData | null;
  pendingDiff: PendingDiff | null;

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
   */
  loadLatestResume: (userId: string) => Promise<void>;

  updateResumeData: (data: ResumeData) => void;

  setPendingDiff: (diff: PendingDiff | null) => void;
  applyDiff:      () => void;
  rejectDiff:     () => void;

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
  pendingCvFile:    null,
  pendingJdText:    '',
  pendingAtsScore:  null,
  pendingAtsGaps:   [],
  activeResumeId:   null,
  activeCvFilename: null,
  activeJdSnippet:  null,
  isLoadingResume:  false,
  currentAtsScore:  null,
  realAtsScore:     null,
  atsGaps:          [],
  resumeData:       null,
  pendingDiff:      null,
  skillGaps:        [],
  matchedSkills:    [],
  missingSkills:    [],
  analysisResult:   null,
  isAnalyzing:      false,
  analysisError:    null,

  // ── Actions ────────────────────────────────────────────────────────────────
  setPendingCvFile:   (file)  => set({ pendingCvFile: file }),
  setPendingJdText:   (text)  => set({ pendingJdText: text }),
  setPendingAtsScore: (score) => set({ pendingAtsScore: score }),
  setPendingAtsGaps:  (gaps)  => set({ pendingAtsGaps: gaps }),

  persistResume: async (userId) => {
    const { pendingCvFile, pendingJdText, pendingAtsScore, pendingAtsGaps } = get();
    if (!pendingJdText.trim()) return; // nothing to persist

    set({ isLoadingResume: true });

    const { data, error } = await insertResume({
      user_id:           userId,
      cv_filename:       pendingCvFile?.name ?? null,
      job_description:   pendingJdText,
      current_ats_score: pendingAtsScore,
      ats_gaps:          pendingAtsGaps,
    });

    set({ isLoadingResume: false });

    if (error || !data) {
      console.error('[useDocumentStore] persistResume failed:', error);
      useToastStore.getState().show('Failed to save your documents. Your session is still active.', 'error');
      return;
    }

    set({
      activeResumeId:   data.id,
      activeCvFilename: data.cv_filename,
      activeJdSnippet:  data.job_description?.slice(0, 60) ?? null,
      currentAtsScore:  data.current_ats_score,
      realAtsScore:     data.current_ats_score,
      atsGaps:          data.ats_gaps as string[],
      // Clear pending state — consumed
      pendingCvFile:    null,
      pendingJdText:    '',
      pendingAtsScore:  null,
      pendingAtsGaps:   [],
    });
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

    set({
      activeResumeId:   data.id,
      activeCvFilename: data.cv_filename,
      activeJdSnippet:  data.job_description?.slice(0, 60) ?? null,
      currentAtsScore:  data.current_ats_score,
      realAtsScore:     data.current_ats_score,
      atsGaps:          data.ats_gaps as string[],
    });
  },

  updateResumeData: (data) => set({ resumeData: data }),

  setPendingDiff: (diff) => set({ pendingDiff: diff }),

  applyDiff: () => {
    const { pendingDiff } = get();
    if (!pendingDiff) return;
    // TODO Phase 8: PATCH /api/resume/accept-diff via features/document-editor/api/
    set({ pendingDiff: null });
  },

  rejectDiff: () => set({ pendingDiff: null }),

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
      pendingCvFile:    null,
      pendingJdText:    '',
      pendingAtsScore:  null,
      pendingAtsGaps:   [],
      activeResumeId:   null,
      activeCvFilename: null,
      activeJdSnippet:  null,
      currentAtsScore:  null,
      realAtsScore:     null,
      atsGaps:          [],
      resumeData:       null,
      pendingDiff:      null,
      skillGaps:        [],
      matchedSkills:    [],
      missingSkills:    [],
      analysisResult:   null,
      isAnalyzing:      false,
      analysisError:    null,
    }),
}));
