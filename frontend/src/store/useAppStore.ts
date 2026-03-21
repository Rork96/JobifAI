/**
 * store/useAppStore.ts — Global State (Zustand)
 * ─────────────────────────────────────────────────────────────────────────────
 * ARCHITECTURE: The "Slice" Pattern
 *
 * Instead of one massive object, we split state into three focused "slices":
 *
 *   AuthSlice      → Who the user is and whether they've paid
 *   LangSlice      → USER_LANG / RESUME_LANG (the bilingual core feature)
 *   InterviewSlice → The state machine, chat history, and collected resume data
 *
 * All slices are composed into ONE Zustand store.  Components subscribe to
 * exactly the fields they need:
 *
 *   // Only re-renders when `user` changes — not when messages change
 *   const user = useAppStore(s => s.user);
 *
 * WHY Zustand over React Context / Redux?
 *   • Context re-renders the entire subtree on any state change.
 *     Zustand re-renders ONLY the components that subscribed to the changed field.
 *   • Redux requires actions, reducers, and selectors boilerplate.
 *     Zustand actions are just functions — call them directly, no dispatch.
 *   • Zustand works outside React (useful for calling actions from API handlers
 *     in Task 4 without needing a component reference).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { create, type StateCreator } from 'zustand';
import { devtools } from 'zustand/middleware';
import type {
  User,
  LanguageCode,
  InterviewStep,
  ChatMessage,
  ResumeData,
  ExperienceEntry,
  EducationEntry,
} from '@/types';
import { INTERVIEW_STEP_ORDER } from '@/types';

// ── Diff Proposal ─────────────────────────────────────────────────────────────
/**
 * Represents a pending AI-suggested rewrite for a specific resume section.
 * The user must Accept or Reject — the draft is NOT updated until accepted.
 *
 * fieldPath encoding:
 *   'summary'                                    → resumeData.summary
 *   'targetTitle'                                → resumeData.targetTitle
 *   'experiences.{expId}.responsibilities.{idx}' → specific bullet point
 */
export interface DiffProposal {
  /** Encoded path to the field being rewritten. */
  fieldPath: string;
  /** The current text (shown with red strikethrough in the diff view). */
  oldText: string;
  /** The AI-suggested replacement (shown with green background). */
  newText: string;
  /** Predicted ATS score improvement in percentage points (e.g. 5 → "+5%"). */
  predictedScoreIncrease: number;
  /** The currentAtsScore value at the moment Magic was triggered — for the "X% → Y%" badge. */
  baselineScore: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// SLICE TYPE DEFINITIONS
// Each interface defines the state shape + action signatures for one concern.
// ─────────────────────────────────────────────────────────────────────────────

// ── Auth Slice ────────────────────────────────────────────────────────────────
interface AuthSlice {
  /** The signed-in user, or null if not authenticated. */
  user: User | null;

  /**
   * Whether the user has an active premium plan ($5/24h pass or monthly sub).
   * The paywall in DocumentPreview checks this before allowing PDF export.
   */
  isPremium: boolean;

  /**
   * True while we're checking the Supabase session on app load.
   * Prevents a flash of "sign in" before we know if the user is logged in.
   */
  isAuthLoading: boolean;

  setUser:          (user: User | null) => void;
  setIsPremium:     (premium: boolean) => void;
  setIsAuthLoading: (loading: boolean) => void;

  /** Called on sign-out — wipes all auth state. */
  clearAuth: () => void;
}

// ── Language Slice ────────────────────────────────────────────────────────────
interface LangSlice {
  /**
   * USER_LANG — The BCP-47 code for the language the user speaks.
   *
   * The Mascot (Mac) conducts the entire interview in this language.
   * E.g. a French speaker sets userLang = 'fr' → Mac asks all questions in French.
   *
   * Auto-detected from navigator.language on first load.
   */
  userLang: LanguageCode;

  /**
   * RESUME_LANG — The BCP-47 code for the final generated document.
   *
   * Almost always 'en-CA' (Canadian English) for the target market.
   * The AI translates the user's answers into RESUME_LANG when building the doc.
   *
   * Example: Spanish speaker (userLang = 'es') needs English resume
   *          → Mac asks in Spanish, but the resume is generated in English (en-CA).
   */
  resumeLang: LanguageCode;

  setUserLang:   (lang: LanguageCode) => void;
  setResumeLang: (lang: LanguageCode) => void;
}

// ── Onboarding Slice ──────────────────────────────────────────────────────────
interface OnboardingSlice {
  /**
   * Which path the user chose at Step 2 of the onboarding fork.
   *   'upload'  → user has an existing resume draft + optional JD
   *   'scratch' → user is building from scratch (voice interview)
   *   null      → onboarding not yet completed
   */
  onboardingMode:      'upload' | 'scratch' | null;

  /**
   * The pasted / extracted text of the user's uploaded resume draft.
   * Passed as context to the interview agent when mode === 'upload'.
   */
  uploadedResumeText:  string;

  /**
   * The user's target job description text.
   * Used by the ATS scorer (evaluate-edit) and the interview agent
   * to tailor the resume to the specific role.
   */
  jobDescription:      string;

  /**
   * The real ATS score (0–100) returned by POST /api/ats-score.
   * Null before scoring completes.  The interview agent uses this as
   * the baseline so it can track score improvement during the session.
   */
  realAtsScore: number | null;

  /**
   * The LIVE ATS score displayed in the DocumentPreview header.
   * Initialized from `realAtsScore` on onboarding completion.
   * Bumped by `bumpAtsScore(delta)` each time an edit is approved by the scorer.
   * Drives the animated count-up/down number in the header.
   */
  currentAtsScore: number | null;

  /**
   * Keywords present in the JD but absent from the resume.
   * Surfaced in the Step 3 "shock" UI as a to-do checklist.
   * The interview agent uses this list to prompt the user for the
   * specific skills they need to add.
   */
  skillGaps: string[];

  /** Skills present in BOTH the resume and JD (from /api/ats-score matched_skills). */
  matchedSkills: string[];

  /** Missing skills with real impact percentages (from /api/ats-score missing_skills). */
  missingSkills: Array<{ skill: string; impact_percentage: number }>;

  setOnboardingMode:     (mode: 'upload' | 'scratch') => void;
  setUploadedResumeText: (text: string) => void;
  setJobDescription:     (jd: string) => void;
  setRealAtsScore:       (score: number) => void;
  setCurrentAtsScore:    (score: number) => void;
  /** Add `delta` (±1–5) to the live ATS score, clamped to [0, 100]. */
  bumpAtsScore:          (delta: number) => void;
  setSkillGaps:          (gaps: string[]) => void;
  setMatchedSkills:      (skills: string[]) => void;
  setMissingSkills:      (skills: Array<{ skill: string; impact_percentage: number }>) => void;
}

// ── Interview Slice ───────────────────────────────────────────────────────────
interface InterviewSlice {
  // ── State machine ──────────────────────────────────────────────────────────
  /**
   * The current phase of the "Build From Scratch" interview.
   *
   * Progression:
   *   idle → target_title → summary → experience → skills_education → complete
   *
   * Components use this to:
   *   • Show the right Mac prompt above the input
   *   • Highlight the active step in the progress indicator
   *   • Know when to show the paywall (step === 'complete')
   */
  currentStep: InterviewStep;

  // ── Chat history ───────────────────────────────────────────────────────────
  /**
   * All messages in the conversation (user + Mac).
   * Rendered by ChatPanel in chronological order.
   * In Task 4, each user message triggers a call to the Gemini agent pipeline.
   */
  messages: ChatMessage[];

  // ── Structured resume data ─────────────────────────────────────────────────
  /**
   * The accumulated, structured resume payload.
   *
   * Uses Partial<> because it's built incrementally — targetTitle exists
   * after Step 1, experiences after Step 3, etc.
   *
   * This is what gets POST-ed to /api/v1/resume/generate in Task 4.
   */
  resumeData: Partial<ResumeData>;

  /**
   * True while waiting for the Gemini API to respond.
   * The MacMascot shows a "thinking" animation when this is true.
   */
  isGenerating: boolean;

  // ── State machine actions ──────────────────────────────────────────────────
  /**
   * Move to the next step in the interview sequence.
   * No-op if already at 'complete' (prevents going past the end).
   *
   * Called by the AI pipeline (Task 4) once it decides the current step
   * has enough data.
   */
  advanceStep: () => void;

  /**
   * Jump directly to a specific step.
   * Used by "Edit" buttons that let users revise an earlier section
   * without restarting the whole interview.
   */
  goToStep: (step: InterviewStep) => void;

  // ── Chat actions ───────────────────────────────────────────────────────────
  /**
   * Append a message to the conversation.
   * `id` and `timestamp` are generated internally — callers only provide
   * `role` and `content`.
   */
  addMessage: (msg: Pick<ChatMessage, 'role' | 'content'>) => void;

  // ── Resume data actions ────────────────────────────────────────────────────
  /**
   * Shallow-merge an update into resumeData.
   * Works like React's `setState` in class components:
   *   updateResumeData({ targetTitle: 'Senior Engineer' })
   *   // Only targetTitle changes; other fields are preserved
   */
  updateResumeData: (update: Partial<ResumeData>) => void;

  /** Append one work experience entry. */
  addExperience: (entry: Omit<ExperienceEntry, 'id'>) => void;

  /** Append one education entry. */
  addEducation: (entry: Omit<EducationEntry, 'id'>) => void;

  setIsGenerating: (generating: boolean) => void;

  /**
   * Reset the interview to its initial state.
   * Called when the user wants to start over from scratch.
   */
  resetInterview: () => void;

  // ── Diff / Magic Rewrite ────────────────────────────────────────────────────
  /**
   * The pending AI diff proposal.  Non-null while the diff overlay is shown.
   * The user must Accept or Reject before continuing.
   */
  pendingDiff: DiffProposal | null;

  setPendingDiff: (diff: DiffProposal | null) => void;

  /**
   * Accept the pending diff — apply `newText` to the correct resumeData field
   * and clear `pendingDiff`.
   */
  applyDiff: () => void;
}

// ── Combined store type ───────────────────────────────────────────────────────
/** The full store shape — intersection of all four slices. */
type AppStore = AuthSlice & LangSlice & OnboardingSlice & InterviewSlice;

// Re-export for use in components
export type { AppStore };

// ─────────────────────────────────────────────────────────────────────────────
// SLICE FACTORIES
//
// Each factory receives Zustand's `set` and `get` functions and returns the
// initial state + action implementations for one slice.
//
// `StateCreator<AppStore, [], [], SliceType>` is the recommended Zustand type
// for the slice pattern.  The generic parameters are:
//   AppStore   → the full store type (gives set/get access to ALL slices)
//   []         → no middleware on the store level
//   []         → no middleware on the slice level
//   SliceType  → the shape this factory returns
// ─────────────────────────────────────────────────────────────────────────────

// ── Auth Slice Factory ────────────────────────────────────────────────────────
const createAuthSlice: StateCreator<AppStore, [], [], AuthSlice> = (set) => ({
  user:          null,
  isPremium:     false,
  isAuthLoading: true,  // Start true — we verify session on mount before showing UI

  setUser:          (user)      => set({ user }),
  setIsPremium:     (isPremium) => set({ isPremium }),
  setIsAuthLoading: (isAuthLoading) => set({ isAuthLoading }),

  clearAuth: () => set({ user: null, isPremium: false, isAuthLoading: false }),
});

// ── Language Slice Factory ─────────────────────────────────────────────────────
const createLangSlice: StateCreator<AppStore, [], [], LangSlice> = (set) => {
  /**
   * Auto-detect the user's preferred language from the browser.
   *
   * Strategy:
   *   1. Try an exact match (e.g. navigator.language = "fr-CA" → 'fr-CA')
   *   2. Try the base language (e.g. "fr-BE" → try 'fr')
   *   3. Fall back to 'en'
   *
   * This runs once at store initialisation — before any React render.
   */
  const detectUserLang = (): LanguageCode => {
    const supported: LanguageCode[] = [
      'en', 'en-CA', 'fr', 'fr-CA', 'es', 'zh-CN', 'zh-TW', 'ar', 'pt', 'hi',
    ];
    const browserLang = navigator.language;  // e.g. "fr-CA", "zh-CN", "en-US"

    // Exact match first
    if (supported.includes(browserLang as LanguageCode)) {
      return browserLang as LanguageCode;
    }

    // Base language fallback (e.g. "fr" from "fr-BE")
    const baseLang = browserLang.split('-')[0] as LanguageCode;
    if (supported.includes(baseLang)) return baseLang;

    return 'en';
  };

  return {
    userLang:   detectUserLang(),
    resumeLang: 'en-CA',  // Default: Canadian English (our primary market)

    setUserLang:   (userLang)   => set({ userLang }),
    setResumeLang: (resumeLang) => set({ resumeLang }),
  };
};

// ── Onboarding Slice Factory ───────────────────────────────────────────────────
const createOnboardingSlice: StateCreator<AppStore, [], [], OnboardingSlice> = (set) => ({
  onboardingMode:      null,
  uploadedResumeText:  '',
  jobDescription:      '',
  realAtsScore:        null,
  currentAtsScore:     null,
  skillGaps:           [],
  matchedSkills:       [],
  missingSkills:       [],

  setOnboardingMode:     (onboardingMode)     => set({ onboardingMode }),
  setUploadedResumeText: (uploadedResumeText) => set({ uploadedResumeText }),
  setJobDescription:     (jobDescription)     => set({ jobDescription }),
  // Setting realAtsScore also initialises currentAtsScore (the live display value)
  setRealAtsScore:       (score)              => set({ realAtsScore: score, currentAtsScore: score }),
  setCurrentAtsScore:    (score)              => set({ currentAtsScore: score }),
  bumpAtsScore: (delta) => set((state) => ({
    currentAtsScore: state.currentAtsScore !== null
      ? Math.min(100, Math.max(0, state.currentAtsScore + delta))
      : null,
  })),
  setSkillGaps:          (skillGaps)          => set({ skillGaps }),
  setMatchedSkills:      (matchedSkills)      => set({ matchedSkills }),
  setMissingSkills:      (missingSkills)      => set({ missingSkills }),
});

// ── Interview Slice Factory ────────────────────────────────────────────────────
const createInterviewSlice: StateCreator<AppStore, [], [], InterviewSlice> = (set, get) => ({
  currentStep:  'idle',
  messages:     [],
  resumeData:   {},
  isGenerating: false,

  // ── State Machine ──────────────────────────────────────────────────────────
  advanceStep: () => {
    const { currentStep } = get();
    const idx = INTERVIEW_STEP_ORDER.indexOf(currentStep);

    // Guard: already at the terminal state
    if (idx === -1 || idx >= INTERVIEW_STEP_ORDER.length - 1) return;

    set({ currentStep: INTERVIEW_STEP_ORDER[idx + 1] });
  },

  goToStep: (step) => set({ currentStep: step }),

  // ── Chat ────────────────────────────────────────────────────────────────────
  addMessage: (msg) => {
    /**
     * Generate a simple collision-resistant ID without adding a UUID library.
     * `Date.now()` gives millisecond precision; the random suffix handles the
     * (unlikely) case of two messages sent in the same millisecond.
     */
    const id = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    const newMessage: ChatMessage = {
      ...msg,
      id,
      timestamp: Date.now(),
    };

    // Use the functional update form to avoid stale closures.
    // If two messages arrive in the same render cycle, this ensures both
    // are appended correctly rather than the second overwriting the first.
    set((state) => ({ messages: [...state.messages, newMessage] }));
  },

  // ── Resume Data ─────────────────────────────────────────────────────────────
  updateResumeData: (update) => {
    set((state) => ({
      resumeData: { ...state.resumeData, ...update },
    }));
  },

  addExperience: (entry) => {
    const id = `exp_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const newEntry: ExperienceEntry = { ...entry, id };

    set((state) => ({
      resumeData: {
        ...state.resumeData,
        experiences: [...(state.resumeData.experiences ?? []), newEntry],
      },
    }));
  },

  addEducation: (entry) => {
    const id = `edu_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const newEntry: EducationEntry = { ...entry, id };

    set((state) => ({
      resumeData: {
        ...state.resumeData,
        education: [...(state.resumeData.education ?? []), newEntry],
      },
    }));
  },

  setIsGenerating: (isGenerating) => set({ isGenerating }),

  resetInterview: () => set({
    currentStep:  'idle',
    messages:     [],
    resumeData:   {},
    isGenerating: false,
  }),

  // ── Diff / Magic Rewrite ──────────────────────────────────────────────────
  pendingDiff: null,

  setPendingDiff: (diff) => set({ pendingDiff: diff }),

  applyDiff: () => set((state) => {
    const diff = state.pendingDiff;
    if (!diff) return {};

    const { fieldPath, newText } = diff;
    const parts = fieldPath.split('.');
    const rd = { ...state.resumeData };

    if (parts[0] === 'summary') {
      rd.summary = newText;
    } else if (parts[0] === 'targetTitle') {
      rd.targetTitle = newText;
    } else if (parts[0] === 'experiences' && parts[2] === 'responsibilities') {
      const expId = parts[1];
      const idx   = parseInt(parts[3], 10);
      rd.experiences = rd.experiences?.map((exp) =>
        exp.id === expId
          ? {
              ...exp,
              responsibilities: exp.responsibilities.map((r, i) =>
                i === idx ? newText : r,
              ),
            }
          : exp,
      );
    }

    return { resumeData: rd, pendingDiff: null };
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// COMBINED STORE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The single Zustand store for the entire JobifAI frontend.
 *
 * `devtools` middleware enables the Redux DevTools browser extension —
 * you can inspect state, time-travel debug, and replay actions.
 * It has zero effect in production (the extension isn't injected).
 *
 * The `(...a)` spread passes (set, get, api) to each slice factory.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * USAGE PATTERNS:
 *
 * // 1. Subscribe to a single primitive — cheapest subscription
 * const isPremium = useAppStore(s => s.isPremium);
 *
 * // 2. Subscribe to an action — actions are stable refs, never cause re-renders
 * const advanceStep = useAppStore(s => s.advanceStep);
 *
 * // 3. Subscribe to multiple fields — use `useShallow` to avoid extra renders
 * import { useShallow } from 'zustand/react/shallow';
 * const { currentStep, isGenerating } = useAppStore(
 *   useShallow(s => ({ currentStep: s.currentStep, isGenerating: s.isGenerating }))
 * );
 *
 * // 4. Access state OUTSIDE React (e.g. in an API helper function)
 * const state = useAppStore.getState();
 * state.addMessage({ role: 'assistant', content: '...' });
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const useAppStore = create<AppStore>()(
  devtools(
    (...a) => ({
      ...createAuthSlice(...a),
      ...createLangSlice(...a),
      ...createOnboardingSlice(...a),
      ...createInterviewSlice(...a),
    }),
    {
      name: 'JobifAI Store',  // Label shown in Redux DevTools
      // Anonymize sensitive fields in the DevTools snapshot
      // (don't log user email/id in production)
      enabled: import.meta.env.DEV,
    },
  ),
);

// ─────────────────────────────────────────────────────────────────────────────
// DERIVED SELECTORS
//
// Selectors are functions that derive new values from raw store state.
// They're passed directly to useAppStore(selector) as a subscription.
//
// WHY pre-define selectors?
//   • Documents "what's a useful derived value" in one place
//   • If we rename a field, we fix it here — not in every component
//   • Easy to add memoisation (e.g. with Reselect) later if needed
// ─────────────────────────────────────────────────────────────────────────────

/** True if the user has started the interview (not just landed on the page). */
export const selectIsInterviewActive = (s: AppStore): boolean =>
  s.currentStep !== 'idle';

/** True when the AI has finished collecting data — ready for PDF generation. */
export const selectIsInterviewComplete = (s: AppStore): boolean =>
  s.currentStep === 'complete';

/**
 * The 0-based index of the current step in INTERVIEW_STEP_ORDER.
 * Returns -1 for 'idle'.  Used to power the TopBar progress bar.
 */
export const selectStepIndex = (s: AppStore): number =>
  INTERVIEW_STEP_ORDER.indexOf(s.currentStep);

/** True when a user session is active. */
export const selectIsAuthenticated = (s: AppStore): boolean =>
  s.user !== null;

/** The number of experience entries collected so far. */
export const selectExperienceCount = (s: AppStore): number =>
  s.resumeData.experiences?.length ?? 0;
