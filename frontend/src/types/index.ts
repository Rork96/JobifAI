/**
 * types/index.ts — Shared Domain Types
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY a dedicated types file?
 *   1. Single source of truth — change a type here and TypeScript flags every
 *      component that uses it.
 *   2. Keeps components thin — no type definitions cluttering business logic.
 *   3. Reusable by both the store AND components without circular imports.
 *
 * Convention: interfaces for object shapes, type aliases for unions/literals.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Auth ─────────────────────────────────────────────────────────────────────

/**
 * Minimal user shape for the frontend.
 * Task 3 will extend this with Supabase's full `User` type.
 * Using our own interface keeps the store decoupled from the Supabase SDK —
 * if we ever switch auth providers, only this file needs to change.
 */
export interface User {
  id: string;
  email: string | null;
  avatarUrl?: string;
}

// ── Language ──────────────────────────────────────────────────────────────────

/**
 * BCP-47 language tags the app supports.
 *
 * TWO language concepts exist simultaneously in this app:
 *
 *   USER_LANG   — The language the user speaks and the AI Mascot replies in.
 *                 Detected from the browser (navigator.language) but
 *                 overridable by the user.
 *
 *   RESUME_LANG — The language of the FINAL generated document.
 *                 Almost always 'en-CA' for the Canadian market, but
 *                 bilingual users (e.g. French/English) can choose 'fr-CA'.
 *
 * Why separate?  A user might speak Spanish (USER_LANG = 'es') but need
 * an English resume (RESUME_LANG = 'en-CA') — the AI interviews in Spanish
 * then generates the document in English.
 */
export type LanguageCode =
  | 'en'
  | 'en-CA'
  | 'fr'
  | 'fr-CA'
  | 'es'
  | 'zh-CN'
  | 'zh-TW'
  | 'ar'
  | 'pt'
  | 'hi';

/** Human-readable label for each supported language — used in UI dropdowns. */
export const LANGUAGE_LABELS: Record<LanguageCode, string> = {
  'en':    'English',
  'en-CA': 'English (Canada)',
  'fr':    'Français',
  'fr-CA': 'Français (Canada)',
  'es':    'Español',
  'zh-CN': '中文 (简体)',
  'zh-TW': '中文 (繁體)',
  'ar':    'العربية',
  'pt':    'Português',
  'hi':    'हिन्दी',
};

// ── HR Compliance Constraints ─────────────────────────────────────────────────

/**
 * Canadian HR standards that the AI system prompt MUST enforce.
 * Exporting these as constants means the frontend and backend (Task 4)
 * both reference the same source of truth — no drift.
 *
 * FORBIDDEN_FIELDS: personal info that discriminates and MUST NOT appear
 * in a Canadian resume (protected by the Canadian Human Rights Act).
 */
export const HR_CONSTRAINTS = {
  FORBIDDEN_FIELDS: [
    'photo',
    'date_of_birth',
    'age',
    'gender',
    'marital_status',
    'sin_number',      // Social Insurance Number
    'nationality',
    'religion',
  ] as const,
  FORMAT:      'reverse_chronological' as const,
  VERB_STYLE:  'action_verbs' as const,        // "Led", "Built", "Reduced", not "Responsible for"
  MAX_PAGES:   2 as const,                     // Most Canadian employers expect 1-2 pages
} as const;

// ── Interview State Machine ───────────────────────────────────────────────────

/**
 * The ordered steps of the "Build From Scratch" interview flow.
 *
 * State machine diagram:
 *   idle ──► target_title ──► summary ──► experience ──► skills_education ──► complete
 *             (Step 1)        (Step 2)     (Step 3)         (Step 4)          (Paywall)
 *
 * Each step represents a phase of the AI conversation.  The Mascot stays in
 * the current step until it has collected enough data to advance.
 *
 * 'complete' is the PAYWALL gate: the resume data is ready but generating the
 * PDF/Markdown document requires a premium subscription ($5/24h or monthly).
 */
export type InterviewStep =
  | 'idle'              // Landing — user hasn't started yet
  | 'target_title'      // Step 1: Target job title
  | 'summary'           // Step 2: Professional summary
  | 'experience'        // Step 3: Work history (AI probes for metrics + action verbs)
  | 'skills_education'  // Step 4: Skills + education
  | 'complete';         // All data collected → show Paywall CTA

/**
 * The authoritative step order used by `advanceStep()`.
 * Exported so components can build progress indicators without re-defining it.
 */
export const INTERVIEW_STEP_ORDER: readonly InterviewStep[] = [
  'idle',
  'target_title',
  'summary',
  'experience',
  'skills_education',
  'complete',
] as const;

/** Short label shown in the TopBar progress indicator and step headers. */
export const INTERVIEW_STEP_LABELS: Record<InterviewStep, string> = {
  idle:             'Get Started',
  target_title:     'Target Role',
  summary:          'Your Story',
  experience:       'Experience',
  skills_education: 'Skills & Education',
  complete:         'Ready to Generate',
};

/** Mac's opening prompt for each step — shown above the chat input. */
export const INTERVIEW_STEP_PROMPTS: Record<InterviewStep, string> = {
  idle:             "Hi! I'm Mac 🐾 Chat with me and I'll build your perfect resume.",
  target_title:     'What job title are you targeting? (e.g. "Senior Product Manager")',
  summary:          "Great choice! Now tell me about yourself — what's your professional story?",
  experience:       'Tell me about your most recent role. Company, title, and what you accomplished?',
  skills_education: "Awesome! What are your top technical and soft skills? And where did you study?",
  complete:         "Your resume is ready! 🎉 Unlock PDF export to download it.",
};

// ── Resume Data (structured output collected during interview) ────────────────

/**
 * A single work experience entry.
 *
 * Design note: we store responsibilities and metrics separately so the AI
 * in Task 4 can specifically prompt the user for quantified achievements
 * ("how many people did you manage?", "what was the revenue impact?").
 */
export interface ExperienceEntry {
  id: string;                   // Unique ID for React list keys
  company: string;
  title: string;
  startDate: string;            // ISO month: "2021-03"
  endDate: string | null;       // null means "Present"
  responsibilities: string[];   // Action-verb sentences, e.g. "Led a team of 8 engineers…"
  metrics: string[];            // Quantified wins, e.g. "Reduced load time by 40%"
}

export interface EducationEntry {
  id: string;
  institution: string;
  degree: string;               // e.g. "Bachelor of Applied Science"
  field: string;                // e.g. "Software Engineering"
  graduationYear: string;       // e.g. "2019"
  honours?: string;             // e.g. "Dean's List", "Summa Cum Laude"
}

/**
 * The complete structured resume payload.
 *
 * `Partial<ResumeData>` is used in the store because data is filled in
 * incrementally — we don't have all fields until the interview reaches
 * 'complete'.  The store's `resumeData` field uses Partial<> to reflect this.
 */
export interface ResumeData {
  targetTitle: string;
  summary: string;
  experiences: ExperienceEntry[];
  skills: string[];
  education: EducationEntry[];
}

// ── Chat ─────────────────────────────────────────────────────────────────────

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;  // Unix milliseconds — used for sorting and relative timestamps
}

// ── ATS Analysis Data Contract ────────────────────────────────────────────────

/**
 * A synonym pair found by the analysis engine:
 *   the resume used `resumeTerm` where the JD said `vacancyTerm`.
 * Only genuinely equivalent terms are included (not just co-occurring words).
 */
export interface ContextualMatch {
  resumeTerm:  string;
  vacancyTerm: string;
}

/**
 * ATSAnalysisResponse — the SINGLE atomic payload returned by POST /api/analyze.
 *
 * This is the iron-logic data contract that drives the entire
 * onboarding → workspace handoff:
 *
 *   score             → ATS score ring in DocumentPreview header
 *   foundKeywords     → ✅ green chips in the SkillGapChecklist
 *   missingKeywords   → ❌ red/orange actionable chips in SkillGapChecklist
 *   contextualMatches → tooltip annotations on foundKeywords chips
 *   macMessage        → the EXACT first message ChatPanel renders as Mac's greeting;
 *                       never generated client-side — always comes from the backend
 *
 * Validated at runtime with `isATSAnalysisResponse()` before touching the store.
 */
export interface ATSAnalysisResponse {
  /** ATS compatibility score 0–100 based on keyword overlap. */
  score: number;
  /** Hard-skill and role-specific keywords present in BOTH resume and JD. */
  foundKeywords: string[];
  /** Important JD keywords absent from the resume (max 12, hard skills first). */
  missingKeywords: string[];
  /** Synonym pairs where resume used an equivalent but different term. */
  contextualMatches: ContextualMatch[];
  /**
   * The exact first message Mac should display in the chat workspace.
   * Personalised: mentions the score and the top 2–3 critical gaps.
   * Generated by Gemini on the backend — never constructed client-side.
   */
  macMessage: string;
}

// ── Mascot Emotional State ────────────────────────────────────────────────────

/**
 * The five emotional states that drive Mac's animations.
 *
 * Computed in ChatPanel from UI + store state and passed as a single prop
 * to MacMascot — keeps the mascot component a pure presenter.
 *
 *   idle       — default; slow float, calm glow
 *   listening  — mic is active; sound-wave rings, attentive posture
 *   processing — AI call started, no tokens yet; thinking bubble
 *   talking    — SSE tokens streaming; bouncy speech animation
 *   warning    — backend scrubbed a forbidden HR field; head-shake + amber glow
 *
 * State priority order (highest → lowest):
 *   warning > shocked > success > listening > processing > talking > idle
 *
 * NEW in Task 8:
 *   shocked — ATS score < 50; red crimson shake + 😱 emoji (score reveal drama)
 *   success — ATS score > 80; gold/green celebration + ✨ emoji
 */
export type MascotState = 'idle' | 'listening' | 'processing' | 'talking' | 'warning' | 'shocked' | 'success';
