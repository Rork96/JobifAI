/**
 * useDocumentStore — Store 5 of 5
 * ─────────────────────────────────────────────────────────────────────────────
 * Handbook §4.2 — owns: live resume document, diff proposals, ATS score,
 * landing page pending state.
 *
 * FSD target location: features/document-editor/model/useDocumentStore.ts
 * Lives in store/ during Phase 1; will move during FSD refactor.
 *
 * Survival rule (PRD §1.2 + §3):
 *   This store SURVIVES route changes. Navigating from /workspace back to
 *   /dashboard never resets CV/JD context. Only "Change Documents" (explicit
 *   user intent + confirmation) or clearDocument() should reset it.
 *
 * Sandwich diff rules (PRD §4.5):
 *   - Maximum ONE active pendingDiff at a time. If a second rewrite is
 *     requested while one is pending, the UI shows a confirmation prompt.
 *   - applyDiff() calls PATCH /api/resume/accept-diff then clears pendingDiff.
 *   - rejectDiff() clears pendingDiff only — no API call, no counter consumed.
 *
 * Landing page pending state (PRD §2.4):
 *   pendingCvFile and pendingJdText are set on / and consumed by /dashboard
 *   on mount. Dashboard clears them after uploadAndScore() succeeds.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { create } from 'zustand';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Sandwich diff proposal. Populated by POST /api/rewrite-section response.
 * PRD §4.5 — "pendingDiff" state machine.
 */
export interface PendingDiff {
  /** Dot-path to the resume field being edited. e.g. "experience[1].bullets[2]" */
  fieldPath: string;
  originalText: string;
  proposedText: string;
  /** Predicted ATS score increase (3–8). Source: RewriteResponse.predicted_score_increase */
  scoreImpact: number;
}

/**
 * Structured resume data shape.
 * TODO: replace with the typed ResumeData entity from entities/resume/ in Phase 2.
 */
export type ResumeData = Record<string, unknown>;

/**
 * ATS analysis result shape.
 * TODO: replace with the typed ATSAnalysisResponse from entities/analysis/ in Phase 2.
 */
export type AnalysisResult = Record<string, unknown>;

interface DocumentState {
  // ── Landing page pending state (PRD §2.4) ─────────────────────────────────
  /** Raw File from <input type="file"> on /. Cleared after dashboard hydration. */
  pendingCvFile: File | null;
  /** Raw JD paste from textarea on /. Cleared after dashboard hydration. */
  pendingJdText: string;

  // ── ATS score state (set by POST /api/ats-score) ───────────────────────────
  /** The score as displayed to the user (may include preview bumps). */
  currentAtsScore: number | null;
  /** The last server-confirmed score. Source of truth for score delta display. */
  realAtsScore: number | null;
  /** Top 3 gap strings from the landing-page ATS call (PRD §2.4). */
  atsGaps: string[];

  // ── Live document state ────────────────────────────────────────────────────
  resumeData: ResumeData | null;

  /**
   * Active sandwich diff proposal. null = idle state.
   * Maximum one active at a time (PRD §4.5).
   */
  pendingDiff: PendingDiff | null;

  // ── Analysis state (skill gaps, matched/missing keywords) ─────────────────
  skillGaps: string[];
  matchedSkills: string[];
  missingSkills: string[];
  analysisResult: AnalysisResult | null;
  isAnalyzing: boolean;
  analysisError: string | null;

  // ── Actions ────────────────────────────────────────────────────────────────
  setPendingCvFile: (file: File | null) => void;
  setPendingJdText: (text: string) => void;

  updateResumeData: (data: ResumeData) => void;

  setPendingDiff: (diff: PendingDiff | null) => void;

  /**
   * Accept the current pendingDiff.
   * Fires PATCH /api/resume/accept-diff, then clears pendingDiff.
   * Implementation delegates to features/document-editor/api/rewriteApi.ts.
   */
  applyDiff: () => void;

  /**
   * Reject the current pendingDiff.
   * Clears pendingDiff only — no API call, no counter consumed (PRD §4.5).
   */
  rejectDiff: () => void;

  /**
   * Optimistically bump the displayed ATS score by delta.
   * e.g. bumpAtsScore(+6) after an accepted diff.
   * realAtsScore is only updated on the next server-confirmed score.
   */
  bumpAtsScore: (delta: number) => void;

  setAnalysisResult: (
    result: AnalysisResult,
    opts?: { skillGaps?: string[]; matchedSkills?: string[]; missingSkills?: string[] }
  ) => void;

  setIsAnalyzing: (value: boolean) => void;
  setAnalysisError: (error: string | null) => void;

  /**
   * Full document reset. Called by "Change Documents" (user confirmation required)
   * or on explicit sign-out. Never called on route change.
   */
  clearDocument: () => void;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useDocumentStore = create<DocumentState>((set, get) => ({
  // ── Initial state ──────────────────────────────────────────────────────────
  pendingCvFile: null,
  pendingJdText: '',
  currentAtsScore: null,
  realAtsScore: null,
  atsGaps: [],
  resumeData: null,
  pendingDiff: null,
  skillGaps: [],
  matchedSkills: [],
  missingSkills: [],
  analysisResult: null,
  isAnalyzing: false,
  analysisError: null,

  // ── Actions ────────────────────────────────────────────────────────────────
  setPendingCvFile: (file) => set({ pendingCvFile: file }),

  setPendingJdText: (text) => set({ pendingJdText: text }),

  updateResumeData: (data) => set({ resumeData: data }),

  setPendingDiff: (diff) => set({ pendingDiff: diff }),

  applyDiff: () => {
    const { pendingDiff, resumeData } = get();
    if (!pendingDiff || !resumeData) return;
    // TODO: call PATCH /api/resume/accept-diff via features/document-editor/api/
    // For now: clear pendingDiff (API call is the feature layer's responsibility)
    set({ pendingDiff: null });
  },

  rejectDiff: () => set({ pendingDiff: null }),

  bumpAtsScore: (delta) =>
    set((s) => ({
      currentAtsScore: s.currentAtsScore !== null ? s.currentAtsScore + delta : delta,
    })),

  setAnalysisResult: (result, opts = {}) =>
    set({
      analysisResult: result,
      ...(opts.skillGaps    !== undefined && { skillGaps:    opts.skillGaps    }),
      ...(opts.matchedSkills !== undefined && { matchedSkills: opts.matchedSkills }),
      ...(opts.missingSkills !== undefined && { missingSkills: opts.missingSkills }),
    }),

  setIsAnalyzing: (value) => set({ isAnalyzing: value }),

  setAnalysisError: (error) => set({ analysisError: error }),

  clearDocument: () =>
    set({
      pendingCvFile: null,
      pendingJdText: '',
      currentAtsScore: null,
      realAtsScore: null,
      atsGaps: [],
      resumeData: null,
      pendingDiff: null,
      skillGaps: [],
      matchedSkills: [],
      missingSkills: [],
      analysisResult: null,
      isAnalyzing: false,
      analysisError: null,
    }),
}));
