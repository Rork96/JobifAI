/**
 * components/onboarding/OnboardingFlow.tsx — The PLG Conversion Funnel
 * ─────────────────────────────────────────────────────────────────────────────
 * A four-step psychological onboarding wizard designed to convert cold visitors
 * into engaged users who WANT to pay.  The sequence is not arbitrary — each step
 * is a deliberate PLG (Product-Led Growth) conversion mechanic:
 *
 *   STEP 0 — PAIN DISCOVERY
 *     Ask the user how many applications they've sent with zero results.
 *
 *   STEP 1 — VILLAIN REVEAL
 *     Introduce ATS robots as the villain that's been working against them.
 *
 *   STEP 2 — THE FORK  ← Task 7: Now fully wired to the backend
 *     Two paths: upload existing resume OR start from scratch.
 *     Path A (upload) calls /api/upload-resume (PDF/DOCX/TXT parsing).
 *     The job field auto-detects URLs and calls /api/parse-job to scrape them.
 *
 *   STEP 3 — THE SHOCK (ATS Scan)
 *     A 3-second scanning animation followed by a devastatingly low score.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowRight,
  CheckCircle2,
  FileText,
  Link2,
  Loader2,
  Sparkles,
  Upload,
  Wand2,
  AlertTriangle,
  X,
} from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import { MacMascot } from '@/components/mascot/MacMascot';
import type { ATSAnalysisResponse } from '@/types';

// ── ATSAnalysisResponse runtime type guard ────────────────────────────────────
/**
 * Validates that an unknown API response matches the ATSAnalysisResponse
 * contract BEFORE it is written to the Zustand store.
 *
 * WHY a type guard instead of casting?
 *   `as ATSAnalysisResponse` silently accepts anything — a malformed backend
 *   response or a 200 OK with an error HTML body would corrupt the store and
 *   cause cryptic downstream failures.  This guard throws the problem back to
 *   the catch block where it belongs.
 */
function isATSAnalysisResponse(data: unknown): data is ATSAnalysisResponse {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.score             === 'number'  &&
    Array.isArray(d.foundKeywords)           &&
    Array.isArray(d.missingKeywords)         &&
    Array.isArray(d.contextualMatches)       &&
    typeof d.macMessage        === 'string'
  );
}

// ── Step slide animation preset ───────────────────────────────────────────────
const stepVariants = {
  enter:  { opacity: 0, x: 60,  scale: 0.97 },
  center: { opacity: 1, x: 0,   scale: 1    },
  exit:   { opacity: 0, x: -60, scale: 0.97 },
};

const stepTransition = { type: 'spring', stiffness: 300, damping: 28 };

// ── Pain options ──────────────────────────────────────────────────────────────
const PAIN_OPTIONS = [
  { label: '< 10 applications',  sub: 'Just getting started',    value: 'few'  },
  { label: '20 – 50 sent',       sub: 'Getting a bit frustrated', value: 'many' },
  { label: 'Lost count 😩',      sub: 'Way too many to count',   value: 'lots' },
] as const;

// ── Accepted file types for the file input ─────────────────────────────────────
const ACCEPTED_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
].join(',');

const ACCEPTED_EXTENSIONS = '.pdf,.docx,.txt';

// ── URL detection helper ──────────────────────────────────────────────────────
const looksLikeUrl = (s: string) =>
  /^https?:\/\//i.test(s.trim());

// ── Props ─────────────────────────────────────────────────────────────────────
interface OnboardingFlowProps {
  onComplete: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────
export const OnboardingFlow: React.FC<OnboardingFlowProps> = ({ onComplete }) => {

  // ── Wizard navigation state ───────────────────────────────────────────────
  const [step,         setStep]         = useState(0);

  // ── Step 2 form state ─────────────────────────────────────────────────────
  const [resumeText,   setResumeText]   = useState('');
  const [jobInput,     setJobInput]     = useState('');  // URL or pasted text
  const [isDragging,   setIsDragging]   = useState(false);

  // ── Step 2: "Start from Scratch" sub-form ─────────────────────────────────
  // When the user picks "scratch", we show a brief target-job prompt before
  // advancing to step 3.  This gives Mac the JD context it needs for tailored
  // interview questions even when there's no existing resume to score.
  const [showScratchSubForm, setShowScratchSubForm] = useState(false);
  const [scratchJobInput,    setScratchJobInput]    = useState('');

  // ── Step 3: skip button after timeout ─────────────────────────────────────
  // If the API hasn't responded after 8 s, surface an escape hatch.
  const [showSkipButton, setShowSkipButton] = useState(false);

  // ── Upload loading + result state ─────────────────────────────────────────
  // Separate loading flags so Mac shows processing for both independently.
  const [isParsingFile,    setIsParsingFile]    = useState(false);
  const [isParsingJob,     setIsParsingJob]     = useState(false);
  const [isScratchFetching,   setIsScratchFetching]   = useState(false);
  // True while POST /api/analyze runs at the end of the scratch sub-form.
  // Blocks the "Start building" button and shows "Evaluating…" so the user
  // doesn't slam the button multiple times during the async call.
  const [isScratchEvaluating, setIsScratchEvaluating] = useState(false);
  const [fileError,     setFileError]     = useState('');
  const [jobError,      setJobError]      = useState('');
  const [uploadedFilename, setUploadedFilename] = useState('');
  const [jobFetchedTitle,  setJobFetchedTitle]  = useState('');
  const [jobFetchedText,   setJobFetchedText]   = useState('');

  // ── Paste fallback — shown when a URL scrape returns success=false ──────────
  // When the site blocks our scraper (403, CAPTCHA, login wall), we flip this
  // flag and render a dedicated frosted-glass textarea so the user can paste
  // the JD manually without having to clear the URL and start over.
  const [showPasteFallback, setShowPasteFallback] = useState(false);
  const [jdPasteText,       setJdPasteText]       = useState('');

  // ── Hidden file input ref ─────────────────────────────────────────────────
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Step 3 scan animation state ───────────────────────────────────────────
  const [scanProgress,  setScanProgress]  = useState(0);
  const [scanComplete,  setScanComplete]  = useState(false);
  const [scoreCount,    setScoreCount]    = useState(0);
  const scanIntervalRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const scoreIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Zustand store actions ─────────────────────────────────────────────────
  const setOnboardingMode     = useAppStore((s) => s.setOnboardingMode);
  const setUploadedResumeText = useAppStore((s) => s.setUploadedResumeText);
  const setJobDescription     = useAppStore((s) => s.setJobDescription);
  const setRealAtsScore       = useAppStore((s) => s.setRealAtsScore);
  const setSkillGaps          = useAppStore((s) => s.setSkillGaps);
  const setMatchedSkills      = useAppStore((s) => s.setMatchedSkills);
  const setMissingSkills      = useAppStore((s) => s.setMissingSkills);
  const transitionTo          = useAppStore((s) => s.transitionTo);
  const onboardingMode        = useAppStore((s) => s.onboardingMode);
  const storeResumeText       = useAppStore((s) => s.uploadedResumeText);
  const storeJobDescription   = useAppStore((s) => s.jobDescription);

  // ── Atomic analysis state (Task 19 Iron Logic) ───────────────────────────
  const isAnalyzing      = useAppStore((s) => s.isAnalyzing);
  const analysisError    = useAppStore((s) => s.analysisError);
  const analysisResult   = useAppStore((s) => s.analysisResult);
  const setIsAnalyzing   = useAppStore((s) => s.setIsAnalyzing);
  const setAnalysisError = useAppStore((s) => s.setAnalysisError);
  const setAnalysisResult= useAppStore((s) => s.setAnalysisResult);

  // ── Step 3: real ATS score (API call) ─────────────────────────────────────
  // Runs when step 3 starts in 'upload' mode.
  // Concurrently with the 3-second scan animation so latency is hidden.
  // apiScore / apiGaps are bridge state for the existing step-3 UI.
  // They are populated by handleAnalyze (below) from analysisResult — no
  // useEffect polling, no fake timeouts.
  const [apiScore, setApiScore] = useState<number | null>(null);
  const [apiGaps,  setApiGaps]  = useState<string[]>([]);

  // ── Step 3: ATS scan animation ─────────────────────────────────────────────
  useEffect(() => {
    if (step !== 3) return;

    let progress = 0;
    scanIntervalRef.current = setInterval(() => {
      progress += 100 / (3000 / 30);
      setScanProgress(Math.min(progress, 100));
      if (progress >= 100) {
        clearInterval(scanIntervalRef.current!);
        setScanComplete(true);
      }
    }, 30);

    return () => { if (scanIntervalRef.current) clearInterval(scanIntervalRef.current); };
  }, [step]);

  // ── Step 3: count-up animation toward real score ───────────────────────────
  // Waits for BOTH the 3-second scan AND the API result before animating.
  // For 'scratch' mode there's no resume → use the static 78.
  useEffect(() => {
    if (!scanComplete) return;
    const isUpload = onboardingMode !== 'scratch';
    if (isUpload && apiScore === null) return;   // still waiting for API

    const TARGET = isUpload ? apiScore! : 78;
    let count = 0;
    scoreIntervalRef.current = setInterval(() => {
      count += 2;
      setScoreCount(Math.min(count, TARGET));
      if (count >= TARGET) clearInterval(scoreIntervalRef.current!);
    }, 25);
    return () => { if (scoreIntervalRef.current) clearInterval(scoreIntervalRef.current); };
  }, [scanComplete, onboardingMode, apiScore]);

  // ── Step 3: skip button after 8-second timeout ────────────────────────────
  // If the API is still pending after 8 s, show an escape hatch so the user
  // isn't stranded at 0%.  The timer starts when scan completes but API hasn't.
  useEffect(() => {
    if (!(onboardingMode !== 'scratch' && scanComplete && apiScore === null)) {
      setShowSkipButton(false);
      return;
    }
    const t = setTimeout(() => setShowSkipButton(true), 8000);
    return () => clearTimeout(t);
  }, [onboardingMode, scanComplete, apiScore]);

  // ── Score-based colour helpers ─────────────────────────────────────────────
  const displayScore    = onboardingMode === 'scratch' ? scoreCount : (apiScore ?? scoreCount);
  // Score colour system — Danger / Warning / Success (matches global spec)
  const scoreColorClass =
    displayScore < 40  ? 'text-red-400' :
    displayScore < 70  ? 'text-amber-400' :
                         'text-emerald-400';
  const scoreLabelClass =
    displayScore < 40  ? 'text-red-400' :
    displayScore < 70  ? 'text-amber-400' :
                         'text-emerald-400';

  // ── Mascot state ───────────────────────────────────────────────────────────
  // Transitions through processing → shocked/processing/success once score arrives.
  const mascotState: import('@/types').MascotState =
    (isParsingFile || isParsingJob || isAnalyzing)                ? 'processing' :
    step === 3 && !scanComplete                                    ? 'processing' :
    step === 3 && scanComplete && onboardingMode !== 'scratch' && apiScore === null ? 'processing' :
    step === 3 && scanComplete && onboardingMode !== 'scratch' && displayScore < 40  ? 'shocked' :
    step === 3 && scanComplete && onboardingMode !== 'scratch' && displayScore < 70  ? 'processing' :
    step === 3 && scanComplete && onboardingMode !== 'scratch' && displayScore >= 70 ? 'success' :
    step === 3 && scanComplete && onboardingMode === 'scratch'                        ? 'success' :
    'idle';

  // ── Step advance ───────────────────────────────────────────────────────────
  const advanceTo = useCallback((nextStep: number) => setStep(nextStep), []);

  const handlePainChoice = useCallback(() => {
    setTimeout(() => advanceTo(1), 380);
  }, [advanceTo]);

  const handleForkScratch = useCallback(() => {
    setOnboardingMode('scratch');
    setShowScratchSubForm(true);  // Stay on step 2, show sub-form
  }, [setOnboardingMode]);

  // Called when user submits the scratch sub-form.
  // If the input is a URL, auto-fetch it so the store receives real JD text.
  // If the store already contains resume data (e.g. from a prior session),
  // we run a full /api/analyze call before transitioning to the paywall so
  // the score shown is real rather than 0.
  const handleScratchSubmit = useCallback(async () => {
    const raw = scratchJobInput.trim();
    if (!raw) return;

    // ── Step 1: resolve JD text ───────────────────────────────────────────────
    let finalJd = raw;
    if (looksLikeUrl(raw)) {
      setIsScratchFetching(true);
      try {
        const res  = await fetch('/api/parse-job', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ url: raw }),
        });
        const data = await res.json();
        finalJd = (data.success && data.text) ? data.text : raw;
      } catch {
        finalJd = raw;  // fall back to raw URL text on network error
      } finally {
        setIsScratchFetching(false);
      }
    }
    setJobDescription(finalJd);

    // ── Step 2: evaluate if we have resume data ───────────────────────────────
    // For scratch users who have resume content in the store (structured data
    // from a prior interview or an uploaded draft), run /api/analyze so the
    // paywall shows a real score instead of 0/100.
    // The guard (length >= 10) ensures we don't send an empty payload.
    const storeState   = useAppStore.getState();
    const resumeSource =
      storeState.uploadedResumeText?.trim() ||
      (() => {
        const json = JSON.stringify(storeState.resumeData || {});
        return json === '{}' ? '' : json;
      })();

    if (resumeSource.length >= 10 && finalJd.length >= 10) {
      setIsScratchEvaluating(true);
      try {
        const res = await fetch('/api/analyze', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            resume_text:     resumeSource,
            job_description: finalJd,
          }),
        });

        if (res.ok) {
          const data: unknown = await res.json();
          if (isATSAnalysisResponse(data)) {
            // ── Single atomic store write (scratch path) ──────────────────
            // All score-adjacent fields land in ONE setState so no component
            // can render with analysisResult set but currentAtsScore still 0.
            const gap   = Math.max(0, 100 - data.score);
            const count = Math.max(data.missingKeywords.length, 1);
            useAppStore.setState({
              analysisResult:  data,
              currentAtsScore: data.score,
              realAtsScore:    data.score,
              skillGaps:       data.missingKeywords,
              matchedSkills:   data.foundKeywords,
              missingSkills:   data.missingKeywords.map((kw, i) => ({
                skill:             kw,
                impact_percentage: Math.max(2, Math.round(gap / count) - i),
              })),
            });
            console.log('[Store] ATS Score Sync (scratch submit):', data.score);
          }
        }
      } catch {
        // Silent — evaluation failure must not block the transition.
        // The paywall will show a 0/100 score, which is honest for a blank resume.
      } finally {
        // ── Step 4: disable loading, THEN transition ──────────────────────────
        setIsScratchEvaluating(false);
      }
    }

    // ── Step 5: activate BUILDING workspace + enter paywall ──────────────────
    // transitionTo('BUILDING') sets appStatus: 'BUILDING' so MainLayout renders
    // the SCRATCH workspace (Ghost Sections, step-based Mac coaching) instead
    // of the OPTIMIZE workspace.  Must be called BEFORE onComplete() so the
    // workspace is fully configured when the PaywallModal overlay unmounts.
    transitionTo('BUILDING');
    setShowScratchSubForm(false);
    onComplete();
  }, [scratchJobInput, setJobDescription, transitionTo, onComplete]);

  // ── Upload resume via backend API ──────────────────────────────────────────
  /**
   * Sends a File object to POST /api/upload-resume as multipart form data.
   *
   * On success: populates the resume textarea with the extracted text
   *             and shows a "✓ filename.pdf — N characters" success banner.
   *
   * On failure: shows the backend's user-facing error message.
   *             The drag-drop zone remains active so the user can try again.
   */
  const uploadFile = useCallback(async (file: File) => {
    // Clear previous results before starting a new upload
    setFileError('');
    setUploadedFilename('');
    setResumeText('');
    setIsParsingFile(true);

    try {
      const formData = new FormData();
      formData.append('file', file);

      const res = await fetch('/api/upload-resume', {
        method: 'POST',
        body: formData,
        // Note: Do NOT set Content-Type header — the browser must set it
        // automatically so it includes the multipart boundary parameter.
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        // Backend returns { detail: "user-facing message" } on 4xx/5xx
        const msg = data.detail ?? `Upload failed (HTTP ${res.status}).`;
        setFileError(msg);
        return;
      }

      const data: { text: string; filename: string; char_count: number } = await res.json();
      setResumeText(data.text);
      setUploadedFilename(`${data.filename} — ${data.char_count.toLocaleString()} characters extracted`);

    } catch (err) {
      // Network error (backend not running, CORS, etc.)
      setFileError(
        'Could not connect to the server. '
        + 'Please check your connection or paste your resume text directly.'
      );
    } finally {
      setIsParsingFile(false);
    }
  }, []);

  // ── Drag-and-drop handlers ─────────────────────────────────────────────────
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    uploadFile(file);
  }, [uploadFile]);

  // ── File input change (click to browse) ──────────────────────────────────
  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset the input value so selecting the same file again triggers onChange
    e.target.value = '';
    uploadFile(file);
  }, [uploadFile]);

  // ── Fetch job description from URL ─────────────────────────────────────────
  /**
   * Calls POST /api/parse-job with the URL from the job input field.
   *
   * On success: sets `jobFetchedText` and `jobFetchedTitle` so the UI
   *             shows a "✓ fetched from LinkedIn" confirmation.
   *
   * On failure: shows `response.error_hint` (e.g. "LinkedIn blocks automated
   *             access — please paste the text"). The input remains editable
   *             so the user can paste raw text after the URL.
   *
   * WHY send the URL to the backend instead of fetching client-side?
   *   CORS policy prevents browsers from fetching arbitrary third-party URLs
   *   from JavaScript.  The backend acts as a same-origin proxy.
   */
  const handleJobFetch = useCallback(async () => {
    if (!jobInput.trim()) return;

    setJobError('');
    setJobFetchedTitle('');
    setJobFetchedText('');
    setShowPasteFallback(false);
    setJdPasteText('');
    setIsParsingJob(true);

    try {
      const res = await fetch('/api/parse-job', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          looksLikeUrl(jobInput)
            ? { url: jobInput.trim() }
            : { text: jobInput.trim() }
        ),
      });

      const data: {
        success: boolean;
        text: string;
        title: string;
        source: string;
        error_hint: string;
        char_count: number;
      } = await res.json();

      if (data.success && data.text) {
        setJobFetchedText(data.text);
        setJobFetchedTitle(data.title || (data.source === 'text' ? 'Pasted text' : 'Job posting'));
      } else {
        // Backend returned success=false (blocked site, login wall, etc.)
        // If the user supplied a URL (not raw text), show the paste fallback
        // textarea instead of just an error message — it's a much better UX.
        if (looksLikeUrl(jobInput)) {
          setShowPasteFallback(true);
        } else {
          setJobError(data.error_hint || 'Could not process the job description.');
        }
      }

    } catch {
      // Network error — show paste fallback if it was a URL attempt
      if (looksLikeUrl(jobInput)) {
        setShowPasteFallback(true);
      } else {
        setJobError(
          'Could not connect to the server. '
          + 'Please check your connection or paste the job text directly.'
        );
      }
    } finally {
      setIsParsingJob(false);
    }
  }, [jobInput]);

  // ── Strict analysis fetch (Iron Logic — Task 19) ──────────────────────────
  /**
   * handleAnalyze — the single entry-point for the onboarding → workspace flow.
   *
   * Implements the exact algorithm from the Task 19 spec:
   *
   *   1. GUARD      If either text input is empty, return early (no side-effects).
   *   2. RESET      Clear any prior error/result and set isAnalyzing=true.
   *                 This atomically triggers the Step 3 loading screen.
   *   3. COMMIT     Write resume text + JD to the Zustand store so all
   *                 downstream consumers (ChatPanel, DocumentPreview) have them.
   *   4. ADVANCE    Navigate to Step 3 (scan animation plays concurrently).
   *   5. FETCH      Await POST /api/analyze — single round-trip.
   *   6. TYPE GUARD Validate the response with isATSAnalysisResponse().
   *                 A malformed response is treated as a failure (goes to catch).
   *   7. SUCCESS    Populate the atomic analysisResult + legacy bridge state.
   *                 The Step 3 "proceed" button becomes active after this.
   *   8. CATCH      Set analysisError — user stays on Step 3, button blocked.
   *   9. FINALLY    setIsAnalyzing(false) — always, even on error.
   */
  const handleAnalyze = useCallback(async () => {
    // Priority order for job description text (same logic as before):
    //   1. Paste-fallback textarea (URL was blocked, user pasted manually)
    //   2. Auto-fetched text from a URL via /api/parse-job
    //   3. Raw text typed/pasted directly into the input field
    const finalJobText = (showPasteFallback ? jdPasteText : undefined)
      ?? jobFetchedText
      ?? jobInput.trim();

    // ── 1. GUARD ─────────────────────────────────────────────────────────────
    if (!resumeText.trim() || !finalJobText.trim()) return;

    // ── 2. RESET (atomic — one set() call to avoid intermediate renders) ─────
    useAppStore.setState({ analysisError: null, analysisResult: null });
    setIsAnalyzing(true);

    // ── 3. COMMIT ─────────────────────────────────────────────────────────────
    setUploadedResumeText(resumeText);
    setJobDescription(finalJobText);

    // ── 4. ADVANCE — show the scan animation immediately ─────────────────────
    advanceTo(3);

    try {
      // ── 5. FETCH ───────────────────────────────────────────────────────────
      const res = await fetch('/api/analyze', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resume_text:     resumeText,
          job_description: finalJobText,
        }),
      });

      if (!res.ok) {
        // Extract the backend's `detail` field so the user sees the real error
        // (e.g. "LLM Response Truncated") instead of a generic message.
        let detail = `Analysis failed (HTTP ${res.status}).`;
        try {
          const errBody = await res.json();
          if (typeof errBody?.detail === 'string' && errBody.detail.trim()) {
            detail = errBody.detail;
          }
        } catch { /* json parse failed — use fallback message */ }
        throw new Error(detail);
      }

      const data: unknown = await res.json();

      // ── 6. TYPE GUARD — reject any response that breaks the contract ────────
      if (!isATSAnalysisResponse(data)) {
        throw new Error('Response did not match ATSAnalysisResponse contract');
      }

      // ── 7. SUCCESS — single atomic Zustand write ─────────────────────────
      // ALL score-adjacent fields are written in ONE useAppStore.setState()
      // so no component ever renders with analysisResult set but
      // currentAtsScore still at 0.  This kills the Zero Score bug.
      const gap   = Math.max(0, 100 - data.score);
      const count = Math.max(data.missingKeywords.length, 1);
      useAppStore.setState({
        analysisResult:  data,
        currentAtsScore: data.score,   // ← THE canonical score, written here
        realAtsScore:    data.score,
        skillGaps:       data.missingKeywords,
        matchedSkills:   data.foundKeywords,
        missingSkills:   data.missingKeywords.map((kw, i) => ({
          skill:             kw,
          impact_percentage: Math.max(2, Math.round(gap / count) - i),
        })),
      });
      console.log('[Store] ATS Score Sync (handleAnalyze):', data.score);

      // Bridge: keep legacy local state for the Step-3 scan animation.
      // These drive scoreCount / apiScore in the onboarding UI only.
      setApiScore(data.score);
      setApiGaps(data.missingKeywords);

    } catch (err) {
      // ── 8. CATCH — set error, do NOT advance to workspace ──────────────────
      // Surface the real backend error (e.g. "LLM Response Truncated") so the
      // user sees something actionable, not a generic fallback string.
      const msg = err instanceof Error ? err.message : 'Analysis failed. Please try again.';
      console.error('[OnboardingFlow] handleAnalyze error:', msg);
      setAnalysisError(msg);
    } finally {
      // ── 9. FINALLY — always unblock the UI ──────────────────────────────────
      setIsAnalyzing(false);
    }
  }, [
    resumeText, jobInput, jobFetchedText, jdPasteText, showPasteFallback,
    setUploadedResumeText, setJobDescription,
    setIsAnalyzing, setAnalysisError, advanceTo,
  ]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 bg-slate-50 flex flex-col items-center justify-center overflow-hidden">

      {/* Radial gradient background — warm orange tint from top */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: 'radial-gradient(ellipse 80% 60% at 50% -10%, rgba(251,146,60,0.12) 0%, transparent 70%)',
        }}
      />

      {/* Step dots */}
      <div className="absolute top-6 left-1/2 -translate-x-1/2 flex gap-2 z-10">
        {[0, 1, 2, 3].map((i) => (
          <motion.div
            key={i}
            className="rounded-full"
            animate={{
              width: i === step ? 24 : 6,
              backgroundColor: i === step
                ? 'rgb(249 115 22)'   // orange-500
                : i < step
                  ? 'rgb(203 213 225)' // slate-300 — completed
                  : 'rgb(226 232 240)', // slate-200 — future
            }}
            transition={{ type: 'spring', stiffness: 380, damping: 28 }}
            style={{ height: 6 }}
          />
        ))}
      </div>

      {/* ── Step content ──────────────────────────────────────────────────── */}
      <div className="w-full max-w-lg px-5 relative z-10">
        <AnimatePresence mode="wait">

          {/* ─────────────────────────────────────────────────────────────
              STEP 0 — PAIN DISCOVERY
          ─────────────────────────────────────────────────────────────── */}
          {step === 0 && (
            <motion.div
              key="step-0"
              variants={stepVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={stepTransition}
              className="flex flex-col items-center gap-6 text-center"
            >
              {/* Larger mascot — 160px video circle */}
              <div className="flex flex-col items-center gap-2">
                <div className="w-40 h-40 rounded-full overflow-hidden ring-4 ring-orange-400/20 shadow-2xl shadow-orange-400/10">
                  <video autoPlay loop muted playsInline src="/mascot/idle.webm"
                    className="w-full h-full object-cover" />
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-semibold text-gray-700">Mac</span>
                  <span className="text-xs text-gray-400">· AI Co-pilot</span>
                  <span className="w-1.5 h-1.5 rounded-full bg-green-400 inline-block" />
                </div>
              </div>

              <div>
                <h1 className="text-2xl font-bold text-gray-900 leading-tight">
                  Hi, I'm Mac! Let's build your
                  <span className="text-orange-500"> perfect resume.</span>
                </h1>
                <p className="mt-2 text-sm text-gray-500">
                  How many applications have you sent with zero interviews?
                </p>
                <p className="text-xs text-gray-400 mt-0.5">No judgment. We've all been there.</p>
              </div>

              <div className="w-full flex flex-col gap-3">
                {PAIN_OPTIONS.map((opt) => (
                  <PainOptionCard
                    key={opt.value}
                    label={opt.label}
                    sub={opt.sub}
                    onClick={handlePainChoice}
                  />
                ))}
              </div>
            </motion.div>
          )}

          {/* ─────────────────────────────────────────────────────────────
              STEP 1 — VILLAIN REVEAL
          ─────────────────────────────────────────────────────────────── */}
          {step === 1 && (
            <motion.div
              key="step-1"
              variants={stepVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={stepTransition}
              className="flex flex-col items-center gap-7 text-center"
            >
              {/* Mac reacts to the bad news — listening state */}
              <MacMascot currentStep="idle" state={mascotState} />

              <div>
                <motion.p
                  className="text-xs font-bold uppercase tracking-[0.2em] text-orange-500 mb-2"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.2 }}
                >
                  The culprit
                </motion.p>
                <h1 className="text-2xl font-bold text-gray-900 leading-tight">
                  It's not you.<br />
                  <span className="text-red-500">It's the ATS robots.</span>
                </h1>
              </div>

              <motion.div
                className="w-full bg-white border border-gray-200 rounded-2xl p-5 text-left space-y-3 shadow-sm"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3, type: 'spring', stiffness: 260, damping: 24 }}
              >
                {[
                  { icon: '🤖', stat: '99% of Fortune 500', detail: 'companies use ATS software to screen resumes' },
                  { icon: '🗑️', stat: '74% of resumes',     detail: 'are rejected before a human ever reads them' },
                  { icon: '⚡',  stat: '< 7 seconds',        detail: 'is how long a recruiter scans a resume that does pass' },
                ].map(({ icon, stat, detail }) => (
                  <div key={stat} className="flex items-start gap-3">
                    <span className="text-xl flex-shrink-0 mt-0.5">{icon}</span>
                    <div>
                      <span className="text-sm font-bold text-gray-900">{stat} </span>
                      <span className="text-sm text-gray-500">{detail}</span>
                    </div>
                  </div>
                ))}
              </motion.div>

              <motion.button
                onClick={() => advanceTo(2)}
                whileTap={{ scale: 0.96 }}
                className="w-full bg-gradient-to-r from-orange-500 to-amber-500 text-white font-semibold py-3.5 rounded-2xl shadow-lg shadow-orange-500/25 flex items-center justify-center gap-2"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.5 }}
              >
                Show me how to beat them
                <ArrowRight className="w-4 h-4" />
              </motion.button>

              <motion.button
                onClick={() => advanceTo(0)}
                className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.6 }}
              >
                ← Go back
              </motion.button>
            </motion.div>
          )}

          {/* ─────────────────────────────────────────────────────────────
              STEP 2 — THE FORK
              (Task 7: upload path now calls /api/upload-resume + /api/parse-job)
          ─────────────────────────────────────────────────────────────── */}
          {step === 2 && (
            <motion.div
              key="step-2"
              variants={stepVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={stepTransition}
              className="flex flex-col gap-5"
            >
              <div className="text-center">
                <h1 className="text-2xl font-bold text-gray-900">How do you want to start?</h1>
                <p className="mt-1.5 text-sm text-gray-500">Mac adapts to your situation.</p>
              </div>

              {onboardingMode !== 'upload' ? (
                /* ── Initial fork choice ──────────────────────────────── */
                <div className="flex flex-col gap-3">
                  <motion.button
                    onClick={() => setOnboardingMode('upload')}
                    whileTap={{ scale: 0.98 }}
                    className="w-full bg-white border border-gray-200 rounded-2xl p-5 text-left hover:border-orange-400/60 hover:bg-orange-50/50 transition-all group shadow-sm"
                    initial={{ opacity: 0, x: -12 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.1 }}
                  >
                    <div className="flex items-start gap-4">
                      <div className="w-11 h-11 rounded-xl bg-orange-500/10 border border-orange-500/20 flex items-center justify-center flex-shrink-0 group-hover:bg-orange-500/20 transition-colors">
                        <FileText className="w-5 h-5 text-orange-500" />
                      </div>
                      <div>
                        <p className="font-semibold text-gray-900">I have a resume draft</p>
                        <p className="text-sm text-gray-500 mt-0.5">
                          Mac will score it, rewrite weak bullets, and tailor it to a job description.
                        </p>
                      </div>
                      <ArrowRight className="w-4 h-4 text-gray-400 flex-shrink-0 mt-3 ml-auto group-hover:text-orange-500 group-hover:translate-x-0.5 transition-all" />
                    </div>
                  </motion.button>

                  {!showScratchSubForm ? (
                    <motion.button
                      onClick={handleForkScratch}
                      whileTap={{ scale: 0.98 }}
                      className="w-full bg-white border border-gray-200 rounded-2xl p-5 text-left hover:border-brand-400/60 hover:bg-brand-50/30 transition-all group shadow-sm"
                      initial={{ opacity: 0, x: -12 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 0.2 }}
                    >
                      <div className="flex items-start gap-4">
                        <div className="w-11 h-11 rounded-xl bg-brand-500/10 border border-brand-500/20 flex items-center justify-center flex-shrink-0 group-hover:bg-brand-500/20 transition-colors">
                          <Sparkles className="w-5 h-5 text-brand-500" />
                        </div>
                        <div>
                          <p className="font-semibold text-gray-900">Start from scratch</p>
                          <p className="text-sm text-gray-500 mt-0.5">
                            Mac will interview you in a natural conversation and build your resume from zero.
                          </p>
                          <span className="inline-block mt-1.5 text-[10px] font-bold uppercase tracking-wider text-emerald-600 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5">
                            Recommended
                          </span>
                        </div>
                        <ArrowRight className="w-4 h-4 text-gray-400 flex-shrink-0 mt-3 ml-auto group-hover:text-brand-500 group-hover:translate-x-0.5 transition-all" />
                      </div>
                    </motion.button>
                  ) : (
                    /* ── Scratch sub-form: target job context ─────────────────
                       Collecting a target title or URL gives Mac the JD context
                       it needs to tailor questions from the very first message.
                    ────────────────────────────────────────────────────────── */
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="w-full bg-white border border-brand-500/30 rounded-2xl p-5 flex flex-col gap-4 shadow-sm"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-xl bg-brand-500/15 flex items-center justify-center flex-shrink-0">
                          <Sparkles className="w-4 h-4 text-brand-400" />
                        </div>
                        <div>
                          <p className="font-semibold text-gray-900 text-sm">What role are you targeting?</p>
                          <p className="text-xs text-gray-500 mt-0.5">
                            Paste a job URL or type a title — Mac will tailor every question to it.
                          </p>
                        </div>
                      </div>

                      <textarea
                        value={scratchJobInput}
                        onChange={(e) => setScratchJobInput(e.target.value)}
                        placeholder="Paste the full job description here, or a URL (https://…)"
                        rows={5}
                        autoFocus
                        className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3.5 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 outline-none focus:border-brand-500/60 resize-none transition-colors scrollbar-hidden"
                      />
                      {scratchJobInput.trim().length > 0 && (
                        <p className="text-[11px] text-gray-400 -mt-2 text-right">
                          {scratchJobInput.trim().length.toLocaleString()} chars
                        </p>
                      )}

                      <button
                        onClick={handleScratchSubmit}
                        disabled={!scratchJobInput.trim() || isScratchFetching || isScratchEvaluating}
                        className="w-full bg-gradient-to-r from-brand-600 to-brand-700 hover:from-brand-500 hover:to-brand-600 disabled:from-gray-200 disabled:to-gray-200 disabled:text-gray-400 text-white font-semibold text-sm py-2.5 rounded-xl transition-all flex items-center justify-center gap-1.5"
                      >
                        {(isScratchFetching || isScratchEvaluating) && (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        )}
                        {!isScratchFetching && !isScratchEvaluating && (
                          <Sparkles className="w-3.5 h-3.5" />
                        )}
                        {isScratchFetching   ? 'Fetching job description…' :
                         isScratchEvaluating ? 'Evaluating your resume…'   :
                                               'Start building →'}
                      </button>

                      <button
                        onClick={() => { setShowScratchSubForm(false); setOnboardingMode('scratch'); }}
                        className="text-xs text-gray-400 hover:text-gray-600 transition-colors text-center"
                      >
                        ← Go back
                      </button>
                    </motion.div>
                  )}
                </div>
              ) : (
                /* ── Path A expanded: upload + JD form ───────────────────
                   Task 7 changes in this block:
                   1. Drop zone now accepts PDF + DOCX (calls /api/upload-resume)
                   2. "Browse files" button triggers hidden file input
                   3. Success banner shows extracted filename + char count
                   4. Job input auto-detects URLs → shows "Fetch" button
                   5. Mac enters processing state during API calls
                ─────────────────────────────────────────────────────────── */
                <motion.div
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex flex-col gap-4"
                >
                  {/* ── Mac processes loading state ───────────────────────── */}
                  <AnimatePresence>
                    {(isParsingFile || isParsingJob) && (
                      <motion.div
                        initial={{ opacity: 0, y: -8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -8 }}
                        className="flex items-center justify-center gap-3 py-3"
                      >
                        <MacMascot currentStep="idle" state="processing" />
                        <span className="text-sm text-gray-500">
                          {isParsingFile ? 'Extracting text from your file…' : 'Fetching job description…'}
                        </span>
                      </motion.div>
                    )}
                  </AnimatePresence>

                  {/* ── Resume upload zone ─────────────────────────────────── */}
                  {/* Hidden file input — triggered by clicking the drop zone or the "Browse files" button */}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={ACCEPTED_EXTENSIONS}
                    className="sr-only"
                    onChange={handleFileInputChange}
                  />

                  <div
                    onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                    onDragLeave={() => setIsDragging(false)}
                    onDrop={handleDrop}
                    onClick={() => fileInputRef.current?.click()}
                    className={[
                      'w-full rounded-2xl border-2 border-dashed p-5 text-center transition-all cursor-pointer',
                      isParsingFile
                        ? 'border-orange-400/50 bg-orange-500/5 pointer-events-none'
                        : isDragging
                          ? 'border-orange-400 bg-orange-500/10'
                          : uploadedFilename
                            ? 'border-emerald-500/40 bg-emerald-500/5 hover:bg-emerald-500/10'
                            : 'border-gray-300 hover:border-orange-400 bg-gray-50 hover:bg-orange-50/30',
                    ].join(' ')}
                  >
                    {isParsingFile ? (
                      <div className="flex flex-col items-center gap-2">
                        <Loader2 className="w-5 h-5 text-orange-400 animate-spin" />
                        <p className="text-xs text-gray-500">Parsing your resume…</p>
                      </div>
                    ) : uploadedFilename ? (
                      /* Success state — show filename + character count */
                      <div className="flex items-center justify-center gap-2">
                        <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                        <p className="text-xs text-emerald-400 font-medium truncate">{uploadedFilename}</p>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setUploadedFilename('');
                            setResumeText('');
                          }}
                          className="ml-1 text-gray-400 hover:text-gray-600 transition-colors flex-shrink-0"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ) : (
                      /* Default state */
                      <>
                        <Upload className="w-5 h-5 text-gray-400 mx-auto mb-1.5" />
                        <p className="text-xs text-gray-500">
                          Drop your resume here or{' '}
                          <span className="text-orange-500 font-medium">browse files</span>
                        </p>
                        <p className="text-[10px] text-gray-400 mt-0.5">
                          PDF, DOCX, or TXT · Max 5 MB
                        </p>
                      </>
                    )}
                  </div>

                  {/* File parse error */}
                  <AnimatePresence>
                    {fileError && (
                      <motion.div
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        className="flex items-start gap-2 bg-red-500/10 border border-red-500/25 rounded-xl px-3 py-2.5"
                      >
                        <AlertTriangle className="w-4 h-4 text-red-400 mt-0.5 flex-shrink-0" />
                        <p className="text-xs text-red-300">{fileError}</p>
                      </motion.div>
                    )}
                  </AnimatePresence>

                  {/* ── Resume text area (always shown; pre-filled after upload) ── */}
                  <div className="flex flex-col gap-1">
                    <label className="text-[11px] font-semibold uppercase tracking-wider text-orange-400">
                      Your Current Resume
                    </label>
                    <textarea
                      value={resumeText}
                      onChange={(e) => setResumeText(e.target.value)}
                      placeholder={uploadedFilename ? 'Extracted text from your file…' : 'Or paste your resume text here…'}
                      rows={5}
                      className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 resize-none outline-none focus:border-orange-500/60 transition-colors scrollbar-hidden"
                    />
                  </div>

                  {/* ── Job description field ────────────────────────────────
                      Smart input:
                      - When the value looks like a URL, show a "Fetch →" button
                        that calls /api/parse-job to scrape the posting.
                      - When raw text is pasted (no http://), the same fetch
                        button normalises it through the backend.
                      - After a successful fetch, the fetched title + a ✓ badge
                        replace the fetch button, and the fetched text is stored
                        in state (committed to store on submit).
                  ──────────────────────────────────────────────────────────── */}
                  <div className="flex flex-col gap-1">
                    <label className="text-[11px] font-semibold uppercase tracking-wider text-orange-500">
                      Target Job Description <span className="text-red-400">*</span>
                    </label>

                    {/* Input row */}
                    <div className="relative flex gap-2 items-start">
                      <div className="relative flex-1">
                        {/* URL icon — shown when input looks like a URL */}
                        {looksLikeUrl(jobInput) && (
                          <Link2 className="absolute left-3 top-3 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
                        )}
                        <textarea
                          value={jobInput}
                          onChange={(e) => {
                            setJobInput(e.target.value);
                            // Clear fetched result when user modifies the input
                            if (jobFetchedText) {
                              setJobFetchedText('');
                              setJobFetchedTitle('');
                            }
                            setJobError('');
                          }}
                          placeholder="Paste a job URL (Indeed, LinkedIn…) or the full description"
                          rows={3}
                          className={[
                            'w-full bg-gray-50 border border-gray-200 rounded-xl py-2.5 text-sm text-gray-900 placeholder:text-gray-400 resize-none outline-none focus:border-orange-500/60 transition-colors scrollbar-hidden',
                            looksLikeUrl(jobInput) ? 'pl-8 pr-3' : 'px-3',
                          ].join(' ')}
                        />
                      </div>

                      {/* Fetch button — only shown when there's input to process */}
                      {jobInput.trim() && !jobFetchedText && (
                        <button
                          type="button"
                          onClick={handleJobFetch}
                          disabled={isParsingJob}
                          className="flex-shrink-0 mt-0.5 h-9 px-3 rounded-xl bg-gray-200 hover:bg-gray-300 disabled:opacity-50 text-gray-700 text-xs font-medium transition-colors flex items-center gap-1.5"
                        >
                          {isParsingJob ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <>
                              {looksLikeUrl(jobInput) ? 'Fetch' : 'Clean'}
                              <ArrowRight className="w-3 h-3" />
                            </>
                          )}
                        </button>
                      )}
                    </div>

                    {/* Job fetch success badge */}
                    <AnimatePresence>
                      {jobFetchedTitle && (
                        <motion.div
                          initial={{ opacity: 0, y: -4 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -4 }}
                          className="flex items-center gap-2"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                          <span className="text-xs text-emerald-400 truncate">
                            {jobFetchedTitle}
                          </span>
                          <span className="text-xs text-gray-400">
                            · {jobFetchedText.length.toLocaleString()} chars
                          </span>
                        </motion.div>
                      )}
                    </AnimatePresence>

                    {/* Job fetch error (text-mode failures) */}
                    <AnimatePresence>
                      {jobError && !showPasteFallback && (
                        <motion.div
                          initial={{ opacity: 0, y: -4 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -4 }}
                          className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/25 rounded-xl px-3 py-2.5"
                        >
                          <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" />
                          <p className="text-xs text-amber-300">{jobError}</p>
                        </motion.div>
                      )}
                    </AnimatePresence>

                    {/* ── Paste fallback — shown when the URL scrape is blocked ─────
                        When LinkedIn/Indeed/etc. returns a 403 or login wall, we
                        reveal this frosted-glass textarea so the user can paste the
                        JD text manually without having to clear the URL and start over.
                        The URL is kept visible above as a reminder of what they tried.
                    ──────────────────────────────────────────────────────────────── */}
                    <AnimatePresence>
                      {showPasteFallback && (
                        <motion.div
                          initial={{ opacity: 0, y: 8, scale: 0.98 }}
                          animate={{ opacity: 1, y: 0,  scale: 1    }}
                          exit={{    opacity: 0, y: 8,  scale: 0.98 }}
                          transition={{ type: 'spring', stiffness: 320, damping: 26 }}
                          className="flex flex-col gap-2"
                        >
                          {/* Header row */}
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-1.5">
                              <AlertTriangle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
                              <p className="text-xs text-amber-300 font-medium">
                                Oops — this site blocked our scanners.
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() => {
                                setShowPasteFallback(false);
                                setJdPasteText('');
                              }}
                              className="text-gray-400 hover:text-gray-600 transition-colors"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>

                          {/* Paste area */}
                          <div className="relative rounded-xl overflow-hidden border border-amber-400/40 shadow-sm bg-amber-50/60">
                            <textarea
                              value={jdPasteText}
                              onChange={(e) => setJdPasteText(e.target.value)}
                              placeholder="Paste the job description text here…"
                              rows={5}
                              autoFocus
                              className="relative z-10 w-full bg-transparent px-3 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 resize-none outline-none scrollbar-hidden"
                            />
                            {/* Character count badge */}
                            {jdPasteText.length > 0 && (
                              <div className="absolute bottom-2 right-2.5 z-10">
                                <span className="text-[10px] text-amber-400/60 font-medium">
                                  {jdPasteText.length.toLocaleString()} chars
                                </span>
                              </div>
                            )}
                          </div>

                          {/* Confirm badge once text is pasted */}
                          <AnimatePresence>
                            {jdPasteText.trim().length > 50 && (
                              <motion.div
                                initial={{ opacity: 0, y: -4 }}
                                animate={{ opacity: 1, y:  0 }}
                                exit={{    opacity: 0, y: -4 }}
                                className="flex items-center gap-2"
                              >
                                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                                <span className="text-xs text-emerald-400">
                                  Job description ready — {jdPasteText.trim().length.toLocaleString()} chars
                                </span>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>

                  {/* ── Submit ─────────────────────────────────────────────── */}
                  <button
                    onClick={handleAnalyze}
                    disabled={
                      !resumeText.trim() ||
                      isParsingFile ||
                      isParsingJob ||
                      isAnalyzing ||
                      // JD is mandatory — need at least one of: fetched text, paste fallback, or typed input
                      !(jobFetchedText || (showPasteFallback ? jdPasteText.trim() : jobInput.trim()))
                    }
                    className="w-full bg-gradient-to-r from-orange-500 to-amber-500 disabled:from-gray-200 disabled:to-gray-200 disabled:text-gray-400 text-white font-semibold py-3 rounded-2xl transition-all flex items-center justify-center gap-2"
                  >
                    <Wand2 className="w-4 h-4" />
                    {isAnalyzing ? 'Analysing…' : 'Analyse my resume →'}
                  </button>

                  <button
                    onClick={() => { setOnboardingMode('scratch'); advanceTo(2); }}
                    className="text-xs text-gray-400 hover:text-gray-600 text-center transition-colors"
                  >
                    ← Actually, start from scratch instead
                  </button>
                </motion.div>
              )}
            </motion.div>
          )}

          {/* ─────────────────────────────────────────────────────────────
              STEP 3 — THE SHOCK (ATS Scan → Score)
          ─────────────────────────────────────────────────────────────── */}
          {step === 3 && (
            <motion.div
              key="step-3"
              variants={stepVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={stepTransition}
              className="flex flex-col items-center gap-7 text-center"
            >
              <MacMascot currentStep="idle" state={mascotState} />

              {!scanComplete ? (
                <div className="w-full flex flex-col gap-4">
                  <div>
                    <p className="text-xs font-bold uppercase tracking-[0.2em] text-orange-400 mb-2">
                      {onboardingMode === 'upload' ? 'Scanning your resume' : 'Building your ATS profile'}
                    </p>
                    <h2 className="text-xl font-bold text-gray-900">
                      {onboardingMode === 'upload'
                        ? 'Checking ATS compatibility…'
                        : 'Preparing your clean slate…'}
                    </h2>
                    <p className="mt-1 text-sm text-gray-500">
                      {onboardingMode === 'upload'
                        ? 'Analysing formatting, keywords, and action verbs'
                        : 'Setting up the perfect template for your industry'}
                    </p>
                  </div>

                  <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
                    <motion.div
                      className="h-full bg-gradient-to-r from-orange-500 to-amber-400 rounded-full"
                      style={{ width: `${scanProgress}%` }}
                      transition={{ ease: 'linear' }}
                    />
                  </div>

                  <div className="text-left space-y-2">
                    {[
                      'Keyword density analysis',
                      'Section structure validation',
                      'Action verb scoring',
                      'ATS compatibility check',
                    ].map((item, i) => {
                      const revealed = scanProgress > (i + 1) * 22;
                      return (
                        <AnimatePresence key={item}>
                          {revealed && (
                            <motion.div
                              initial={{ opacity: 0, x: -8 }}
                              animate={{ opacity: 1, x: 0 }}
                              className="flex items-center gap-2 text-sm"
                            >
                              <CheckCircle2 className="w-3.5 h-3.5 text-orange-400 flex-shrink-0" />
                              <span className="text-gray-500">{item}</span>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <motion.div
                  className="w-full flex flex-col gap-5"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.4 }}
                >
                  {/* Error state — shown when /api/analyze returns a failure */}
                  {analysisError && (
                    <motion.div
                      initial={{ opacity: 0, y: -6 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="flex items-start gap-2 bg-red-500/10 border border-red-500/25 rounded-xl px-3 py-2.5"
                    >
                      <AlertTriangle className="w-4 h-4 text-red-400 mt-0.5 flex-shrink-0" />
                      <div className="flex-1">
                        <p className="text-xs text-red-400 font-medium">{analysisError}</p>
                        <button
                          onClick={() => { advanceTo(2); setScanComplete(false); setScanProgress(0); setApiScore(null); useAppStore.setState({ analysisError: null }); }}
                          className="text-xs text-red-300 hover:text-red-200 underline mt-0.5"
                        >
                          ← Go back and try again
                        </button>
                      </div>
                    </motion.div>
                  )}

                  {/* Loading overlay while /api/analyze is in-flight after scan */}
                  {onboardingMode !== 'scratch' && scanComplete && (isAnalyzing || apiScore === null) && !analysisError && (
                    <motion.div
                      className="flex flex-col gap-3"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                    >
                      <div className="flex items-center gap-2 text-gray-500 text-sm">
                        <Loader2 className="w-4 h-4 animate-spin text-orange-400" />
                        {isAnalyzing ? 'Running ATS analysis…' : 'Calculating semantic match…'}
                      </div>

                      {/* Escape hatch — appears after 8 s if API is still pending */}
                      <AnimatePresence>
                        {showSkipButton && (
                          <motion.div
                            initial={{ opacity: 0, y: 6 }}
                            animate={{ opacity: 1, y: 0 }}
                            className="flex flex-col gap-2"
                          >
                            <button
                              onClick={() => { setApiScore(28); setRealAtsScore(28); }}
                              className="w-full bg-orange-500/10 border border-orange-500/30 hover:bg-orange-500/20 text-orange-600 font-semibold text-sm py-2.5 rounded-xl transition-all"
                            >
                              Skip & Continue to Workspace →
                            </button>
                            <button
                              onClick={() => { advanceTo(2); setScanComplete(false); setScanProgress(0); setApiScore(null); setShowSkipButton(false); }}
                              className="text-xs text-gray-400 hover:text-gray-600 transition-colors text-center"
                            >
                              ← Go Back
                            </button>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </motion.div>
                  )}

                  {onboardingMode !== 'scratch' && apiScore !== null ? (
                    <>
                      <div>
                        <p className={`text-xs font-bold uppercase tracking-[0.2em] mb-2 ${scoreLabelClass}`}>
                          ATS Score
                        </p>
                        <motion.div
                          className={`text-7xl font-black tabular-nums leading-none ${scoreColorClass}`}
                          initial={{ scale: 0.5 }}
                          animate={{ scale: 1 }}
                          transition={{ type: 'spring', stiffness: 340, damping: 22, delay: 0.1 }}
                        >
                          {scoreCount}
                          <span className="text-3xl opacity-60">/100</span>
                        </motion.div>

                        <motion.p
                          className="mt-2 text-base font-semibold text-gray-900"
                          initial={{ opacity: 0, y: 4 }}
                          animate={{ opacity: scoreCount >= apiScore ? 1 : 0, y: scoreCount >= apiScore ? 0 : 4 }}
                        >
                          {displayScore < 50
                            ? `Ouch. Only ${scoreCount} out of 100.`
                            : displayScore <= 80
                            ? `Decent start — ${scoreCount}/100. Room to grow.`
                            : `Strong match — ${scoreCount}/100!`}
                        </motion.p>

                        <motion.p
                          className="mt-1 text-sm text-gray-500"
                          initial={{ opacity: 0 }}
                          animate={{ opacity: scoreCount >= apiScore ? 1 : 0 }}
                          transition={{ delay: 0.3 }}
                        >
                          {displayScore < 50
                            ? 'Most ATS systems reject resumes below 60. The good news? I can fix this.'
                            : displayScore <= 80
                            ? 'A few keyword additions will push you past the ATS cutoff.'
                            : "You're already a strong match. Mac will make it perfect."}
                        </motion.p>
                      </div>

                      {/* ── Skill gap checklist ──────────────────────────────── */}
                      {apiGaps.length > 0 && (
                        <motion.div
                          className="w-full"
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: scoreCount >= apiScore ? 1 : 0, y: scoreCount >= apiScore ? 0 : 8 }}
                          transition={{ delay: 0.4 }}
                        >
                          <p className="text-xs font-bold uppercase tracking-[0.15em] text-orange-400 mb-2">
                            Missing Keywords
                          </p>
                          <div className="flex flex-col gap-1.5">
                            {apiGaps.map((gap) => (
                              <div
                                key={gap}
                                className="flex items-center gap-2.5 bg-red-500/8 border border-red-500/20 rounded-xl px-3 py-2"
                              >
                                <AlertTriangle className="w-3 h-3 text-red-400 flex-shrink-0" />
                                <span className="text-xs text-gray-700 font-medium">{gap}</span>
                              </div>
                            ))}
                          </div>
                          <p className="text-[11px] text-gray-400 mt-2">
                            Mac will help you work these into your resume naturally.
                          </p>
                        </motion.div>
                      )}
                    </>
                  ) : (
                    <>
                      <div>
                        <p className="text-xs font-bold uppercase tracking-[0.2em] text-emerald-400 mb-2">Starting Fresh</p>
                        <motion.div
                          className="text-6xl font-black text-emerald-400 tabular-nums leading-none"
                          initial={{ scale: 0.5 }}
                          animate={{ scale: 1 }}
                          transition={{ type: 'spring', stiffness: 340, damping: 22 }}
                        >
                          {scoreCount}
                          <span className="text-3xl text-emerald-400/60">/100</span>
                        </motion.div>
                        <p className="mt-2 text-base font-semibold text-gray-900">Clean slate — starting advantage.</p>
                        <p className="mt-1 text-sm text-gray-500">
                          No bad habits to unlearn. Mac will build your resume with ATS in mind from the start.
                        </p>
                      </div>
                    </>
                  )}

                  <motion.button
                    onClick={onComplete}
                    disabled={isAnalyzing || (onboardingMode !== 'scratch' && !analysisResult)}
                    whileTap={{ scale: 0.97 }}
                    className="w-full bg-gradient-to-r from-orange-500 to-amber-500 disabled:from-gray-200 disabled:to-gray-200 disabled:text-gray-400 text-white font-semibold py-4 rounded-2xl shadow-xl shadow-orange-500/25 flex items-center justify-center gap-2 text-base"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{
                      opacity: (onboardingMode === 'scratch' || (analysisResult !== null && !isAnalyzing)) && scoreCount > 5 ? 1 : 0,
                      y:       (onboardingMode === 'scratch' || (analysisResult !== null && !isAnalyzing)) && scoreCount > 5 ? 0 : 10,
                    }}
                    transition={{ duration: 0.4 }}
                  >
                    {onboardingMode === 'scratch' ? (
                      <><Sparkles className="w-4 h-4" /> Build my resume with Mac →</>
                    ) : (
                      <><Wand2 className="w-4 h-4" /> Let Mac fix this →</>
                    )}
                  </motion.button>

                  {/* Go Back — always available so users are never trapped */}
                  <button
                    onClick={() => { advanceTo(2); setScanComplete(false); setScanProgress(0); setApiScore(null); setShowSkipButton(false); }}
                    className="text-xs text-gray-400 hover:text-gray-600 transition-colors text-center w-full"
                  >
                    ← Go Back
                  </button>
                </motion.div>
              )}
            </motion.div>
          )}

        </AnimatePresence>
      </div>

      <p className="absolute bottom-6 text-[11px] text-gray-400 px-4 text-center">
        No credit card required · Canadian HR compliance enforced · Delete anytime
      </p>
    </div>
  );
};


// ── Sub-component: Pain option card ───────────────────────────────────────────

interface PainOptionCardProps {
  label:   string;
  sub:     string;
  onClick: () => void;
}

const PainOptionCard: React.FC<PainOptionCardProps> = ({ label, sub, onClick }) => {
  const [selected, setSelected] = useState(false);

  return (
    <motion.button
      onClick={() => { setSelected(true); onClick(); }}
      whileTap={{ scale: 0.97 }}
      className={[
        'w-full rounded-2xl p-4 text-left border transition-all shadow-sm',
        selected
          ? 'bg-orange-50 border-orange-400/60 shadow-orange-100'
          : 'bg-white border-gray-200 hover:border-orange-300 hover:bg-orange-50/50',
      ].join(' ')}
    >
      <div className="flex items-center justify-between">
        <div>
          <p className={`font-semibold text-sm ${selected ? 'text-orange-600' : 'text-gray-900'}`}>{label}</p>
          <p className="text-xs text-gray-500 mt-0.5">{sub}</p>
        </div>
        <motion.div
          animate={{ scale: selected ? 1 : 0, opacity: selected ? 1 : 0 }}
          className="w-5 h-5 rounded-full bg-orange-500 flex items-center justify-center flex-shrink-0"
        >
          <CheckCircle2 className="w-3 h-3 text-white" />
        </motion.div>
      </div>
    </motion.button>
  );
};
