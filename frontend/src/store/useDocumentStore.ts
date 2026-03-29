// Handbook §4.2 — Store 5: useDocumentStore
// Owns: live resume document, diff proposals, ATS scores, skill gap analysis,
//       and the landing-page pending state (PRD §2.4).
// Target location (post-migration): features/document-editor/model/useDocumentStore.ts
//
// PRD §1.2: This store SURVIVES route changes — useDocumentStore is never reset
// on navigation. Hub (/dashboard) and Spokes (/workspace) share the same instance.

import { create } from 'zustand'

// Will be replaced with the typed ResumeData entity once entities/resume/ is built.
type ResumeData = Record<string, unknown>

export interface DiffProposal {
  bulletId: string
  before: string
  after: string
  atsPointDelta: number
}

interface DocumentState {
  resumeData: ResumeData | null
  pendingDiff: DiffProposal | null
  currentAtsScore: number | null
  realAtsScore: number | null
  skillGaps: string[]
  matchedSkills: string[]
  missingSkills: string[]
  analysisResult: unknown
  isAnalyzing: boolean
  analysisError: string | null
  // PRD §2.4 — anonymous landing-page pending state
  pendingCvFile: File | null
  pendingJdText: string
  atsGaps: string[]
}

interface DocumentActions {
  updateResumeData: (data: ResumeData) => void
  setPendingDiff: (diff: DiffProposal | null) => void
  /** Commits the pending diff: applies atsPointDelta and clears pendingDiff. */
  applyDiff: () => void
  rejectDiff: () => void
  bumpAtsScore: (delta: number) => void
  setAnalysisResult: (result: unknown) => void
  setIsAnalyzing: (isAnalyzing: boolean) => void
  setPendingCvFile: (file: File | null) => void
  setPendingJdText: (text: string) => void
  setAtsGaps: (gaps: string[]) => void
  clearDocument: () => void
}

export const useDocumentStore = create<DocumentState & DocumentActions>((set, get) => ({
  resumeData: null,
  pendingDiff: null,
  currentAtsScore: null,
  realAtsScore: null,
  skillGaps: [],
  matchedSkills: [],
  missingSkills: [],
  analysisResult: null,
  isAnalyzing: false,
  analysisError: null,
  pendingCvFile: null,
  pendingJdText: '',
  atsGaps: [],

  updateResumeData: (resumeData) => set({ resumeData }),
  setPendingDiff: (pendingDiff) => set({ pendingDiff }),

  applyDiff: () => {
    const { pendingDiff, currentAtsScore } = get()
    if (!pendingDiff) return
    set({
      pendingDiff: null,
      currentAtsScore: (currentAtsScore ?? 0) + pendingDiff.atsPointDelta,
    })
  },

  rejectDiff: () => set({ pendingDiff: null }),

  bumpAtsScore: (delta) =>
    set((s) => ({ currentAtsScore: (s.currentAtsScore ?? 0) + delta })),

  setAnalysisResult: (analysisResult) =>
    set({ analysisResult, isAnalyzing: false, analysisError: null }),

  setIsAnalyzing: (isAnalyzing) => set({ isAnalyzing }),

  setPendingCvFile: (pendingCvFile) => set({ pendingCvFile }),
  setPendingJdText: (pendingJdText) => set({ pendingJdText }),
  setAtsGaps: (atsGaps) => set({ atsGaps }),

  clearDocument: () =>
    set({
      resumeData: null,
      pendingDiff: null,
      currentAtsScore: null,
      realAtsScore: null,
      skillGaps: [],
      matchedSkills: [],
      missingSkills: [],
      analysisResult: null,
      isAnalyzing: false,
      analysisError: null,
      pendingCvFile: null,
      pendingJdText: '',
      atsGaps: [],
    }),
}))
