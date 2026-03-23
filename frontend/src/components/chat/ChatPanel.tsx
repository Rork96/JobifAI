/**
 * components/chat/ChatPanel.tsx — The Interview Conversation UI
 * ─────────────────────────────────────────────────────────────────────────────
 * This panel is the primary interaction surface for the entire product.
 * It wires together four concerns in one well-bounded component:
 *
 *   1. SSE STREAMING  — Calls POST /api/chat/interview and consumes the
 *                       Server-Sent Events stream in real-time.
 *
 *   2. VOICE INPUT    — Web Speech API via useSpeechRecognition hook.
 *                       Live interim transcript appears in the textarea as
 *                       the user speaks; final text is committed on silence.
 *
 *   3. HAPTIC FEEDBACK — navigator.vibrate([10,30,10]) fires the instant a
 *                        new data_extract block adds validated resume data.
 *                        The double-pulse pattern (on→pause→on) signals
 *                        "something was saved" without interrupting focus.
 *
 *   4. MASCOT STATE   — Computes `MascotState` from local + store signals
 *                       and passes it to MacMascot as a single prop so the
 *                       mascot always reflects the live system state.
 *
 * LOCAL STATE (kept out of the global Zustand store intentionally):
 *   inputValue       — Textarea content (changes on every keystroke)
 *   streamingContent — Live SSE typewriter buffer (changes on every token)
 *   isListening      — Microphone recording state (derived from the hook)
 *   isWarning        — Briefly true when backend scrubs a forbidden HR field
 *
 * These are local because they change at high frequency and only this component
 * cares about them.  Storing them globally would trigger DocumentPreview
 * re-renders on every keystroke and every token — wasteful.
 *
 * SSE STREAMING PHASES:
 *   Phase 1 — Thinking  (isGenerating=true, streamingContent='')
 *             → MacMascot shows 'processing' state + bouncing dots in the list
 *   Phase 2 — Streaming (isGenerating=true, streamingContent has text)
 *             → MacMascot shows 'talking' state + live bubble with cursor
 *   Phase 3 — Done      (addMessage commits text, both flags cleared)
 *             → MacMascot returns to 'idle', streaming bubble → final message
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import ReactMarkdown from 'react-markdown';

import { motion, AnimatePresence } from 'framer-motion';
import { Mic, MicOff, Send } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import {
  INTERVIEW_STEP_PROMPTS,
  type MascotState,
  type ResumeData,
} from '@/types';
import { MacMascot } from '@/components/mascot/MacMascot';
import { useSpeechRecognition } from '@/hooks/useSpeechRecognition';
import { BYOK_STORAGE_KEY } from '@/components/paywall/BYOKModal';

// ── API types ─────────────────────────────────────────────────────────────────

/** Mirrors InterviewRequest in backend/routers/interview.py */
interface InterviewRequestBody {
  user_message:         string;
  current_step:         string;
  user_lang:            string;
  resume_lang:          string;
  conversation_history: Array<{ role: 'user' | 'assistant'; content: string }>;
  resume_data_context:  Partial<ResumeData>;
  byok_api_key?:        string;
  /** Optional: when set, Mac tailors questions to the JD's skills and keywords. */
  job_description?:     string;
  /**
   * Optional: the ghost keyword the user clicked in the resume preview.
   * When set, the backend injects a coaching-mode context so Mac asks ONE
   * targeted follow-up question (tailored to the JD) before drafting a bullet.
   */
  ghost_keyword?:       string;
  /**
   * Optional: current ATS score (0–100).
   * Used by the backend to select the Mac persona tier:
   *   < 30  → Emergency Triage (brief, fill empty sections first)
   *   > 90  → Triumph (celebrate, suggest Elite Bonus Skills)
   *   30–90 → Standard coaching (no override)
   */
  current_score?:       number;

  /**
   * REQUIRED by the unified data contract (Task: Global State Machine).
   * AppMode — 'OPTIMIZE' | 'SCRATCH'.
   * Tells PersonaFactory which system instruction strategy to use:
   *   OPTIMIZE → coaching/keyword flow (_STEPS_OPTIMIZE)
   *   SCRATCH  → full interview state machine (_STEPS_SCRATCH)
   */
  mode:                 string;

  /**
   * REQUIRED by the unified data contract.
   * AppStatus — 'IDLE' | 'ANALYZING' | 'COACHING' | 'BUILDING'.
   * Logged by the backend for lifecycle tracking.  Future middleware
   * will gate certain statuses (e.g. reject chat during ANALYZING).
   */
  status:               string;
}

/** Parsed payload of a `data_extract` SSE event (mirrors ai_service.py output). */
interface DataExtractPayload {
  step:      string;
  advance:   boolean;
  data:      Partial<ResumeData>;
  _warn?:    string;
  _error?:   string;
  /** Populated by _scrub_forbidden_fields when a Canadian HR field was removed. */
  _scrubbed?: string[];
}

// ── Two-step validation types ─────────────────────────────────────────────────

/** Mirrors EvaluateRequest in backend/routers/evaluate.py */
interface EvaluateRequest {
  field_type:           string;
  proposed_edit:        string;
  current_resume_state: Partial<ResumeData>;
  job_description:      string;
}

/** Mirrors EvaluateResponse in backend/routers/evaluate.py */
interface EvaluateResponse {
  approved:    boolean;
  reason:      string;
  score_delta: number;
}

// ── Two-step validation helpers ───────────────────────────────────────────────

/**
 * Serialise the first meaningful value from a data_extract payload into
 * a human-readable string for the scorer.
 *
 * Returns [fieldType, proposedEditString]:
 *   { targetTitle: "Senior Engineer" }  →  ["targetTitle", "Senior Engineer"]
 *   { skills: ["React", "Python"] }     →  ["skills", "React, Python"]
 *   { experiences: [{ ... }] }          →  ["experiences", JSON of first entry]
 */
function serializeProposedEdit(data: Partial<ResumeData>): [string, string] {
  const entries = Object.entries(data);
  if (entries.length === 0) return ['unknown', ''];

  const [key, value] = entries[0];

  if (typeof value === 'string') {
    return [key, value];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [key, ''];
    // String arrays (skills) → comma-separated
    if (typeof value[0] === 'string') {
      return [key, (value as string[]).join(', ')];
    }
    // Object arrays (experiences, education) → JSON of first entry, compact
    return [key, JSON.stringify(value[0])];
  }
  return [key, JSON.stringify(value)];
}

/**
 * Call POST /api/evaluate-edit to score a proposed resume addition.
 *
 * Returns the evaluation verdict.  Throws on network error so the caller
 * can fail-open (approve the edit and let the interview continue).
 */
async function callEvaluateEdit(
  data:               Partial<ResumeData>,
  currentResumeState: Partial<ResumeData>,
  signal?:            AbortSignal,
): Promise<EvaluateResponse> {
  const [fieldType, proposedEdit] = serializeProposedEdit(data);

  // Read JD directly from store — callEvaluateEdit is a module-level function
  // (not a hook) so we use getState() rather than a useAppStore selector.
  const jobDescription = useAppStore.getState().jobDescription ?? '';

  const body: EvaluateRequest = {
    field_type:           fieldType,
    proposed_edit:        proposedEdit,
    current_resume_state: currentResumeState,
    job_description:      jobDescription,
  };

  const res = await fetch('/api/evaluate-edit', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
    signal,
  });

  if (!res.ok) throw new Error(`Evaluate API ${res.status}`);
  return res.json() as Promise<EvaluateResponse>;
}

// ── Haptic feedback helper ────────────────────────────────────────────────────

/**
 * Fire the navigator.vibrate() API with a given pattern (milliseconds).
 *
 * WHY a helper instead of inline calls?
 *   1. The API is not available on all platforms (desktop browsers, iOS Safari
 *      before 16.4) — this guard prevents silent errors.
 *   2. Centralising patterns here makes it easy to tweak them globally.
 *   3. In tests / Cypress, vibration is a no-op (navigator.vibrate is undefined).
 *
 * PATTERN `[10, 30, 10]`:
 *   ON for 10ms → silent for 30ms → ON for 10ms
 *   The double-tap pattern is internationally recognised as "confirmed" or
 *   "saved" — like a credit-card reader beeping twice after a payment.
 */
const hapticFeedback = (pattern: number[] = [10, 30, 10]): void => {
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    navigator.vibrate(pattern);
  }
};

// ── Relative timestamp helper ─────────────────────────────────────────────────
const formatRelativeTime = (timestamp: number): string => {
  const s = Math.floor((Date.now() - timestamp) / 1000);
  if (s < 60)   return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};

// ── Component ─────────────────────────────────────────────────────────────────
export const ChatPanel: React.FC = () => {

  // ── Local state ─────────────────────────────────────────────────────────────
  const [inputValue,       setInputValue]      = useState('');
  const [streamingContent, setStreamingContent] = useState<string | null>(null);

  // `isWarning` is true for ~2 seconds when the backend scrubs a forbidden
  // HR field from the data_extract JSON.  Drives MacMascot's 'warning' state.
  const [isWarning,        setIsWarning]        = useState(false);
  const warningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Ghost keyword auto-send flag ─────────────────────────────────────────────
  // Set to true when a ghost word is clicked in the resume preview.  A separate
  // useEffect (declared AFTER handleSend) watches this flag and fires handleSend
  // once React has flushed the inputValue state update.
  const [ghostAutoSend,      setGhostAutoSend]      = useState(false);
  // The raw keyword string from the ghost click (e.g. "Terraform") — passed to
  // the backend as `ghost_keyword` so Mac can ask a targeted coaching question.
  const [pendingGhostKeyword, setPendingGhostKeyword] = useState<string | null>(null);
  // Status label shown in the thinking bubble instead of generic dots.
  // Set to "Drafting your achievement…" during ghost keyword turns.
  const [thinkingLabel,       setThinkingLabel]       = useState<string | null>(null);

  // ── Refs ────────────────────────────────────────────────────────────────────
  // AbortController cancels the in-flight fetch on unmount or new request.
  const abortRef = useRef<AbortController | null>(null);

  // Scroll anchor — always at the bottom of the message list.
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Textarea DOM ref — used by the autogrow effect to measure and set height.
  // We use a ref (not onInput) because the value can change via three paths:
  //   1. User typing (onInput would fire)
  //   2. Voice recognition → setInputValue() (React state update, no onInput event)
  //   3. Post-send clear → setInputValue('') (React state update, no onInput event)
  // A useEffect on `inputValue` handles all three uniformly.
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Saves the inputValue text that existed BEFORE recording started.
  // When speech recognition runs, the new transcript is APPENDED to this
  // base text (so existing typed text is preserved).
  const baseSpeechTextRef = useRef('');

  // Two-step validation: if the scorer rejects an edit, we store the reason
  // here and emit it as a follow-up Mac message in the `done` case.
  // Using a ref (not state) so the `done` handler can read it synchronously
  // without triggering an extra re-render.
  const rejectionMessageRef = useRef<string | null>(null);

  // ── Background ATS score sync (Scratch mode) ─────────────────────────────
  // Debounce timer: after every approved data_extract, wait 3 s then silently
  // call /api/analyze with the latest resumeData.  The score return value is
  // written to currentAtsScore via setAtsScore — never blocks the interview.
  const bgSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Greeting guard (useRef, not module-level) ────────────────────────────────
  // useRef resets correctly when this specific ChatPanel instance is mounted
  // fresh (e.g. workspace mount after paywall is unmounted).
  // Module-level booleans over-prevent: once set true in the paywall ChatPanel,
  // the workspace ChatPanel would never greet even after a full navigation cycle.
  const hasGreetedRef = useRef(false);

  // ── Store subscriptions ──────────────────────────────────────────────────────
  const currentStep      = useAppStore((s) => s.currentStep);
  const messages         = useAppStore((s) => s.messages);
  const isGenerating     = useAppStore((s) => s.isGenerating);
  const userLang         = useAppStore((s) => s.userLang);
  const resumeLang       = useAppStore((s) => s.resumeLang);
  const resumeData       = useAppStore((s) => s.resumeData);
  // Job description from onboarding — Mac uses this to tailor interview questions.
  const jobDescription        = useAppStore((s) => s.jobDescription);
  // Uploaded resume text — also used to detect when context is ready to fire greeting.
  const uploadedResumeText    = useAppStore((s) => s.uploadedResumeText);

  // Actions — Zustand guarantees stable references; safe in dependency arrays.
  const addMessage       = useAppStore((s) => s.addMessage);
  const advanceStep      = useAppStore((s) => s.advanceStep);
  const setIsGenerating  = useAppStore((s) => s.setIsGenerating);
  const updateResumeData = useAppStore((s) => s.updateResumeData);
  const skillGaps        = useAppStore((s) => s.skillGaps);
  const bumpAtsScore     = useAppStore((s) => s.bumpAtsScore);
  const currentAtsScore  = useAppStore((s) => s.currentAtsScore);
  // Unified app state — included in every API request per data contract.
  const appMode          = useAppStore((s) => s.appMode);
  const appStatus        = useAppStore((s) => s.appStatus);

  // ── Speech Recognition ───────────────────────────────────────────────────────
  const {
    isSupported:      isSpeechSupported,
    isListening,
    interimText,
    finalText,
    permissionDenied: micPermissionDenied,
    startListening,
    stopListening,
  } = useSpeechRecognition(userLang);

  // ── Mic button handler ───────────────────────────────────────────────────────
  const handleMicToggle = useCallback(() => {
    if (isListening) {
      stopListening();
    } else {
      // Save the current inputValue so we can append the transcript to it
      baseSpeechTextRef.current = inputValue;
      startListening();
    }
  }, [isListening, inputValue, startListening, stopListening]);

  // ── Live interim transcript → textarea ────────────────────────────────────
  // As the user speaks, update the textarea in real-time with the interim text.
  // This gives the "typing via voice" typewriter effect.
  // The interim disappears on silence (SpeechRecognition fires `onend`).
  useEffect(() => {
    if (isListening && interimText) {
      // Show base + interim in textarea so the user sees the live transcript
      setInputValue(baseSpeechTextRef.current
        ? `${baseSpeechTextRef.current} ${interimText}`
        : interimText
      );
    }
  }, [interimText, isListening]);

  // ── Committed final transcript → inputValue ───────────────────────────────
  // When the recognition session ends (on silence or manual stop), the hook
  // fires one last `finalText` update.  We commit it to the input value.
  const prevFinalRef = useRef('');
  useEffect(() => {
    if (finalText && finalText !== prevFinalRef.current) {
      const appended = baseSpeechTextRef.current
        ? `${baseSpeechTextRef.current} ${finalText}`.trim()
        : finalText.trim();
      setInputValue(appended);
      // Update base so successive final chunks accumulate correctly
      baseSpeechTextRef.current = appended;
      prevFinalRef.current = finalText;
    }
  }, [finalText]);

  // Reset the base text tracker when a new recording session starts
  useEffect(() => {
    if (!isListening) {
      prevFinalRef.current = '';
    }
  }, [isListening]);

  // ── Warning auto-reset ────────────────────────────────────────────────────
  const triggerWarning = useCallback(() => {
    // Clear any existing timer first to restart the 2 s window
    if (warningTimerRef.current) clearTimeout(warningTimerRef.current);
    setIsWarning(true);
    warningTimerRef.current = setTimeout(() => setIsWarning(false), 2000);
  }, []);

  // ── Skill gap chip insertion (from DocumentPreview checklist) ───────────────
  // DocumentPreview dispatches 'jobifai:insertSkill' when the user clicks a gap
  // chip.  We listen here (rather than prop-drilling) to keep the two panels
  // independent while sharing one behaviour.
  useEffect(() => {
    const handler = (e: Event) => {
      const { gap } = (e as CustomEvent<{ gap: string }>).detail;
      setInputValue((prev) =>
        prev.trim()
          ? `${prev.trim()} I have experience with ${gap}. `
          : `I have experience with ${gap}. `,
      );
      textareaRef.current?.focus();
    };
    window.addEventListener('jobifai:insertSkill', handler);
    return () => window.removeEventListener('jobifai:insertSkill', handler);
  }, []);

  // ── Ghost keyword click → auto-submit ─────────────────────────────────────
  // When a dashed ghost word is clicked in StandardA4Layout, DocumentPreview
  // dispatches 'jobifai:ghostKeyword' with a pre-formed coaching message AND
  // the raw keyword string.  We batch all three state updates so React commits
  // them in a single render — by the time the auto-submit effect fires,
  // inputValue, pendingGhostKeyword, and ghostAutoSend are all consistent.
  useEffect(() => {
    const handler = (e: Event) => {
      const { message, keyword } = (e as CustomEvent<{ message: string; keyword?: string }>).detail;
      setInputValue(message);
      if (keyword) setPendingGhostKeyword(keyword);
      setGhostAutoSend(true);
    };
    window.addEventListener('jobifai:ghostKeyword', handler);
    return () => window.removeEventListener('jobifai:ghostKeyword', handler);
  }, []);

  // ── Background ATS re-evaluation (Magic Rewrite accept / manual edits) ────
  // DiffView and EditableBullet dispatch 'jobifai:bgEval' after committing a
  // change.  We silently re-call /api/analyze so the score ring turns green
  // live — no mode restriction (works in both scratch and optimize modes).
  useEffect(() => {
    const handler = async () => {
      const st = useAppStore.getState();
      const rdJson = JSON.stringify(st.resumeData);
      if (rdJson === '{}' || !st.jobDescription.trim()) return;
      try {
        const r = await fetch('/api/analyze', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            resume_text:     rdJson,
            job_description: st.jobDescription,
          }),
        });
        if (!r.ok) return;
        const d = await r.json() as { score?: number };
        if (typeof d.score === 'number') {
          useAppStore.getState().setAtsScore(Math.min(100, d.score));
        }
      } catch { /* silent — never surface a background eval error */ }
    };
    window.addEventListener('jobifai:bgEval', handler as EventListener);
    return () => window.removeEventListener('jobifai:bgEval', handler as EventListener);
  }, []);

  // ── Autogrow textarea ─────────────────────────────────────────────────────
  // WHY useEffect instead of the onInput event:
  //   onInput only fires on native DOM keyboard/paste events.  Voice recognition
  //   and post-send clears both update the value via React state (setInputValue),
  //   which does NOT trigger onInput.  This effect catches every path.
  //
  // WHY NOT `style={{ height: 'auto' }}` on the element:
  //   React re-applies JSX props on every render — `style={{ height: 'auto' }}`
  //   would reset the height back to single-row on every token that arrives
  //   in the streaming bubble (which triggers a re-render).  By keeping height
  //   purely in the ref's inline style, React never overwrites it.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    // Step 1: collapse to auto so scrollHeight reports the natural (unconstrained) height.
    // Without this, a shrink (e.g. after clearing the field) would never happen
    // because scrollHeight can't go below the explicitly set height.
    el.style.height = 'auto';
    // Step 2: expand to content height, capped at 112px (~4.5 rows).
    // 112px is enough to show a full voice transcript without the input bar
    // taking over the screen on mobile.
    el.style.height = `${Math.min(el.scrollHeight, 112)}px`;
  }, [inputValue]);

  // ── Mac talks first — initial greeting ────────────────────────────────────
  // Uses a useRef guard (not a module-level bool) so the flag resets correctly
  // when this specific instance unmounts and a fresh workspace ChatPanel mounts.
  //
  // Logic:
  //   IF resumeData has content OR jobDescription/uploadedResumeText exist
  //     → send ONE analysis prompt so Mac starts improving immediately
  //   ELSE
  //     → send the default 'hi' to start the "What's the dream job?" flow
  //
  // React 18 Strict Mode double-invokes effects: the cleanup `clearTimeout`
  // cancels the first timer, and the second mount sets hasGreetedRef=true
  // synchronously before the timeout fires — exactly one greeting results.
  useEffect(() => {
    if (hasGreetedRef.current) return;
    if (messages.length > 0) return;

    const timer = setTimeout(async () => {
      // Guard against React 18 Strict Mode double-invocation:
      // hasGreetedRef is set INSIDE the timeout so the cleanup clearTimeout()
      // from the first invocation cancels it before this flag is ever set.
      // The second mount re-schedules and this runs exactly once.
      if (hasGreetedRef.current) return;
      if (useAppStore.getState().messages.length > 0) return;
      hasGreetedRef.current = true;

      // ── Short-circuit: if analysis has already run, emit the stored Mac message
      // directly instead of making an API round-trip that produces a duplicate.
      // This fixes the double-message bug where analysisResult.macMessage is set
      // in the store but never surfaced to the messages[] array.
      const existingAnalysis = useAppStore.getState().analysisResult;
      if (existingAnalysis !== null) {
        const directMsg =
          existingAnalysis.score === 100
            ? `✨ **Stellar work!** Your resume is a **100% match** for this role.\n\nLet's focus on polishing the tone or adding metrics that make you stand out. Click any bullet to start editing, or try the ⭐ bonus keywords to get ahead of the pack.`
            : (existingAnalysis.macMessage ?? `Your resume scored **${existingAnalysis.score}%**. Let's close those gaps — click any dashed keyword to get started.`);
        useAppStore.getState().addMessage({ role: 'assistant', content: directMsg });
        return;
      }

      setIsGenerating(true);
      setStreamingContent('');

      const {
        userLang: lang,
        resumeLang: rLang,
        jobDescription: jd,
        uploadedResumeText: rawResume,
        resumeData: rd,
      } = useAppStore.getState();
      const byokKey = localStorage.getItem(BYOK_STORAGE_KEY) ?? undefined;

      // Decide greeting based on whether any context already exists
      const hasResumeData = rd && Object.values(rd).some((v) => v !== null && v !== undefined && v !== '');
      const hasContext    = !!(hasResumeData || jd?.trim() || rawResume?.trim());

      // ── Separate the trigger instruction from the heavy context payloads ────
      // The old approach embedded rawResume + jd directly into user_message,
      // which blew past the 4 000-char Pydantic limit and caused 422 errors.
      //
      // Fix: user_message carries only a short (<200 char) instruction;
      //      resume_data and job_context carry the full text in their own
      //      dedicated fields (max_length=15 000 each on the backend).
      //      The backend's context-hint builder stitches them back together
      //      as a bracketed [System context …] note before the instruction.

      let greetingMessage: string;
      // Context fields to send alongside the instruction (never inline in user_message)
      let greetingResumeData: string | undefined;
      let greetingJobContext:  string | undefined;

      if (rawResume?.trim() && jd?.trim()) {
        greetingMessage =
          'System: The user has provided their current resume and a target job description. ' +
          'Analyze the key skill and experience gaps, then tell them the top 3 things to improve first. ' +
          'Be specific and actionable.';
        greetingResumeData = rawResume;
        greetingJobContext  = jd;
      } else if (jd?.trim()) {
        greetingMessage =
          'System: The user wants to build a resume for this job. ' +
          'Start the interview to collect their experience. ' +
          'Ask for their most recent relevant role first.';
        greetingJobContext = jd;
      } else if (rawResume?.trim()) {
        greetingMessage =
          'System: The user has uploaded their resume. ' +
          'Analyze it and suggest the top improvements, then ask what type of role they are targeting.';
        greetingResumeData = rawResume;
      } else if (hasResumeData) {
        greetingMessage =
          'System: I have uploaded my resume. Please review it and suggest what to improve first.';
      } else {
        greetingMessage = 'hi';
      }

      let accumulated = '';
      let finished    = false;
      const cleanup   = () => { setStreamingContent(null); setIsGenerating(false); finished = true; };

      try {
        const res = await fetch('/api/chat/interview', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_message:         greetingMessage,
            current_step:         'idle',
            user_lang:            lang,
            resume_lang:          rLang,
            conversation_history: [],
            resume_data_context:  rd ?? {},
            ...(byokKey             ? { byok_api_key:  byokKey            } : {}),
            ...(jd                  ? { job_description: jd               } : {}),
            // Dedicated heavy-context fields (Task 21) — never embedded in user_message
            ...(greetingResumeData  ? { resume_data:   greetingResumeData } : {}),
            ...(greetingJobContext   ? { job_context:   greetingJobContext  } : {}),
          }),
        });

        if (!res.ok || !res.body) { cleanup(); return; }

        const reader  = res.body.getReader();
        const decoder = new TextDecoder();
        let   buffer  = '';

        while (!finished) {
          const { value, done: readerDone } = await reader.read();
          if (readerDone) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split('\n\n');
          buffer = parts.pop() ?? '';

          for (const block of parts) {
            if (finished || !block.trim()) continue;
            const eventType  = /^event: (.+)$/m.exec(block)?.[1]?.trim();
            const dataString = /^data: (.+)$/m.exec(block)?.[1]?.trim();
            if (!eventType || !dataString) continue;

            let payload: Record<string, unknown>;
            try { payload = JSON.parse(dataString); } catch { continue; }

            if (eventType === 'token') {
              accumulated += (payload.text as string) ?? '';
              setStreamingContent(accumulated);
            } else if (eventType === 'data_extract') {
              const extracted = payload as unknown as DataExtractPayload;
              if (extracted.advance === true) advanceStep();
            } else if (eventType === 'done') {
              if (accumulated.trim()) addMessage({ role: 'assistant', content: accumulated.trim() });
              cleanup();
            } else if (eventType === 'error') {
              cleanup();
            }
          }
        }
      } catch {
        cleanup();
      }
    }, 500);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobDescription, uploadedResumeText]); // Re-evaluate when context arrives from onboarding

  // ── Cleanup on unmount ────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (warningTimerRef.current) clearTimeout(warningTimerRef.current);
      // Cancel any pending background ATS sync so it doesn't fire after unmount
      if (bgSyncTimerRef.current) clearTimeout(bgSyncTimerRef.current);
    };
  }, []);

  // ── Auto-scroll ───────────────────────────────────────────────────────────
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

  // ── Mascot state computation ──────────────────────────────────────────────
  /**
   * A single derived value that drives MacMascot's entire visual state.
   *
   * Priority order (highest first):
   *   warning    — Brief HR compliance feedback
   *   listening  — Mic is hot; always highest precedence after warning
   *   processing — API call started, no tokens yet
   *   talking    — Tokens are actively streaming
   *   idle       — Default
   */
  const mascotState = useMemo((): MascotState => {
    if (isWarning)                              return 'warning';
    if (isListening)                            return 'listening';
    if (isGenerating && streamingContent === '') return 'processing';
    if (streamingContent)                       return 'talking';
    // Triumph: 100% ATS score while idle — gold celebration glow
    if (currentAtsScore >= 100)                 return 'triumph';
    return 'idle';
  }, [isWarning, isListening, isGenerating, streamingContent, currentAtsScore]);

  // ── Send handler (SSE streaming) ──────────────────────────────────────────
  const handleSend = async () => {
    const trimmed = inputValue.trim();
    if (!trimmed || isGenerating) return;

    // Stop mic if user taps send while recording
    if (isListening) stopListening();

    // Snapshot state BEFORE any store mutations.
    // The backend wants history EXCLUDING the current user turn —
    // `prevMessages` is the conversation so far, not including `trimmed`.
    const prevMessages = useAppStore.getState().messages;
    const langUser     = userLang;
    const langResume   = resumeLang;
    // Always read resumeData directly from the store (not from the React
    // subscription closure) so we send the absolute latest accumulated state.
    // This matters after a data_extract update in the same event-loop tick
    // where the React subscription may not have re-rendered yet.
    const ctxData = useAppStore.getState().resumeData;

    // ── Effective step: use 'optimize' in upload/optimization mode ─────────────
    // In 'upload' mode the currentStep stays at 'idle' because no interview is
    // running.  Sending 'idle' makes Mac follow the "greet and ask for title"
    // instruction — completely wrong for keyword coaching.  We override to
    // 'optimize' so Mac follows the Career Coach rules instead.
    const st = useAppStore.getState();
    const isOptimizeMode =
      st.onboardingMode === 'upload' ||
      (st.analysisResult !== null && st.onboardingMode !== 'scratch');
    const effectiveStep = isOptimizeMode ? 'optimize' : currentStep;

    // ── Ghost keyword context ──────────────────────────────────────────────────
    // Capture and clear pendingGhostKeyword in the same render-tick so the next
    // send (non-ghost) doesn't accidentally carry a stale keyword.
    const ghostKeyword = pendingGhostKeyword;
    if (ghostKeyword) {
      setPendingGhostKeyword(null);
      setThinkingLabel('Drafting your achievement…');
    }

    // 1. Haptic feedback on send — single 50 ms pulse signals "message sent"
    hapticFeedback([50]);

    // 2. Optimistic UI — user sees their message immediately
    addMessage({ role: 'user', content: trimmed });
    setInputValue('');
    baseSpeechTextRef.current = '';

    // 3. Enter "thinking" phase
    setIsGenerating(true);
    setStreamingContent('');  // '' = streaming started, no tokens yet (shows dots)

    // Cancel any previous in-flight request (defensive; send button is disabled
    // during generation, but handles edge cases like rapid double-submit)
    abortRef.current?.abort();
    abortRef.current = new AbortController();

    let accumulated = '';   // Collects the full conversational text for this turn
    let finished    = false; // Guards against processing events after done/error

    const cleanup = () => {
      setStreamingContent(null);
      setIsGenerating(false);
      setThinkingLabel(null);  // Clear "Drafting your achievement…" status
      finished = true;
    };

    // Read BYOK key from localStorage on every send — picked up immediately
    // after the user enters it in BYOKModal, no page reload required.
    const byokKey = localStorage.getItem(BYOK_STORAGE_KEY) ?? undefined;

    const body: InterviewRequestBody = {
      user_message:         trimmed,
      current_step:         effectiveStep,
      user_lang:            langUser,
      resume_lang:          langResume,
      conversation_history: prevMessages.map((m) => ({
        role:    m.role,
        content: m.content,
      })),
      resume_data_context: ctxData,
      // BYOK: if user supplied their own Gemini key, pass it to the backend.
      // The backend uses it instead of the server-side GEMINI_API_KEY env var.
      ...(byokKey ? { byok_api_key: byokKey } : {}),
      // Pass the JD so Mac's system prompt always includes RULE 4b job context.
      // Sent on EVERY turn — not only greetings — so ghost-keyword coaching turns
      // also have the full JD and can tailor questions to the specific role.
      ...(jobDescription ? { job_description: jobDescription } : {}),
      // Pass the ghost keyword when it was triggered by a ghost-gap click.
      // The backend injects a targeted coaching context for this turn only.
      ...(ghostKeyword ? { ghost_keyword: ghostKeyword } : {}),
      // Pass the current ATS score so the backend can apply the right persona
      // tier: Emergency (<30), Standard (30–90), or Triumph (>90).
      ...(currentAtsScore > 0 ? { current_score: currentAtsScore } : {}),
      // ── Unified data contract ─────────────────────────────────────────────
      // mode and status are REQUIRED in every /api/chat request.
      // They tell PersonaFactory which strategy to use and let the backend
      // log lifecycle transitions.  Default to safe values when the store
      // hasn't been initialised yet (first-render edge case).
      mode:   appMode   ?? 'OPTIMIZE',
      status: appStatus ?? 'COACHING',
    };

    try {
      const res = await fetch('/api/chat/interview', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
        signal:  abortRef.current.signal,
      });

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => `HTTP ${res.status}`);
        throw new Error(errText);
      }

      // ── SSE Stream reader ───────────────────────────────────────────────
      // SSE format: "event: <type>\ndata: <json>\n\n"
      // A single chunk from the network can contain 0, 1, or many events.
      // We use a `buffer` to handle events split across chunk boundaries.
      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let   buffer  = '';

      while (!finished) {
        const { value, done: readerDone } = await reader.read();
        if (readerDone) break;

        buffer += decoder.decode(value, { stream: true });

        // Split on the SSE event delimiter (double newline).
        // `parts.pop()` keeps the incomplete trailing fragment in `buffer`.
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';

        for (const block of parts) {
          if (finished || !block.trim()) continue;

          const eventType  = /^event: (.+)$/m.exec(block)?.[1]?.trim();
          const dataString = /^data: (.+)$/m.exec(block)?.[1]?.trim();
          if (!eventType || !dataString) continue;

          let payload: Record<string, unknown>;
          try { payload = JSON.parse(dataString); }
          catch { continue; }

          switch (eventType) {

            // ── token — conversational text chunk ────────────────────────
            case 'token': {
              const chunk = (payload.text as string) ?? '';
              accumulated += chunk;
              // Update the live streaming bubble — React batches these
              // setState calls in concurrent mode to avoid thrashing
              setStreamingContent(accumulated);
              break;
            }

            // ── data_extract — two-step validation + resume update ───────
            //
            // Flow:
            //   1. HR scrub check → warning state if forbidden fields removed
            //   2. If data is non-empty → call POST /api/evaluate-edit
            //       approved  → commit to store + haptic flash
            //       rejected  → store reason; emit as follow-up Mac message
            //   3. Advance step only if data was approved (or there was no data)
            //
            // This `await` is valid here because `handleSend` is async and the
            // SSE reader loop is inside an `async` function.  The reader simply
            // waits for the evaluate call before processing the `done` event.
            case 'data_extract': {
              const extracted = payload as unknown as DataExtractPayload;

              // ── HR scrub warning ───────────────────────────────────────
              if (extracted._scrubbed && extracted._scrubbed.length > 0) {
                triggerWarning();
                hapticFeedback([60]);
              }

              // ── Two-step ATS validation ────────────────────────────────
              let dataApproved = true; // default: no data = nothing to validate

              if (extracted.data && Object.keys(extracted.data).length > 0) {
                // Snapshot current state BEFORE any mutations — the scorer
                // needs it to detect duplicates against the existing resume.
                const currentState = useAppStore.getState().resumeData;

                try {
                  const evaluation = await callEvaluateEdit(
                    extracted.data,
                    currentState,
                    abortRef.current?.signal,
                  );

                  if (evaluation.approved) {
                    // ── Approved: commit to store + bump ATS + haptic ───
                    updateResumeData(extracted.data);
                    if (evaluation.score_delta > 0) {
                      bumpAtsScore(evaluation.score_delta);
                      // Extra vibration pulse when ATS score actually improves
                      hapticFeedback([10, 20, 30]);
                    } else {
                      hapticFeedback([10, 30, 10]);
                    }

                    // ── Scratch-mode background ATS pulse ────────────────
                    // Debounced 3 s: silently re-scores the whole resume once
                    // the AI has finished updating a section.  The returned
                    // score is written to currentAtsScore so the score ring
                    // moves without any user action.
                    if (bgSyncTimerRef.current) clearTimeout(bgSyncTimerRef.current);
                    bgSyncTimerRef.current = setTimeout(async () => {
                      const st = useAppStore.getState();
                      // Only run for scratch-mode sessions with JD context
                      if (st.onboardingMode !== 'scratch') return;
                      const rdJson = JSON.stringify(st.resumeData);
                      if (rdJson === '{}' || !st.jobDescription.trim()) return;
                      try {
                        const r = await fetch('/api/analyze', {
                          method:  'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            resume_text:     rdJson,
                            job_description: st.jobDescription,
                          }),
                        });
                        if (!r.ok) return; // silent — never surface this error
                        const d = await r.json() as { score?: number };
                        if (typeof d.score === 'number') {
                          // setAtsScore logs "[Store] ATS Score Sync: N"
                          useAppStore.getState().setAtsScore(Math.min(100, d.score));
                        }
                      } catch { /* silent — never block the interview flow */ }
                    }, 3000);
                  } else {
                    // ── Rejected: store reason to emit after the turn ────
                    // We don't commit the data or fire haptic.
                    // Mac's follow-up message appears after the current SSE
                    // turn completes — it's a separate second message bubble.
                    dataApproved = false;
                    rejectionMessageRef.current =
                      `I didn't add that to your resume just yet. ` +
                      `${evaluation.reason} ` +
                      `Could you give me more specific details — for example, ` +
                      `a percentage, dollar amount, or timeframe?`;
                  }
                } catch (evalErr) {
                  // Fail-open: network error / AbortError
                  if ((evalErr as Error)?.name !== 'AbortError') {
                    // Score service unavailable — commit anyway so interview
                    // is never blocked by a secondary service.
                    updateResumeData(extracted.data);
                    hapticFeedback([10, 30, 10]);
                  }
                }
              }

              // ── Advance the state machine (only if data was approved) ──
              if (extracted.advance === true && dataApproved) {
                advanceStep();
              }
              break;
            }

            // ── done — stream complete, commit message to history ────────
            case 'done': {
              if (accumulated.trim()) {
                addMessage({ role: 'assistant', content: accumulated.trim() });
              }
              // If the scorer rejected an edit, emit Mac's explanation as a
              // follow-up message immediately after the main turn message.
              if (rejectionMessageRef.current) {
                addMessage({ role: 'assistant', content: rejectionMessageRef.current });
                rejectionMessageRef.current = null;
              }
              cleanup();
              break;
            }

            // ── error — AI service failure ───────────────────────────────
            case 'error': {
              const msg = (payload.message as string) ?? 'Something went wrong.';
              addMessage({ role: 'assistant', content: `⚠️ ${msg}` });
              cleanup();
              break;
            }
          }
        }
      }

    } catch (err: unknown) {
      if ((err as Error)?.name === 'AbortError') {
        // Intentional cancel (unmount / new request) — silent cleanup
      } else {
        // Real network error — show whatever we managed to stream
        if (accumulated.trim()) {
          addMessage({ role: 'assistant', content: accumulated.trim() });
        } else {
          addMessage({
            role:    'assistant',
            content: '⚠️ Connection error — please check your network and try again.',
          });
        }
      }
      cleanup();
    }
  };

  // ── Ghost keyword auto-submit (must follow handleSend declaration) ──────────
  // When ghostAutoSend becomes true, inputValue has already been set to the
  // coaching message.  React batches both state updates from the event handler,
  // so by the time this effect fires, inputValue === the ghost message and
  // handleSend (which reads inputValue) will submit the correct text.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!ghostAutoSend) return;
    setGhostAutoSend(false);
    const t = setTimeout(handleSend, 0);  // tick 0 ensures React has flushed state
    return () => clearTimeout(t);
  // handleSend is intentionally in deps — rebuilt when inputValue changes
  }, [ghostAutoSend, handleSend]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // ── Derived: is the textarea in "voice capture" mode? ─────────────────────
  // When listening, style the textarea differently to signal "voice mode".
  const isVoiceActive = isListening;

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full min-h-0 bg-white">

      {/* ── Header: Mascot + step prompt ────────────────────────────────── */}
      <div className="flex-shrink-0 px-5 pt-6 pb-4 border-b border-gray-100">
        <div className="flex flex-col items-center gap-3">

          {/* MacMascot receives the full state for emotional synchronisation */}
          <MacMascot
            currentStep={currentStep}
            state={mascotState}
          />

          {/* Step context prompt — slides in/out on step change */}
          <AnimatePresence mode="wait">
            <motion.p
              key={currentStep}
              className="text-sm text-center text-gray-500 max-w-xs leading-relaxed"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{   opacity: 0, y: -6 }}
              transition={{ duration: 0.2 }}
            >
              {INTERVIEW_STEP_PROMPTS[currentStep]}
            </motion.p>
          </AnimatePresence>

          {/* Language indicator */}
          <div className="flex items-center gap-1.5 text-xs text-gray-400">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
            <span>
              Chatting in{' '}
              <strong className="font-medium">{userLang}</strong>
            </span>
          </div>
        </div>
      </div>

      {/* ── Skill gap banner ─────────────────────────────────────────────── */}
      {/*
        Shown when the onboarding ATS scan surfaced missing keywords AND the
        conversation is still early (≤ 2 messages) so the user sees them while
        they're still relevant.  Collapses once they've had a chance to read.
      */}
      <AnimatePresence>
        {skillGaps.length > 0 && messages.length <= 2 && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{   opacity: 0, height: 0 }}
            transition={{ duration: 0.25 }}
            className="flex-shrink-0 px-4 pt-2 pb-1 border-b border-orange-500/20 bg-orange-500/5"
          >
            <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-orange-400 mb-1.5">
              Missing Keywords
            </p>
            <div className="flex flex-wrap gap-1.5 pb-1">
              {skillGaps.map((gap) => (
                <button
                  key={gap}
                  onClick={() => {
                    // Append "I have experience with [Keyword]. " to the textarea
                    // and focus it — saves the user from typing.
                    setInputValue((prev) =>
                      prev.trim()
                        ? `${prev.trim()} I have experience with ${gap}. `
                        : `I have experience with ${gap}. `
                    );
                    textareaRef.current?.focus();
                  }}
                  className="text-[11px] font-medium text-orange-300 bg-orange-500/10 border border-orange-500/25 hover:bg-orange-500/20 hover:border-orange-400/50 hover:text-orange-200 rounded-full px-2.5 py-0.5 transition-colors cursor-pointer"
                  title={`Click to add "${gap}" to your message`}
                >
                  + {gap}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-gray-500 dark:text-gray-600 mt-0.5">
              Tap a keyword to add it to your message.
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Message list ─────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto scrollbar-hidden px-4 py-4 space-y-3 min-h-0">

        {/* Empty state */}
        {messages.length === 0 && !streamingContent && (
          <motion.div
            className="flex flex-col items-center justify-center h-full gap-3 text-center py-8"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.3 }}
          >
            <p className="text-sm text-gray-400 dark:text-gray-500">
              {isSpeechSupported
                ? 'Type or tap the mic to begin ↓'
                : 'Type your first message to begin ↓'}
            </p>
          </motion.div>
        )}

        {/* Committed message bubbles */}
        <AnimatePresence initial={false}>
          {messages.map((msg) => (
            <motion.div
              key={msg.id}
              layout
              initial={{ opacity: 0, y: 14, scale: 0.96 }}
              animate={{ opacity: 1, y: 0,  scale: 1 }}
              exit={{   opacity: 0 }}
              transition={{ type: 'spring', stiffness: 320, damping: 28 }}
              className={`flex gap-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              {msg.role === 'assistant' && (
                <div className="flex-shrink-0 w-6 h-6 rounded-full bg-gradient-to-br from-brand-400 to-brand-600 flex items-center justify-center mt-1">
                  <span className="text-xs">🐾</span>
                </div>
              )}
              <div className="max-w-[78%] flex flex-col gap-1">
                <div className={[
                  'px-4 py-2.5 text-sm leading-relaxed',
                  msg.role === 'user'
                    ? 'bg-brand-600 text-white rounded-2xl rounded-br-md ml-auto'
                    : 'bg-gray-100 text-gray-900 rounded-2xl rounded-bl-md',
                ].join(' ')}>
                  {msg.role === 'assistant'
                    ? <ReactMarkdown className="prose prose-sm prose-slate max-w-none">{msg.content}</ReactMarkdown>
                    : msg.content}
                </div>
                <span className={`text-[10px] text-gray-400 ${msg.role === 'user' ? 'text-right' : 'text-left'}`}>
                  {formatRelativeTime(msg.timestamp)}
                </span>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>

        {/* ── Phase 1: Thinking dots ─────────────────────────────────────
          Shown when generation has started but no tokens have arrived yet.
          `streamingContent === ''` is the "waiting" phase signal.
        ──────────────────────────────────────────────────────────────── */}
        <AnimatePresence>
          {isGenerating && streamingContent === '' && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="flex gap-2 justify-start"
            >
              <div className="flex-shrink-0 w-6 h-6 rounded-full bg-gradient-to-br from-brand-400 to-brand-600 flex items-center justify-center">
                <span className="text-xs">🐾</span>
              </div>
              <div className="bg-gray-100 rounded-2xl rounded-bl-md px-4 py-3 flex gap-1.5 items-center min-w-[80px]">
                {thinkingLabel ? (
                  /* Ghost keyword coaching — show contextual status text */
                  <motion.span
                    className="text-[11px] font-medium text-brand-500 leading-none"
                    animate={{ opacity: [0.6, 1, 0.6] }}
                    transition={{ repeat: Infinity, duration: 1.4 }}
                  >
                    {thinkingLabel}
                  </motion.span>
                ) : (
                  /* Default — bouncing dots */
                  [0, 1, 2].map((i) => (
                    <motion.span
                      key={i}
                      className="w-1.5 h-1.5 rounded-full bg-gray-400 inline-block"
                      animate={{ y: [0, -4, 0] }}
                      transition={{ repeat: Infinity, duration: 0.7, delay: i * 0.15 }}
                    />
                  ))
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Phase 2: Live streaming bubble ────────────────────────────
          Tokens arrive → fill this bubble in real-time with a blinking cursor.
          When `done` fires, this unmounts and a committed message takes over.
          Local state only — never touches the Zustand store.
        ──────────────────────────────────────────────────────────────── */}
        <AnimatePresence>
          {streamingContent && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="flex gap-2 justify-start"
            >
              <div className="flex-shrink-0 w-6 h-6 rounded-full bg-gradient-to-br from-brand-400 to-brand-600 flex items-center justify-center mt-1">
                <span className="text-xs">🐾</span>
              </div>
              <div className="max-w-[78%] bg-gray-100 text-gray-900 rounded-2xl rounded-bl-md px-4 py-2.5 text-sm leading-relaxed">
                <ReactMarkdown className="prose prose-sm prose-slate max-w-none inline">{streamingContent}</ReactMarkdown>
                {/* Blinking text cursor — signals the stream is still open */}
                <motion.span
                  className="inline-block w-0.5 h-4 bg-brand-400 ml-0.5 align-middle"
                  animate={{ opacity: [1, 0, 1] }}
                  transition={{ repeat: Infinity, duration: 0.8 }}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div ref={messagesEndRef} />
      </div>

      {/* ── Input bar ─────────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 px-4 py-3 border-t border-gray-100 dark:border-gray-800">

        {/* ── Voice capture banner ─────────────────────────────────────── */}
        {/*
          Appears above the input while the mic is active.
          Uses AnimatePresence so it slides in and out smoothly.
        */}
        <AnimatePresence>
          {isListening && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{   opacity: 0, height: 0 }}
              transition={{ duration: 0.2 }}
              className="mb-2 overflow-hidden"
            >
              <div className="flex items-center gap-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl px-3 py-2">
                {/* Animated red dot — universal "recording" signal */}
                <motion.span
                  className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0"
                  animate={{ opacity: [1, 0.3, 1] }}
                  transition={{ repeat: Infinity, duration: 0.8 }}
                />
                <span className="text-xs text-red-600 dark:text-red-400 font-medium">
                  Listening… speak now
                </span>
                <span className="ml-auto text-[10px] text-red-400 dark:text-red-500">
                  Tap mic or pause to stop
                </span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Main input row ────────────────────────────────────────────── */}
        <div className={[
          'flex items-end gap-2 rounded-2xl px-3 py-2 border transition-colors',
          isVoiceActive
            // Voice mode: red border to match the recording banner
            ? 'bg-red-50 dark:bg-red-900/10 border-red-300 dark:border-red-700'
            : 'bg-gray-50 dark:bg-gray-800/60 border-gray-100 dark:border-gray-700 focus-within:border-brand-400',
        ].join(' ')}>

          {/* ── Mic button ───────────────────────────────────────────── */}
          {/*
            Three visual states:
              • Not supported  → hidden (the button simply doesn't render)
              • Supported, idle → mic icon, brand colour
              • Listening       → mic-off icon, red, pulsing ring
              • Permission denied → mic icon with tooltip, muted colour
          */}
          {isSpeechSupported && (
            <div className="relative flex-shrink-0 mb-0.5">
              <motion.button
                onClick={handleMicToggle}
                disabled={currentStep === 'complete' || isGenerating}
                whileTap={{ scale: 0.85 }}
                title={
                  micPermissionDenied
                    ? 'Microphone access denied — enable it in browser settings'
                    : isListening
                    ? 'Stop recording'
                    : 'Start voice input'
                }
                className={[
                  'w-8 h-8 rounded-full flex items-center justify-center transition-colors',
                  isListening
                    ? 'bg-red-500 text-white shadow-md'
                    : micPermissionDenied
                    ? 'bg-gray-100 dark:bg-gray-700 text-gray-400 cursor-not-allowed'
                    : 'bg-brand-100 dark:bg-brand-900/40 text-brand-600 dark:text-brand-400 hover:bg-brand-200 dark:hover:bg-brand-900/60',
                ].join(' ')}
                aria-label={isListening ? 'Stop voice input' : 'Start voice input'}
                aria-pressed={isListening}
              >
                {isListening
                  ? <MicOff className="w-3.5 h-3.5" />
                  : <Mic    className="w-3.5 h-3.5" />
                }
              </motion.button>

              {/* Pulsing ring overlay — reinforces "hot mic" status */}
              <AnimatePresence>
                {isListening && (
                  <motion.span
                    className="absolute inset-0 rounded-full border-2 border-red-400 pointer-events-none"
                    initial={{ scale: 1, opacity: 0.8 }}
                    animate={{ scale: 1.7, opacity: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ repeat: Infinity, duration: 1.1, ease: 'easeOut' }}
                  />
                )}
              </AnimatePresence>
            </div>
          )}

          {/* ── Textarea ────────────────────────────────────────────── */}
          {/*
           * Height is managed entirely by the textareaRef + autogrow useEffect.
           * Do NOT add `style={{ height: 'auto' }}` here — React re-applies JSX
           * props on every render, which would reset the height to a single row
           * every time a streaming token arrives (each token causes a re-render).
           * The Send and Mic buttons stay pinned to the bottom via `items-end`
           * on the parent flex container, so they track the textarea's growth.
           */}
          <textarea
            ref={textareaRef}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              isListening
                ? 'Listening…'
                : "Type your answer…"
            }
            rows={1}
            disabled={currentStep === 'complete'}
            className={[
              'flex-1 bg-transparent resize-none text-sm outline-none',
              // overflow-y-auto: shows scrollbar only when content exceeds max-h-28
              // (i.e. when a very long voice transcript is dictated)
              'placeholder:text-gray-400 max-h-28 overflow-y-auto scrollbar-hidden leading-relaxed py-1',
              'disabled:opacity-50',
              // During voice capture, text appears in a warmer tone to reinforce
              // that it's being dictated (not manually typed)
              isVoiceActive
                ? 'text-red-700 dark:text-red-300'
                : 'text-gray-900 dark:text-gray-100',
            ].join(' ')}
          />

          {/* ── Send button ─────────────────────────────────────────── */}
          <motion.button
            whileTap={{ scale: 0.85 }}
            onClick={handleSend}
            disabled={!inputValue.trim() || isGenerating || currentStep === 'complete'}
            className="flex-shrink-0 w-8 h-8 rounded-full bg-brand-600 disabled:bg-gray-200 dark:disabled:bg-gray-700 flex items-center justify-center transition-colors mb-0.5"
            aria-label="Send message"
          >
            <Send className="w-3.5 h-3.5 text-white" />
          </motion.button>
        </div>

      </div>
    </div>
  );
};
