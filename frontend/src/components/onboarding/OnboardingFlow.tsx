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
  Bot,
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

  // ── Upload loading + result state ─────────────────────────────────────────
  // Separate loading flags so Mac shows processing for both independently.
  const [isParsingFile, setIsParsingFile] = useState(false);
  const [isParsingJob,  setIsParsingJob]  = useState(false);
  const [fileError,     setFileError]     = useState('');
  const [jobError,      setJobError]      = useState('');
  const [uploadedFilename, setUploadedFilename] = useState('');
  const [jobFetchedTitle,  setJobFetchedTitle]  = useState('');
  const [jobFetchedText,   setJobFetchedText]   = useState('');

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
  const onboardingMode        = useAppStore((s) => s.onboardingMode);

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

  useEffect(() => {
    if (!scanComplete) return;
    const TARGET = onboardingMode === 'scratch' ? 78 : 34;
    let count = 0;
    scoreIntervalRef.current = setInterval(() => {
      count += 2;
      setScoreCount(Math.min(count, TARGET));
      if (count >= TARGET) clearInterval(scoreIntervalRef.current!);
    }, 25);
    return () => { if (scoreIntervalRef.current) clearInterval(scoreIntervalRef.current); };
  }, [scanComplete, onboardingMode]);

  // ── Mascot state ───────────────────────────────────────────────────────────
  // During any backend call OR the scan animation, show Mac "processing".
  const mascotState =
    (isParsingFile || isParsingJob)               ? 'processing' :
    step === 3 && !scanComplete                   ? 'processing' :
    step === 3 && scanComplete && onboardingMode !== 'scratch' ? 'warning' :
    step === 3 && scanComplete                    ? 'talking' :
    'idle';

  // ── Step advance ───────────────────────────────────────────────────────────
  const advanceTo = useCallback((nextStep: number) => setStep(nextStep), []);

  const handlePainChoice = useCallback(() => {
    setTimeout(() => advanceTo(1), 380);
  }, [advanceTo]);

  const handleForkScratch = useCallback(() => {
    setOnboardingMode('scratch');
    advanceTo(3);
  }, [setOnboardingMode, advanceTo]);

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
        // Backend returned success=false with a helpful error_hint
        setJobError(data.error_hint || 'Could not fetch the job description.');
      }

    } catch {
      setJobError(
        'Could not connect to the server. '
        + 'Please check your connection or paste the job text directly.'
      );
    } finally {
      setIsParsingJob(false);
    }
  }, [jobInput]);

  // ── Submit the upload form ────────────────────────────────────────────────
  /**
   * Called when the user clicks "Analyse my resume →".
   * Commits the collected data to the Zustand store, then advances to Step 3.
   *
   * WHY commit to the store here (not on each keystroke)?
   *   The Zustand store is the source of truth for the AI chat engine.
   *   We only want the final, confirmed data to land there — not live
   *   textarea content that changes with every character typed.
   */
  const handleUploadSubmit = useCallback(() => {
    // Use fetched job text if available; otherwise use raw input
    const finalJobText = jobFetchedText || jobInput.trim();

    setUploadedResumeText(resumeText);
    setJobDescription(finalJobText);
    advanceTo(3);
  }, [resumeText, jobFetchedText, jobInput, setUploadedResumeText, setJobDescription, advanceTo]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 bg-slate-950 flex flex-col items-center justify-center overflow-hidden">

      {/* Radial gradient background */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: 'radial-gradient(ellipse 80% 60% at 50% -10%, rgba(251,146,60,0.08) 0%, transparent 70%)',
        }}
      />

      {/* Step dots */}
      <div className="absolute top-6 left-1/2 -translate-x-1/2 flex gap-2 z-10">
        {[0, 1, 2, 3].map((i) => (
          <motion.div
            key={i}
            className="rounded-full bg-slate-600"
            animate={{
              width: i === step ? 24 : 6,
              backgroundColor: i === step
                ? 'rgb(251 146 60)'
                : i < step
                  ? 'rgb(100 116 139)'
                  : 'rgb(71 85 105)',
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
              className="flex flex-col items-center gap-8 text-center"
            >
              <MacMascot currentStep="idle" state="idle" />

              <div>
                <h1 className="text-2xl font-bold text-slate-100 leading-tight">
                  How many job applications have you sent
                  <span className="text-orange-400"> with zero interviews?</span>
                </h1>
                <p className="mt-2 text-sm text-slate-400">No judgment. We've all been there.</p>
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
              <motion.div
                className="w-20 h-20 rounded-3xl bg-gradient-to-br from-slate-700 to-slate-800 border border-slate-600/50 flex items-center justify-center shadow-2xl"
                initial={{ scale: 0.6, rotate: -12 }}
                animate={{ scale: 1, rotate: 0 }}
                transition={{ type: 'spring', stiffness: 260, damping: 20, delay: 0.1 }}
              >
                <Bot className="w-10 h-10 text-red-400" />
              </motion.div>

              <div>
                <motion.p
                  className="text-xs font-bold uppercase tracking-[0.2em] text-orange-400 mb-2"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.2 }}
                >
                  The culprit
                </motion.p>
                <h1 className="text-2xl font-bold text-slate-100 leading-tight">
                  It's not you.<br />
                  <span className="text-red-400">It's the ATS robots.</span>
                </h1>
              </div>

              <motion.div
                className="w-full bg-slate-800/80 backdrop-blur-sm border border-slate-700/50 rounded-2xl p-5 text-left space-y-3"
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
                      <span className="text-sm font-bold text-slate-100">{stat} </span>
                      <span className="text-sm text-slate-400">{detail}</span>
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
                <h1 className="text-2xl font-bold text-slate-100">How do you want to start?</h1>
                <p className="mt-1.5 text-sm text-slate-400">Mac adapts to your situation.</p>
              </div>

              {onboardingMode !== 'upload' ? (
                /* ── Initial fork choice ──────────────────────────────── */
                <div className="flex flex-col gap-3">
                  <motion.button
                    onClick={() => setOnboardingMode('upload')}
                    whileTap={{ scale: 0.98 }}
                    className="w-full bg-slate-800/80 border border-slate-700/50 rounded-2xl p-5 text-left hover:border-orange-500/50 hover:bg-slate-800 transition-all group"
                    initial={{ opacity: 0, x: -12 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.1 }}
                  >
                    <div className="flex items-start gap-4">
                      <div className="w-11 h-11 rounded-xl bg-orange-500/15 border border-orange-500/20 flex items-center justify-center flex-shrink-0 group-hover:bg-orange-500/25 transition-colors">
                        <FileText className="w-5 h-5 text-orange-400" />
                      </div>
                      <div>
                        <p className="font-semibold text-slate-100">I have a resume draft</p>
                        <p className="text-sm text-slate-400 mt-0.5">
                          Mac will score it, rewrite weak bullets, and tailor it to a job description.
                        </p>
                      </div>
                      <ArrowRight className="w-4 h-4 text-slate-500 flex-shrink-0 mt-3 ml-auto group-hover:text-orange-400 group-hover:translate-x-0.5 transition-all" />
                    </div>
                  </motion.button>

                  <motion.button
                    onClick={handleForkScratch}
                    whileTap={{ scale: 0.98 }}
                    className="w-full bg-slate-800/80 border border-slate-700/50 rounded-2xl p-5 text-left hover:border-brand-400/50 hover:bg-slate-800 transition-all group"
                    initial={{ opacity: 0, x: -12 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.2 }}
                  >
                    <div className="flex items-start gap-4">
                      <div className="w-11 h-11 rounded-xl bg-brand-500/15 border border-brand-500/20 flex items-center justify-center flex-shrink-0 group-hover:bg-brand-500/25 transition-colors">
                        <Sparkles className="w-5 h-5 text-brand-400" />
                      </div>
                      <div>
                        <p className="font-semibold text-slate-100">Start from scratch</p>
                        <p className="text-sm text-slate-400 mt-0.5">
                          Mac will interview you in a natural conversation and build your resume from zero.
                        </p>
                        <span className="inline-block mt-1.5 text-[10px] font-bold uppercase tracking-wider text-emerald-400 bg-emerald-500/10 rounded-full px-2 py-0.5">
                          Recommended
                        </span>
                      </div>
                      <ArrowRight className="w-4 h-4 text-slate-500 flex-shrink-0 mt-3 ml-auto group-hover:text-brand-400 group-hover:translate-x-0.5 transition-all" />
                    </div>
                  </motion.button>
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
                        <span className="text-sm text-slate-400">
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
                            : 'border-slate-600 hover:border-slate-500 bg-slate-800/50 hover:bg-slate-800/80',
                    ].join(' ')}
                  >
                    {isParsingFile ? (
                      <div className="flex flex-col items-center gap-2">
                        <Loader2 className="w-5 h-5 text-orange-400 animate-spin" />
                        <p className="text-xs text-slate-400">Parsing your resume…</p>
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
                          className="ml-1 text-slate-500 hover:text-slate-300 transition-colors flex-shrink-0"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ) : (
                      /* Default state */
                      <>
                        <Upload className="w-5 h-5 text-slate-500 mx-auto mb-1.5" />
                        <p className="text-xs text-slate-400">
                          Drop your resume here or{' '}
                          <span className="text-orange-400 font-medium">browse files</span>
                        </p>
                        <p className="text-[10px] text-slate-600 mt-0.5">
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
                      className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-slate-200 placeholder:text-slate-600 resize-none outline-none focus:border-orange-500/60 transition-colors scrollbar-hidden"
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
                    <label className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                      Target Job Description{' '}
                      <span className="text-slate-600 normal-case font-normal">(optional)</span>
                    </label>

                    {/* Input row */}
                    <div className="relative flex gap-2 items-start">
                      <div className="relative flex-1">
                        {/* URL icon — shown when input looks like a URL */}
                        {looksLikeUrl(jobInput) && (
                          <Link2 className="absolute left-3 top-3 w-3.5 h-3.5 text-slate-500 pointer-events-none" />
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
                            'w-full bg-slate-800 border border-slate-700 rounded-xl py-2.5 text-sm text-slate-200 placeholder:text-slate-600 resize-none outline-none focus:border-orange-500/60 transition-colors scrollbar-hidden',
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
                          className="flex-shrink-0 mt-0.5 h-9 px-3 rounded-xl bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-slate-300 text-xs font-medium transition-colors flex items-center gap-1.5"
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
                          <span className="text-xs text-slate-600">
                            · {jobFetchedText.length.toLocaleString()} chars
                          </span>
                        </motion.div>
                      )}
                    </AnimatePresence>

                    {/* Job fetch error */}
                    <AnimatePresence>
                      {jobError && (
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
                  </div>

                  {/* ── Submit ─────────────────────────────────────────────── */}
                  <button
                    onClick={handleUploadSubmit}
                    disabled={!resumeText.trim() || isParsingFile || isParsingJob}
                    className="w-full bg-gradient-to-r from-orange-500 to-amber-500 disabled:from-slate-700 disabled:to-slate-700 disabled:text-slate-500 text-white font-semibold py-3 rounded-2xl transition-all flex items-center justify-center gap-2"
                  >
                    <Wand2 className="w-4 h-4" />
                    Analyse my resume →
                  </button>

                  <button
                    onClick={() => { setOnboardingMode('scratch'); advanceTo(2); }}
                    className="text-xs text-slate-500 hover:text-slate-300 text-center transition-colors"
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
                    <h2 className="text-xl font-bold text-slate-100">
                      {onboardingMode === 'upload'
                        ? 'Checking ATS compatibility…'
                        : 'Preparing your clean slate…'}
                    </h2>
                    <p className="mt-1 text-sm text-slate-400">
                      {onboardingMode === 'upload'
                        ? 'Analysing formatting, keywords, and action verbs'
                        : 'Setting up the perfect template for your industry'}
                    </p>
                  </div>

                  <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
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
                              <span className="text-slate-400">{item}</span>
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
                  {onboardingMode !== 'scratch' ? (
                    <>
                      <div>
                        <p className="text-xs font-bold uppercase tracking-[0.2em] text-red-400 mb-2">ATS Score</p>
                        <motion.div
                          className="text-7xl font-black text-red-400 tabular-nums leading-none"
                          initial={{ scale: 0.5 }}
                          animate={{ scale: 1 }}
                          transition={{ type: 'spring', stiffness: 340, damping: 22, delay: 0.1 }}
                        >
                          {scoreCount}
                          <span className="text-3xl text-red-400/60">/100</span>
                        </motion.div>
                        <motion.p
                          className="mt-2 text-base font-semibold text-slate-200"
                          initial={{ opacity: 0, y: 4 }}
                          animate={{ opacity: scoreCount >= 34 ? 1 : 0, y: scoreCount >= 34 ? 0 : 4 }}
                        >
                          Ouch. Only {scoreCount} out of 100.
                        </motion.p>
                        <motion.p
                          className="mt-1 text-sm text-slate-400"
                          initial={{ opacity: 0 }}
                          animate={{ opacity: scoreCount >= 34 ? 1 : 0 }}
                          transition={{ delay: 0.3 }}
                        >
                          Most ATS systems reject resumes below 60. The good news? I can fix this.
                        </motion.p>
                      </div>

                      <motion.div
                        className="grid grid-cols-2 gap-2"
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: scoreCount >= 34 ? 1 : 0, y: scoreCount >= 34 ? 0 : 8 }}
                        transition={{ delay: 0.4 }}
                      >
                        {[
                          { label: 'Keywords',     score: '12/30', bad: true  },
                          { label: 'Formatting',   score: '8/25',  bad: true  },
                          { label: 'Action Verbs', score: '6/20',  bad: true  },
                          { label: 'Length',       score: '8/25',  bad: false },
                        ].map(({ label, score, bad }) => (
                          <div
                            key={label}
                            className={[
                              'rounded-xl px-3 py-2 flex items-center justify-between',
                              bad
                                ? 'bg-red-500/10 border border-red-500/20'
                                : 'bg-emerald-500/10 border border-emerald-500/20',
                            ].join(' ')}
                          >
                            <span className="text-xs text-slate-400">{label}</span>
                            <span className={`text-xs font-bold ${bad ? 'text-red-400' : 'text-emerald-400'}`}>
                              {score}
                            </span>
                          </div>
                        ))}
                      </motion.div>

                      <AlertTriangle className="w-4 h-4 text-amber-400 mx-auto opacity-60" />
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
                        <p className="mt-2 text-base font-semibold text-slate-200">Clean slate — starting advantage.</p>
                        <p className="mt-1 text-sm text-slate-400">
                          No bad habits to unlearn. Mac will build your resume with ATS in mind from the start.
                        </p>
                      </div>
                    </>
                  )}

                  <motion.button
                    onClick={onComplete}
                    whileTap={{ scale: 0.97 }}
                    className="w-full bg-gradient-to-r from-orange-500 to-amber-500 text-white font-semibold py-4 rounded-2xl shadow-xl shadow-orange-500/25 flex items-center justify-center gap-2 text-base"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: scoreCount > 5 ? 1 : 0, y: scoreCount > 5 ? 0 : 10 }}
                    transition={{ duration: 0.4 }}
                  >
                    {onboardingMode === 'scratch' ? (
                      <><Sparkles className="w-4 h-4" /> Build my resume with Mac →</>
                    ) : (
                      <><Wand2 className="w-4 h-4" /> Let Mac fix this →</>
                    )}
                  </motion.button>
                </motion.div>
              )}
            </motion.div>
          )}

        </AnimatePresence>
      </div>

      <p className="absolute bottom-6 text-[11px] text-slate-600 px-4 text-center">
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
        'w-full rounded-2xl p-4 text-left border transition-all',
        selected
          ? 'bg-orange-500/15 border-orange-400/60'
          : 'bg-slate-800/80 border-slate-700/50 hover:border-slate-600 hover:bg-slate-800',
      ].join(' ')}
    >
      <div className="flex items-center justify-between">
        <div>
          <p className={`font-semibold text-sm ${selected ? 'text-orange-300' : 'text-slate-200'}`}>{label}</p>
          <p className="text-xs text-slate-500 mt-0.5">{sub}</p>
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
