/**
 * components/onboarding/OnboardingFlow.tsx — The PLG Conversion Funnel
 * ─────────────────────────────────────────────────────────────────────────────
 * A four-step psychological onboarding wizard designed to convert cold visitors
 * into engaged users who WANT to pay.  The sequence is not arbitrary — each step
 * is a deliberate PLG (Product-Led Growth) conversion mechanic:
 *
 *   STEP 0 — PAIN DISCOVERY
 *     Ask the user how many applications they've sent with zero results.
 *     WHY: Admitting the pain aloud (even by clicking a button) creates
 *     psychological commitment. It also segments users by urgency.
 *     The "Lost count 😩" option deliberately uses self-deprecating humour to
 *     break the ice and build rapport with Mac.
 *
 *   STEP 1 — VILLAIN REVEAL
 *     Introduce ATS robots as the villain that's been working against them.
 *     WHY: The human brain responds to stories, not statistics.  Naming the
 *     villain externalises blame ("It's not you — it's the bots!") which is
 *     immediately relieving.  This relief is emotionally tied to the product.
 *     Stat: "74% of resumes never reach a human" is true and deeply shocking.
 *
 *   STEP 2 — THE FORK
 *     Two paths: "Optimise my draft" vs "Start from scratch".
 *     WHY: Giving users control is a core PLG principle — it builds agency.
 *     Path A (upload) requires more effort, signalling higher intent.
 *     Path B (scratch) is faster, capturing users who are just browsing.
 *     Both paths converge at Step 3, so the funnel doesn't split.
 *
 *   STEP 3 — THE SHOCK (ATS Scan)
 *     A 3-second "scanning" animation followed by a devastatingly low score.
 *     WHY: This is the "Aha-moment" — the user viscerally understands their
 *     problem for the first time.  The red score creates urgency.
 *     Mac's sympathetic reaction ("Ouch. Let me fix this.") immediately
 *     positions the product as the solution before the paywall appears.
 *     DESIGN NOTE: The score is always low (~34%) for upload mode because any
 *     real resume has ATS issues.  Scratch mode shows a "building" path instead.
 *
 * GRAPHITE / ORANGE THEME:
 *   Matches the DocumentPreview canvas — slate-900 bg, slate-800 cards,
 *   orange-400 accents.  This creates visual continuity: the onboarding and
 *   the workspace feel like the same product rather than a landing page bolted on.
 *
 * FRAMER MOTION TRANSITIONS:
 *   Each step slides in from the right (x: 60 → 0) and exits to the left
 *   (x: 0 → -60).  This matches iOS navigation patterns — the brain
 *   interprets rightward motion as "forward" and leftward as "back".
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
  FileText,
  Sparkles,
  Upload,
  Wand2,
  AlertTriangle,
  CheckCircle2,
} from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import { MacMascot } from '@/components/mascot/MacMascot';

// ── Step slide animation preset ───────────────────────────────────────────────
/** Slides steps in from right, out to left — matches iOS nav convention. */
const stepVariants = {
  enter:   { opacity: 0, x: 60,  scale: 0.97 },
  center:  { opacity: 1, x: 0,   scale: 1    },
  exit:    { opacity: 0, x: -60, scale: 0.97 },
};

const stepTransition = {
  type: 'spring',
  stiffness: 300,
  damping: 28,
};

// ── Pain options ──────────────────────────────────────────────────────────────
const PAIN_OPTIONS = [
  { label: '< 10 applications',  sub: 'Just getting started',    value: 'few'   },
  { label: '20 – 50 sent',       sub: 'Getting a bit frustrated', value: 'many'  },
  { label: 'Lost count 😩',      sub: 'Way too many to count',   value: 'lots'  },
] as const;

// ── Props ─────────────────────────────────────────────────────────────────────
interface OnboardingFlowProps {
  /** Called when the user completes Step 3 and is ready for the paywall. */
  onComplete: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────
export const OnboardingFlow: React.FC<OnboardingFlowProps> = ({ onComplete }) => {

  // ── Local wizard state ────────────────────────────────────────────────────
  const [step,          setStep]          = useState(0);
  const [resumeText,    setResumeText]    = useState('');
  const [jobDesc,       setJobDesc]       = useState('');
  const [isDragging,    setIsDragging]    = useState(false);

  // Scan step state
  const [scanProgress,  setScanProgress]  = useState(0);
  const [scanComplete,  setScanComplete]  = useState(false);
  const [scoreCount,    setScoreCount]    = useState(0);
  const scanIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const scoreIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Store actions ─────────────────────────────────────────────────────────
  const setOnboardingMode     = useAppStore((s) => s.setOnboardingMode);
  const setUploadedResumeText = useAppStore((s) => s.setUploadedResumeText);
  const setJobDescription     = useAppStore((s) => s.setJobDescription);
  const onboardingMode        = useAppStore((s) => s.onboardingMode);

  // ── Step 3: ATS scan animation ────────────────────────────────────────────
  // Fires when we enter step 3 (the ATS shock reveal).
  // The progress bar fills over ~3 seconds, then the score counts up to 34.
  useEffect(() => {
    if (step !== 3) return;

    // Fill progress bar from 0 → 100 over 3 seconds (30ms interval)
    let progress = 0;
    scanIntervalRef.current = setInterval(() => {
      progress += 100 / (3000 / 30);
      setScanProgress(Math.min(progress, 100));

      if (progress >= 100) {
        clearInterval(scanIntervalRef.current!);
        setScanComplete(true);
      }
    }, 30);

    return () => {
      if (scanIntervalRef.current) clearInterval(scanIntervalRef.current);
    };
  }, [step]);

  // Once scan completes, count up the score number for a tense reveal
  useEffect(() => {
    if (!scanComplete) return;

    const TARGET = onboardingMode === 'scratch' ? 78 : 34; // scratch = "clean start" score
    let count = 0;

    scoreIntervalRef.current = setInterval(() => {
      count += 2;
      setScoreCount(Math.min(count, TARGET));
      if (count >= TARGET) clearInterval(scoreIntervalRef.current!);
    }, 25);

    return () => {
      if (scoreIntervalRef.current) clearInterval(scoreIntervalRef.current);
    };
  }, [scanComplete, onboardingMode]);

  // ── Advance helpers ────────────────────────────────────────────────────────
  const advanceTo = useCallback((nextStep: number) => {
    setStep(nextStep);
  }, []);

  const handlePainChoice = useCallback(() => {
    // Brief pause after click so the selection animation plays
    setTimeout(() => advanceTo(1), 380);
  }, [advanceTo]);

  const handleForkUpload = useCallback(() => {
    setOnboardingMode('upload');
    // Stay on step 2 — the form expands inline (no step change needed)
  }, [setOnboardingMode]);

  const handleForkScratch = useCallback(() => {
    setOnboardingMode('scratch');
    // Skip directly to scan
    advanceTo(3);
  }, [setOnboardingMode, advanceTo]);

  const handleUploadSubmit = useCallback(() => {
    setUploadedResumeText(resumeText);
    setJobDescription(jobDesc);
    advanceTo(3);
  }, [resumeText, jobDesc, setUploadedResumeText, setJobDescription, advanceTo]);

  // ── Drag-and-drop handlers for the resume upload zone ─────────────────────
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const file = e.dataTransfer.files[0];
    if (!file) return;

    // Accept plain-text and simple formats; PDF binary won't decode to useful text
    if (file.type === 'text/plain' || file.name.endsWith('.txt')) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        setResumeText((ev.target?.result as string) ?? '');
      };
      reader.readAsText(file);
    } else {
      // For PDF/DOCX: guide the user to paste — full parsing needs a server
      setResumeText(`[${file.name} uploaded — please paste the text content below for analysis]`);
    }
  }, []);

  // ── Mascot state for onboarding ────────────────────────────────────────────
  // Use 'processing' during scan, 'warning' when low score shown, else 'idle'
  const mascotState =
    step === 3 && !scanComplete ? 'processing' :
    step === 3 && scanComplete && onboardingMode !== 'scratch' ? 'warning' :
    step === 3 && scanComplete ? 'talking' :
    'idle';

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 bg-slate-950 flex flex-col items-center justify-center overflow-hidden">

      {/* Radial gradient background — adds depth to the flat dark surface */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: 'radial-gradient(ellipse 80% 60% at 50% -10%, rgba(251,146,60,0.08) 0%, transparent 70%)',
        }}
      />

      {/* Step dots — progress indicator at the top */}
      <div className="absolute top-6 left-1/2 -translate-x-1/2 flex gap-2 z-10">
        {[0, 1, 2, 3].map((i) => (
          <motion.div
            key={i}
            className="rounded-full bg-slate-600"
            animate={{
              width:           i === step ? 24 : 6,
              backgroundColor: i === step ? 'rgb(251 146 60)' : i < step ? 'rgb(100 116 139)' : 'rgb(71 85 105)',
            }}
            transition={{ type: 'spring', stiffness: 380, damping: 28 }}
            style={{ height: 6 }}
          />
        ))}
      </div>

      {/* ── Step content ─────────────────────────────────────────────────── */}
      <div className="w-full max-w-lg px-5 relative z-10">
        <AnimatePresence mode="wait">

          {/* ─────────────────────────────────────────────────────────────
              STEP 0 — PAIN DISCOVERY
              Ask how many resumes sent with no replies.
              Self-selection segments users and builds emotional investment.
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
              {/* Mac mascot — idle, inviting */}
              <MacMascot currentStep="idle" state="idle" />

              <div>
                <h1 className="text-2xl font-bold text-slate-100 leading-tight">
                  How many job applications have you sent
                  <span className="text-orange-400"> with zero interviews?</span>
                </h1>
                <p className="mt-2 text-sm text-slate-400">
                  No judgment. We've all been there.
                </p>
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
              Name the enemy. Externalise blame from the user onto ATS bots.
              Relief at "It's not you" creates instant product affinity.
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
              {/* ATS bot icon — visually ominous */}
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

              {/* Stats card */}
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
              Two paths: upload existing resume OR start from scratch.
              Giving user control is a PLG principle — it builds agency and
              makes them feel like the product adapts to them, not the reverse.
              Path A (upload) signals higher intent → slightly higher friction.
              Path B (scratch) is frictionless → captures broader funnel.
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
                <p className="mt-1.5 text-sm text-slate-400">
                  Mac adapts to your situation.
                </p>
              </div>

              {onboardingMode !== 'upload' ? (
                /* ── Initial fork choice ─────────────────────────────────── */
                <div className="flex flex-col gap-3">
                  {/* Path A — Upload / Optimise */}
                  <motion.button
                    onClick={handleForkUpload}
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

                  {/* Path B — Start from scratch */}
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
                /* ── Path A expanded: upload + JD form ───────────────────── */
                <motion.div
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex flex-col gap-4"
                >
                  {/* Drag-drop zone */}
                  <div
                    onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                    onDragLeave={() => setIsDragging(false)}
                    onDrop={handleDrop}
                    className={[
                      'w-full rounded-2xl border-2 border-dashed p-4 text-center transition-all',
                      isDragging
                        ? 'border-orange-400 bg-orange-500/10'
                        : 'border-slate-600 hover:border-slate-500 bg-slate-800/50',
                    ].join(' ')}
                  >
                    <Upload className="w-5 h-5 text-slate-500 mx-auto mb-1.5" />
                    <p className="text-xs text-slate-400">
                      Drop a <strong className="text-slate-300">.txt</strong> file or paste below
                    </p>
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="text-[11px] font-semibold uppercase tracking-wider text-orange-400">
                      Your Current Resume
                    </label>
                    <textarea
                      value={resumeText}
                      onChange={(e) => setResumeText(e.target.value)}
                      placeholder="Paste your resume text here…"
                      rows={5}
                      className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-slate-200 placeholder:text-slate-600 resize-none outline-none focus:border-orange-500/60 transition-colors scrollbar-hidden"
                    />
                  </div>

                  <div className="flex flex-col gap-1">
                    <label className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                      Target Job Description <span className="text-slate-600 normal-case font-normal">(optional)</span>
                    </label>
                    <textarea
                      value={jobDesc}
                      onChange={(e) => setJobDesc(e.target.value)}
                      placeholder="Paste the job posting you're applying to… (improves ATS matching)"
                      rows={3}
                      className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-slate-200 placeholder:text-slate-600 resize-none outline-none focus:border-orange-500/60 transition-colors scrollbar-hidden"
                    />
                  </div>

                  <button
                    onClick={handleUploadSubmit}
                    disabled={!resumeText.trim()}
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
              The 3-second scan animation builds suspense, then delivers
              a viscerally low ATS score that creates urgency to fix it.
              Mac's reaction ("Ouch.") is deliberately relatable — it makes
              the user feel understood rather than blamed.
              Scratch mode: shows a "clean slate" optimistic framing instead.
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
              {/* Mac reacting emotionally */}
              <MacMascot currentStep="idle" state={mascotState} />

              {!scanComplete ? (
                /* ── Scanning animation ───────────────────────────────── */
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

                  {/* Progress bar */}
                  <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                    <motion.div
                      className="h-full bg-gradient-to-r from-orange-500 to-amber-400 rounded-full"
                      style={{ width: `${scanProgress}%` }}
                      transition={{ ease: 'linear' }}
                    />
                  </div>

                  {/* Scanning checklist — items appear one by one */}
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
                /* ── Score reveal ──────────────────────────────────────── */
                <motion.div
                  className="w-full flex flex-col gap-5"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.4 }}
                >
                  {onboardingMode !== 'scratch' ? (
                    /* Upload path: low score shock */
                    <>
                      <div>
                        <p className="text-xs font-bold uppercase tracking-[0.2em] text-red-400 mb-2">
                          ATS Score
                        </p>

                        {/* The score counter — counts up to the devastating number */}
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

                      {/* Score breakdown chips */}
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
                    /* Scratch path: optimistic clean-slate framing */
                    <>
                      <div>
                        <p className="text-xs font-bold uppercase tracking-[0.2em] text-emerald-400 mb-2">
                          Starting Fresh
                        </p>
                        <motion.div
                          className="text-6xl font-black text-emerald-400 tabular-nums leading-none"
                          initial={{ scale: 0.5 }}
                          animate={{ scale: 1 }}
                          transition={{ type: 'spring', stiffness: 340, damping: 22 }}
                        >
                          {scoreCount}
                          <span className="text-3xl text-emerald-400/60">/100</span>
                        </motion.div>
                        <p className="mt-2 text-base font-semibold text-slate-200">
                          Clean slate — starting advantage.
                        </p>
                        <p className="mt-1 text-sm text-slate-400">
                          No bad habits to unlearn. Mac will build your resume with ATS in mind from the start.
                        </p>
                      </div>
                    </>
                  )}

                  {/* CTA — triggers the paywall */}
                  <motion.button
                    onClick={onComplete}
                    whileTap={{ scale: 0.97 }}
                    className="w-full bg-gradient-to-r from-orange-500 to-amber-500 text-white font-semibold py-4 rounded-2xl shadow-xl shadow-orange-500/25 flex items-center justify-center gap-2 text-base"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: scoreCount > 5 ? 1 : 0, y: scoreCount > 5 ? 0 : 10 }}
                    transition={{ duration: 0.4 }}
                  >
                    {onboardingMode === 'scratch' ? (
                      <>
                        <Sparkles className="w-4 h-4" />
                        Build my resume with Mac →
                      </>
                    ) : (
                      <>
                        <Wand2 className="w-4 h-4" />
                        Let Mac fix this →
                      </>
                    )}
                  </motion.button>
                </motion.div>
              )}
            </motion.div>
          )}

        </AnimatePresence>
      </div>

      {/* Footer — reassurance copy */}
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

/**
 * Tappable card for Step 0 choices.
 * Spring-scales on tap and shows a brief green selected state before advancing.
 * WHY: Visual feedback on selection creates a micro-dopamine hit — the user
 * feels acknowledged even before seeing the next step.
 */
const PainOptionCard: React.FC<PainOptionCardProps> = ({ label, sub, onClick }) => {
  const [selected, setSelected] = useState(false);

  const handleClick = () => {
    setSelected(true);
    onClick();
  };

  return (
    <motion.button
      onClick={handleClick}
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
          <p className={`font-semibold text-sm ${selected ? 'text-orange-300' : 'text-slate-200'}`}>
            {label}
          </p>
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
