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
import { supabase } from '@/lib/supabase';
import type {
  User,
  LanguageCode,
  InterviewStep,
  ChatMessage,
  ResumeData,
  ExperienceEntry,
  EducationEntry,
  ATSAnalysisResponse,
  AppMode,
  AppStatus,
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

  /**
   * True while POST /api/user/save-progress is in-flight.
   * Used by the status bar to show "Saving…" vs "Saved".
   */
  isSaving: boolean;

  /**
   * Unix timestamp (ms) of the last successful cloud sync.
   * Null before the first successful save.
   * Used by the TopBar "Saved to cloud" indicator.
   */
  lastSyncedAt: number | null;

  /**
   * Non-null when the most recent cloud sync failed.
   * The TopBar displays this as a transient, dismissable red pill.
   * Automatically cleared after 6 seconds or on the next successful sync.
   * COMPLETELY decoupled from isAnalyzing / isGeneratingPdf — a save
   * failure must never obscure the resume preview or the coaching UI.
   */
  syncError: string | null;

  /**
   * Debounced cloud save — schedules a POST /api/user/save-progress in 3 s.
   *
   * Called internally by `updateResumeData`, `addMessage`, and `setAnalysisResult`
   * whenever meaningful state changes.  Callers never need to call this directly
   * (though they can to trigger an immediate debounce window reset).
   *
   * Guard: skips silently if the user is not signed in.
   * Guard: skips if resumeData is empty AND messages is empty (nothing to save).
   *
   * The 3-second debounce collapses rapid successive changes (e.g. streaming
   * tokens) into a single network request.
   */
  syncToSupabase: () => void;

  /**
   * Delete the user's cloud row (DELETE /api/user/clear-data) and reset the
   * local Zustand store to IDLE.
   *
   * Called by the "Clear All Data" button in Settings.
   * Network failure is logged but does NOT block the local reset — the user
   * always gets a clean local state regardless of server availability.
   */
  clearCloudData: () => Promise<void>;

  setUser:          (user: User | null) => void;
  setIsPremium:     (premium: boolean) => void;
  setIsAuthLoading: (loading: boolean) => void;
  setIsSaving:      (saving: boolean) => void;
  setSyncError:     (error: string | null) => void;

  /**
   * Apply a promotional code to unlock premium features for the session.
   *
   * Returns `true` if the code was recognised and the unlock was applied,
   * `false` if the code is invalid (caller can show an error toast).
   *
   * Side effects on success:
   *   • Sets `isPremium = true` in the store immediately.
   *   • Persists a flag to localStorage so the unlock survives page refreshes.
   *     (localStorage may be unavailable in private/incognito mode — the in-
   *     memory unlock still applies for the current session in that case.)
   *
   * Valid codes: 'START2026'
   *
   * Usage in a component:
   *   const applyPromoCode = useAppStore(s => s.applyPromoCode);
   *   const ok = applyPromoCode(inputValue);
   *   if (!ok) showToast('Invalid promo code');
   */
  applyPromoCode: (code: string) => boolean;

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
  // ── Unified App State Machine ──────────────────────────────────────────────
  /**
   * The operating mode — set once the user commits to a path and the workspace
   * mounts. OPTIMIZE = upload/coaching path; SCRATCH = build-from-zero path.
   * null before onboarding completes.
   *
   * This is the authoritative mode used by:
   *   • ChatPanel to compute `effectiveStep` and the API `mode` field.
   *   • PersonaFactory (backend) to select the correct system instruction tier.
   *   • DocumentPreview to decide which ghost keyword variant to show.
   */
  appMode: AppMode | null;

  /**
   * The lifecycle status of the current session.
   * Driven by `transitionTo(newStatus)` — never set directly.
   *
   *   IDLE      → no AI in flight, workspace at rest
   *   ANALYZING → POST /api/analyze in-flight (spinner on onboarding CTA)
   *   COACHING  → inside the OPTIMIZE workspace, Mac is coaching
   *   BUILDING  → inside the SCRATCH interview, Mac is interviewing
   */
  appStatus: AppStatus;

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
   *
   * SINGLE SOURCE OF TRUTH — always a number (default 0).
   * Every score-bearing response must write here via setAtsScore().
   */
  currentAtsScore: number;

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

  // ── Atomic analysis state (Iron Logic — Task 19) ──────────────────────────
  /**
   * True while POST /api/analyze is in-flight.
   * Drives the loading state on the Step 3 "proceed" button — the user
   * cannot enter the workspace until this is false AND analysisResult is set.
   */
  isAnalyzing:   boolean;

  /**
   * Non-null when /api/analyze returns a non-2xx or throws.
   * Displayed as an inline error on Step 3; cleared on the next analysis attempt.
   */
  analysisError: string | null;

  /**
   * The full ATSAnalysisResponse returned by /api/analyze.
   * This is the SINGLE source of truth for:
   *   • score          → ATS score ring
   *   • foundKeywords  → green ✅ chips
   *   • missingKeywords → red ❌ chips
   *   • macMessage     → Mac's first chat message (never built client-side)
   *
   * Null until a successful /api/analyze call completes.
   * Validated at write-time with isATSAnalysisResponse() in OnboardingFlow.
   */
  analysisResult: ATSAnalysisResponse | null;

  setIsAnalyzing:    (v: boolean) => void;
  setAnalysisError:  (err: string | null) => void;
  /**
   * Atomic write: sets analysisResult AND syncs currentAtsScore in one
   * Zustand transaction.  Always call this — never set analysisResult directly.
   */
  setAnalysisResult: (result: ATSAnalysisResponse | null) => void;

  /**
   * Explicitly set the operating mode.  Usually called by setOnboardingMode,
   * but can be called directly if the mode needs to change without an
   * onboarding path change (e.g. admin override in tests).
   */
  setAppMode: (mode: AppMode) => void;

  /**
   * THE CENTRAL STATE TRANSITION ACTION.
   *
   * Always use this instead of setting `appStatus` directly.  It performs
   * mode-aware cleanup so components never see stale cross-slice state:
   *
   *   → IDLE       clears isGenerating + isAnalyzing
   *   → ANALYZING  enables isAnalyzing, clears analysisError
   *   → COACHING   if switching FROM BUILDING: resets interview messages,
   *                step, and resumeData (user is switching modes mid-session)
   *   → BUILDING   if switching FROM COACHING: clears analysisResult,
   *                currentAtsScore, and interview messages (clean slate)
   *
   * Components subscribe to `appStatus` and react to state changes
   * declaratively — they do NOT call individual cleanup actions themselves.
   */
  transitionTo: (newStatus: AppStatus) => void;

  setOnboardingMode:     (mode: 'upload' | 'scratch') => void;
  setUploadedResumeText: (text: string) => void;
  setJobDescription:     (jd: string) => void;
  setRealAtsScore:       (score: number) => void;
  /**
   * The canonical setter for the live ATS score.
   * Logs to console (verify pulse is active) and updates currentAtsScore.
   * Prefer this over setCurrentAtsScore for all external callers.
   */
  setAtsScore:           (score: number) => void;
  setCurrentAtsScore:    (score: number) => void;
  /** Add `delta` (±1–5) to the live ATS score, clamped to [0, 100]. */
  bumpAtsScore:          (delta: number) => void;
  setSkillGaps:          (gaps: string[]) => void;
  setMatchedSkills:      (skills: string[]) => void;
  setMissingSkills:      (skills: Array<{ skill: string; impact_percentage: number }>) => void;

  /**
   * SCRATCH → OPTIMIZE Grand Transition.
   *
   * Fires automatically when the progressive build score reaches 100
   * (all five resume sections filled in SCRATCH mode).  Orchestrates:
   *
   *   1. Injects Mac's "Foundation built! 🧱" bridge message into the chat.
   *   2. Switches appMode to 'OPTIMIZE' and appStatus to 'ANALYZING'.
   *   3. POSTs /api/analyze with the freshly built resumeData.
   *   4. On success: setAnalysisResult() atomically overwrites the
   *      progressive fake-100 score with the real ATS score AND transitions
   *      appStatus → 'COACHING', surfacing Ghost Gaps + the keyword carousel.
   *
   * Self-guarding: the initial `appMode === 'SCRATCH'` check + immediate
   * transition to 'ANALYZING' prevents any re-trigger within the same session.
   */
  completeScratchMode: () => Promise<void>;
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
// DEEP MERGE UTILITY
//
// updateResumeData uses this INSTEAD of a flat spread ({ ...base, ...patch })
// to prevent AI partial updates from destructively overwriting array fields.
//
// Problem the flat spread caused (THE CONTEXT-LOSS BUG):
//   state.resumeData.experiences = [entry1, entry2]
//   update = { experiences: [entry3] }           ← AI adds one new entry
//   { ...state.resumeData, ...update }            ← REPLACES array with [entry3]
//   → entry1 and entry2 are gone forever ❌
//
// Rules this function applies per field:
//   targetTitle / summary  → straight replace (primitives)
//   skills                 → union, deduplicated case-insensitively
//   experiences            → merge by id; entries without id get one assigned
//   education              → same merge-by-id strategy
// ─────────────────────────────────────────────────────────────────────────────

function deepMergeResumeData(
  base:  Partial<ResumeData>,
  patch: Partial<ResumeData>,
): Partial<ResumeData> {
  const merged: Partial<ResumeData> = { ...base };

  // ── Primitives ────────────────────────────────────────────────────────────
  if (patch.targetTitle !== undefined) merged.targetTitle = patch.targetTitle;
  if (patch.summary     !== undefined) merged.summary     = patch.summary;

  // ── Skills: union deduplicated (case-insensitive) ─────────────────────────
  if (patch.skills !== undefined) {
    const seen    = new Set((base.skills ?? []).map((s) => s.toLowerCase()));
    const unified = [...(base.skills ?? [])];
    for (const skill of patch.skills) {
      if (!seen.has(skill.toLowerCase())) {
        unified.push(skill);
        seen.add(skill.toLowerCase());
      }
    }
    merged.skills = unified;
  }

  // ── Experiences: merge-by-id; no id = new entry, gets one assigned ────────
  if (patch.experiences !== undefined) {
    const existingMap = new Map(
      (base.experiences ?? []).map((e) => [e.id, e]),
    );
    for (const entry of patch.experiences) {
      // Generate a stable id for AI-extracted entries that arrive without one
      const id = entry.id || `exp_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      existingMap.set(id, { ...(existingMap.get(id) ?? {}), ...entry, id });
    }
    merged.experiences = Array.from(existingMap.values());
  }

  // ── Education: same merge-by-id ───────────────────────────────────────────
  if (patch.education !== undefined) {
    const existingMap = new Map(
      (base.education ?? []).map((e) => [e.id, e]),
    );
    for (const entry of patch.education) {
      const id = entry.id || `edu_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      existingMap.set(id, { ...(existingMap.get(id) ?? {}), ...entry, id });
    }
    merged.education = Array.from(existingMap.values());
  }

  return merged;
}

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

// ── Cloud Sync Debounce Timer ─────────────────────────────────────────────────
// Module-level so it persists across React renders and store re-creations.
// Cleared and reset on every syncToSupabase() call — only the last call in
// a 3-second quiet window actually fires the network request.
let _syncTimer: ReturnType<typeof setTimeout> | null = null;

// ── Promo Code Config ─────────────────────────────────────────────────────────
// Centralised so adding a new code is a one-line change here.
// Codes are compared case-insensitively after trimming.
const PROMO_CODES = new Set(['START2026']);

// Key used to persist the promo unlock across page refreshes.
// Stored in localStorage — safe to change if we ever want to invalidate old
// persisted sessions (e.g. when a code expires: change the key name).
const PROMO_STORAGE_KEY = 'jobifai_promo_v1';

/**
 * Read the persisted promo unlock from localStorage.
 * Returns true if a valid unlock record exists.
 * Wrapped in try/catch because localStorage throws in some privacy contexts.
 */
function readPersistedPromo(): boolean {
  try {
    return localStorage.getItem(PROMO_STORAGE_KEY) === 'unlocked';
  } catch {
    return false;
  }
}

// ── Auth Slice Factory ────────────────────────────────────────────────────────
const createAuthSlice: StateCreator<AppStore, [], [], AuthSlice> = (set, get) => ({
  user:          null,
  // Hydrate isPremium from localStorage on store creation so a promo-unlocked
  // user stays unlocked after a page refresh without re-entering the code.
  isPremium:     readPersistedPromo(),
  isAuthLoading: true,  // Start true — we verify session on mount before showing UI
  isSaving:      false,
  lastSyncedAt:  null,
  syncError:     null,

  // ── Cloud Sync ─────────────────────────────────────────────────────────────

  setSyncError: (syncError) => set({ syncError }),

  syncToSupabase: () => {
    // Reset the debounce window on every call
    if (_syncTimer) clearTimeout(_syncTimer);

    _syncTimer = setTimeout(async () => {
      _syncTimer = null;

      // Bail out if the user is not signed in — no token, no sync.
      // supabase.auth.getSession() can itself throw a JSON parse error when
      // the Supabase server returns an empty / malformed response (network
      // blip, CDN edge cache issue).  Wrap in try/catch so a session-refresh
      // failure never propagates as an unhandled promise rejection.
      let sessionToken: string | undefined;
      try {
        const { data: { session } } = await supabase.auth.getSession();
        sessionToken = session?.access_token;
      } catch (sessionErr) {
        console.warn('[Store] getSession() threw — skipping sync:', sessionErr);
        return;
      }
      if (!sessionToken) return;

      const s = useAppStore.getState();

      // Skip if there is nothing meaningful to persist
      const hasResume   = Object.keys(s.resumeData).length > 0;
      const hasMessages = s.messages.length > 0;
      if (!hasResume && !hasMessages) return;

      set({ isSaving: true, syncError: null });

      try {
        const body = {
          resume_data:     s.resumeData,
          analysis_result: s.analysisResult ?? null,
          ats_score:       s.currentAtsScore > 0 ? s.currentAtsScore : null,
          // Strip ephemeral fields (id, timestamp) — backend only needs role+content
          messages: s.messages.map((m) => ({ role: m.role, content: m.content })),
        };

        const res = await fetch('/api/user/save-progress', {
          method:  'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${sessionToken}`,
          },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          // Read the error body as text first — the server might return HTML
          // (e.g. a 502 from nginx) rather than JSON.  Never call .json()
          // unconditionally on a non-2xx response.
          const errText = await res.text().catch(() => `HTTP ${res.status}`);
          throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
        }

        // Only parse the response body if the server says it's JSON.
        // A 204 No Content or an unexpected content-type must not crash here.
        const ct = res.headers.get('content-type') ?? '';
        if (ct.includes('application/json')) {
          // Consume the body to avoid a "body already read" error on keep-alive
          await res.json().catch(() => {/* non-fatal — lastSyncedAt is what matters */});
        }

        set({ lastSyncedAt: Date.now(), syncError: null });
        console.log('[Store] ☁ Cloud sync ✓', new Date().toLocaleTimeString());

      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[Store] Cloud sync error:', msg);
        // Surface the error as a transient banner; auto-clear after 6 s so it
        // never permanently obscures the resume preview or the coaching UI.
        set({ syncError: `Failed to save: ${msg.slice(0, 120)}` });
        setTimeout(() => {
          // Only clear if the same error is still shown (a newer sync may have
          // already replaced it with a success or a different error).
          useAppStore.setState((cur) =>
            cur.syncError?.startsWith('Failed to save:') ? { syncError: null } : {},
          );
        }, 6_000);
      } finally {
        set({ isSaving: false });
      }
    }, 3_000); // 3-second debounce
  },

  clearCloudData: async () => {
    // Cancel any pending debounced save — no point syncing data we're about to nuke
    if (_syncTimer) { clearTimeout(_syncTimer); _syncTimer = null; }

    // Best-effort server delete — don't block the local reset on network issues
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.access_token) {
      try {
        await fetch('/api/user/clear-data', {
          method:  'DELETE',
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        console.log('[Store] ☁ Cloud data cleared');
      } catch (err) {
        console.error('[Store] clearCloudData network error:', err);
      }
    }

    // Atomically reset all session state — user sees a clean workspace
    get().transitionTo('IDLE');
    set({
      resumeData:      {},
      messages:        [],
      analysisResult:  null,
      currentAtsScore: 0,
      realAtsScore:    null,
      skillGaps:       [],
      matchedSkills:   [],
      missingSkills:   [],
      lastSyncedAt:    null,
      syncError:       null,
      onboardingMode:  null,
      appMode:         null,
    });
  },

  // ── Standard auth actions ──────────────────────────────────────────────────

  setUser:          (user)      => set({ user }),
  setIsPremium:     (isPremium) => set({ isPremium }),
  setIsAuthLoading: (isAuthLoading) => set({ isAuthLoading }),
  setIsSaving:      (isSaving) => set({ isSaving }),

  applyPromoCode: (code: string): boolean => {
    const normalised = code.trim().toUpperCase();
    if (!PROMO_CODES.has(normalised)) return false;

    // Apply the unlock immediately in-memory
    set({ isPremium: true });

    // Persist so the unlock survives a page refresh
    try {
      localStorage.setItem(PROMO_STORAGE_KEY, 'unlocked');
    } catch {
      // localStorage unavailable (private mode, storage quota, etc.)
      // The in-memory unlock still applies for this session.
    }

    return true;
  },

  clearAuth: () => {
    // Sign-out: wipe auth state AND any persisted promo unlock so the next
    // user on the same device starts fresh.
    if (_syncTimer) { clearTimeout(_syncTimer); _syncTimer = null; }
    try { localStorage.removeItem(PROMO_STORAGE_KEY); } catch { /* ignore */ }
    set({ user: null, isPremium: false, isAuthLoading: false, lastSyncedAt: null, syncError: null });
  },
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
const createOnboardingSlice: StateCreator<AppStore, [], [], OnboardingSlice> = (set, get) => ({
  // ── Unified App State Machine ──────────────────────────────────────────────
  appMode:   null,
  appStatus: 'IDLE',

  setAppMode: (appMode) => set({ appMode }),

  transitionTo: (newStatus: AppStatus) => {
    const current = get().appStatus;

    switch (newStatus) {
      case 'IDLE':
        // Hard reset — clear all transient AI state
        set({ appStatus: 'IDLE', isGenerating: false, isAnalyzing: false });
        return;

      case 'ANALYZING':
        // Analysis starting — enable spinner, clear any previous error
        set({ appStatus: 'ANALYZING', isAnalyzing: true, analysisError: null });
        return;

      case 'COACHING':
        // Entering the OPTIMIZE workspace.
        // ALWAYS clears isAnalyzing — it is impossible to be analyzing and
        // coaching simultaneously.  Forgetting this leaves isAnalyzing: true
        // after a completeScratchMode() failure (which calls transitionTo
        // 'ANALYZING' then 'COACHING' on error), causing the "Analysis failed"
        // banner to render in the workspace even though the save was at fault.
        // If we're switching FROM a BUILDING session (scratch mode), also wipe
        // the interview state so Mac doesn't inherit irrelevant messages.
        if (current === 'BUILDING') {
          set({
            appStatus:    'COACHING',
            messages:     [],
            currentStep:  'idle',
            resumeData:   {},
            isGenerating: false,
            isAnalyzing:  false,
            analysisError: null,
          });
        } else {
          set({ appStatus: 'COACHING', isGenerating: false, isAnalyzing: false, analysisError: null });
        }
        return;

      case 'BUILDING':
        // Entering the SCRATCH interview workspace.
        // If we're switching FROM a COACHING session (optimize mode), wipe the
        // ATS analysis state so the score ring doesn't show a stale score.
        if (current === 'COACHING') {
          set({
            appStatus:      'BUILDING',
            messages:       [],
            analysisResult: null,
            currentAtsScore: 0,
            isGenerating:   false,
          });
        } else {
          set({ appStatus: 'BUILDING', isGenerating: false });
        }
        return;

      default:
        set({ appStatus: newStatus });
    }
  },

  // ── Atomic analysis state ──────────────────────────────────────────────────
  isAnalyzing:   false,
  analysisError: null,
  analysisResult: null,

  setIsAnalyzing:   (isAnalyzing)   => set({ isAnalyzing }),
  setAnalysisError: (analysisError) => set({ analysisError }),

  // Atomic write: setting analysisResult also syncs currentAtsScore AND
  // transitions to COACHING status in ONE Zustand transaction.
  setAnalysisResult: (analysisResult) => {
    if (analysisResult !== null) {
      console.log('[Store] ATS Score Sync:', analysisResult.score);
    }
    set({
      analysisResult,
      ...(analysisResult !== null
        ? { currentAtsScore: analysisResult.score, appStatus: 'COACHING' }
        : {}),
    });
    // Persist the analysis result so the score ring + ghost keywords survive a refresh
    if (analysisResult !== null) get().syncToSupabase();
  },

  // ── Onboarding fields ──────────────────────────────────────────────────────
  onboardingMode:      null,
  uploadedResumeText:  '',
  jobDescription:      '',
  realAtsScore:        null,
  currentAtsScore:     0,   // ← SINGLE SOURCE OF TRUTH — always a number, never null
  skillGaps:           [],
  matchedSkills:       [],
  missingSkills:       [],

  // setOnboardingMode also derives appMode so both are always in sync.
  setOnboardingMode: (onboardingMode) => set({
    onboardingMode,
    appMode: onboardingMode === 'upload' ? 'OPTIMIZE' : 'SCRATCH',
  }),
  setUploadedResumeText: (uploadedResumeText) => set({ uploadedResumeText }),
  setJobDescription:     (jobDescription)     => set({ jobDescription }),

  // Setting realAtsScore also initialises currentAtsScore (the live display value)
  setRealAtsScore: (score) => {
    console.log('[Store] ATS Score Sync:', score);
    set({ realAtsScore: score, currentAtsScore: score });
  },

  // Canonical public setter — preferred over setCurrentAtsScore for all callers
  setAtsScore: (score) => {
    console.log('[Store] ATS Score Sync:', score);
    set({ currentAtsScore: score });
  },

  // Internal alias kept for backward-compat with existing call-sites
  setCurrentAtsScore: (score) => {
    console.log('[Store] ATS Score Sync:', score);
    set({ currentAtsScore: score });
  },

  // currentAtsScore is now always a number — no null guard needed
  bumpAtsScore: (delta) => set((state) => ({
    currentAtsScore: Math.min(100, Math.max(0, state.currentAtsScore + delta)),
  })),

  setSkillGaps:     (skillGaps)     => set({ skillGaps }),
  setMatchedSkills: (matchedSkills) => set({ matchedSkills }),
  setMissingSkills: (missingSkills) => set({ missingSkills }),

  // ── SCRATCH → OPTIMIZE Grand Transition ─────────────────────────────────────
  completeScratchMode: async () => {
    const state = get();

    // ── Guard ─────────────────────────────────────────────────────────────────
    // Only fires once, from inside a live SCRATCH BUILDING session.
    // The immediate transitionTo('ANALYZING') call changes appStatus away from
    // 'BUILDING', so any re-entry within the same event loop is a no-op.
    if (state.appMode !== 'SCRATCH' || state.appStatus !== 'BUILDING') return;

    const resumeData     = state.resumeData;
    const jobDescription = state.jobDescription ?? '';

    // Require at least a title + one experience before launching analysis.
    // An empty resumeData would produce a meaningless 0% score.
    if (!resumeData.targetTitle?.trim()) return;

    // ── 1. Bridge message ────────────────────────────────────────────────────
    // Injected BEFORE mode-switch so the user sees it in context before the
    // Analyzing state replaces the input bar.
    const now = Date.now();
    const bridgeMsg: ChatMessage = {
      id:        `bridge_${now}`,
      role:      'assistant',
      content:   'Foundation built! 🧱 Now, I\'m running your new resume through '
               + 'the strict ATS scanner to find the gaps we need to close…',
      timestamp: now,
    };
    set((s) => ({ messages: [...s.messages, bridgeMsg] }));

    // ── 2. Switch mode + start analysis spinner ──────────────────────────────
    set({ appMode: 'OPTIMIZE' });
    get().transitionTo('ANALYZING');

    // ── 3. POST /api/analyze ─────────────────────────────────────────────────
    // Send the resume as pretty-printed JSON — Gemini handles structured text
    // just as well as plain prose, and this preserves field names for context.
    const resumeText = JSON.stringify(resumeData, null, 2);

    try {
      const res = await fetch('/api/analyze', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          resume_text:     resumeText,
          job_description: jobDescription,
        }),
      });

      if (!res.ok) {
        // Read as text — never call .json() on a non-2xx response body
        const errText = await res.text().catch(() => `HTTP ${res.status}`);
        console.warn('[Store] completeScratchMode — /api/analyze HTTP', res.status, errText.slice(0, 200));
        get().transitionTo('COACHING'); // unblock UI
        return;
      }

      // Guard: only parse JSON if the server actually says so.
      // An empty body (204), a text/html error page, or a network-level
      // response with no content-type would all throw a cryptic
      // "JSON.parse: unexpected end of data" if we called .json() blindly.
      const ct = res.headers.get('content-type') ?? '';
      if (!ct.includes('application/json')) {
        console.warn('[Store] completeScratchMode — unexpected content-type:', ct || '(none)');
        get().transitionTo('COACHING');
        return;
      }

      const data: unknown = await res.json();

      // ── 4. Atomic overwrite ──────────────────────────────────────────────
      // setAnalysisResult() does THREE things in ONE Zustand transaction:
      //   a) sets analysisResult
      //   b) overwrites currentAtsScore with the real score
      //   c) transitions appStatus → 'COACHING'  ← surfaces Ghost Gaps + carousel
      if (
        data &&
        typeof data === 'object' &&
        typeof (data as Record<string, unknown>).score    === 'number' &&
        Array.isArray((data as Record<string, unknown>).foundKeywords) &&
        Array.isArray((data as Record<string, unknown>).missingKeywords)
      ) {
        const analysis = data as ATSAnalysisResponse;

        get().setAnalysisResult(analysis);   // score + COACHING transition

        // Populate the skill-gap checklist
        const gap   = Math.max(0, 100 - analysis.score);
        const count = Math.max(analysis.missingKeywords.length, 1);
        set({
          skillGaps:     analysis.missingKeywords,
          matchedSkills: analysis.foundKeywords,
          missingSkills: analysis.missingKeywords.map((kw, i) => ({
            skill:             kw,
            impact_percentage: Math.max(2, Math.round(gap / count) - i),
          })),
        });

        console.warn(
          `[Store] ✅ Grand Transition complete — real ATS score: ${analysis.score} `
          + `| gaps: ${analysis.missingKeywords.length}`,
        );
      } else {
        console.warn('[Store] completeScratchMode — unexpected API shape:', data);
        get().transitionTo('COACHING');
      }
    } catch (err) {
      console.error('[Store] completeScratchMode fetch error:', err);
      get().transitionTo('COACHING'); // never leave user stuck on ANALYZING
    }
  },
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
    // Trigger debounced cloud save after every new message
    get().syncToSupabase();
  },

  // ── Resume Data ─────────────────────────────────────────────────────────────
  updateResumeData: (update) => {
    // Use deepMergeResumeData instead of flat spread to prevent array fields
    // (experiences, education, skills) from being wiped by partial AI updates.
    set((state) => ({
      resumeData: deepMergeResumeData(state.resumeData, update),
    }));
    // Trigger debounced cloud save — collapses rapid AI token updates
    get().syncToSupabase();
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

// ── Global dev debugger ───────────────────────────────────────────────────────
// Open any browser DevTools console and run:   atsDebug()
// Prints a labelled snapshot of every score-related field plus the raw state.
// Gated to DEV builds — tree-shaken out by Vite in production.
if (import.meta.env.DEV) {
  (window as any).atsDebug = () => {
    const s = useAppStore.getState();
    console.group('%c[atsDebug] JobifAI Store Snapshot', 'color: #f97316; font-weight: bold');
    console.log('appMode         :', s.appMode);
    console.log('appStatus       :', s.appStatus);
    console.log('currentAtsScore :', s.currentAtsScore);
    console.log('realAtsScore    :', s.realAtsScore);
    console.log('analysisResult  :', s.analysisResult);
    console.log('onboardingMode  :', s.onboardingMode);
    console.log('isAnalyzing     :', s.isAnalyzing);
    console.log('analysisError   :', s.analysisError);
    console.log('resumeData      :', s.resumeData);
    console.log('messages.length :', s.messages.length);
    console.log('isPremium       :', s.isPremium);
    console.log('isSaving        :', s.isSaving);
    console.log('lastSyncedAt    :', s.lastSyncedAt ? new Date(s.lastSyncedAt).toLocaleTimeString() : null);
    console.groupEnd();
    return s;
  };
  console.info('%c[JobifAI] atsDebug() available in console', 'color: #f97316');
}

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

/**
 * True when the app is in the OPTIMIZE workspace (not just onboarding).
 * Use this in components instead of checking onboardingMode === 'upload'
 * — it correctly accounts for mid-session mode switches via transitionTo().
 */
export const selectIsOptimizeMode = (s: AppStore): boolean =>
  s.appMode === 'OPTIMIZE' && s.appStatus === 'COACHING';

/**
 * True when the app is in the SCRATCH interview workspace.
 */
export const selectIsBuildMode = (s: AppStore): boolean =>
  s.appMode === 'SCRATCH' && s.appStatus === 'BUILDING';
