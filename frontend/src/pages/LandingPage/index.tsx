/**
 * LandingPage — Route: /
 * PRD §2 — Soft-Gate Onboarding
 *
 * State machine (local — no Zustand, no backend):
 *   idle       → user sees hero + upload zones
 *   processing → 1.5s simulated scan, buttons disabled
 *   result     → ATS score panel revealed, soft-gate CTAs shown
 *
 * Phase 3 wiring points (marked TODO):
 *   - Replace simulated scan with POST /api/ats-score
 *   - Wire useDocumentStore.setPendingCvFile / setPendingJdText
 *   - Replace console.log with useBillingStore.openAuthModal()
 *   - Replace MacMascot placeholder with real <video> asset
 */

import { useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import DevNav from '@/shared/ui/DevNav';
import MacMascot, { type MacState } from '@/shared/ui/MacMascot';
import AtsScoreDial from '@/shared/ui/AtsScoreDial';
import { useAuthStore } from '@/store/useAuthStore';

// ── Types ─────────────────────────────────────────────────────────────────────

type PageState = 'idle' | 'processing' | 'result';

// Hardcoded mock result — replaced by POST /api/ats-score in Phase 3
const MOCK_SCORE = 34;
const MOCK_GAPS = [
  'Missing: "TypeScript" (appears 6× in JD)',
  'Missing: "CI/CD pipeline" (appears 4× in JD)',
  'Weak: Experience section has zero quantified impact',
];

// ── Sub-components ────────────────────────────────────────────────────────────

function Navbar() {
  return (
    <nav className="fixed top-0 inset-x-0 z-40 glass border-b border-white/20">
      <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
        <span className="font-bold text-lg tracking-tight text-slate-900">
          Jobif<span className="text-brand-600">AI</span>
        </span>
        <div className="flex items-center gap-3">
          <button className="text-sm font-medium text-slate-600 hover:text-slate-900 transition-colors px-3 py-1.5 rounded-lg hover:bg-slate-100">
            Sign In
          </button>
          <button className="text-sm font-medium text-brand-600 hover:text-brand-700 transition-colors px-3 py-1.5 rounded-lg hover:bg-brand-50">
            Pricing
          </button>
        </div>
      </div>
    </nav>
  );
}

interface CvDropZoneProps {
  file: File | null;
  onFile: (f: File) => void;
  disabled: boolean;
}

function CvDropZone({ file, onFile, disabled }: CvDropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f && (f.type === 'application/pdf' || f.name.endsWith('.docx'))) onFile(f);
  }, [onFile]);

  return (
    <div
      onDragOver={e => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onClick={() => !disabled && inputRef.current?.click()}
      className={`
        relative flex flex-col items-center justify-center gap-3
        rounded-2xl border-2 border-dashed p-8 cursor-pointer
        transition-all duration-200 min-h-[180px]
        ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
        ${dragging
          ? 'border-brand-500 bg-brand-50'
          : file
            ? 'border-green-400 bg-green-50'
            : 'border-slate-300 bg-white hover:border-brand-400 hover:bg-brand-50/30'
        }
      `}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.docx"
        className="hidden"
        disabled={disabled}
        onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); }}
      />

      <div className={`w-12 h-12 rounded-xl flex items-center justify-center text-2xl
        ${file ? 'bg-green-100' : 'bg-slate-100'}`}>
        {file ? '📄' : '⬆️'}
      </div>

      <div className="text-center">
        <p className="font-semibold text-slate-700 text-sm">
          {file ? file.name : 'Drop your CV'}
        </p>
        <p className="text-xs text-slate-400 mt-0.5">
          {file ? 'CV ready ✓' : 'PDF or DOCX'}
        </p>
      </div>
    </div>
  );
}

interface JdTextAreaProps {
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}

const JD_MIN = 400;

function JdTextArea({ value, onChange, disabled }: JdTextAreaProps) {
  const count = value.length;
  const ready = count >= JD_MIN;

  return (
    <div className="flex flex-col gap-2 min-h-[180px]">
      <div className={`
        flex-1 rounded-2xl border-2 overflow-hidden transition-all duration-200
        ${disabled ? 'opacity-50' : ''}
        ${ready ? 'border-green-400' : 'border-slate-300 focus-within:border-brand-400'}
      `}>
        <textarea
          className="w-full h-full min-h-[156px] resize-none bg-white px-4 py-3
                     text-sm text-slate-700 placeholder:text-slate-400
                     focus:outline-none font-sans"
          placeholder="Paste the job posting here…&#10;&#10;The more detail the better — include the full job description, required skills, and responsibilities."
          value={value}
          onChange={e => onChange(e.target.value)}
          disabled={disabled}
        />
      </div>
      <div className="flex justify-between items-center px-1">
        <span className="text-xs text-slate-400">Paste the job posting</span>
        <span className={`text-xs font-mono transition-colors ${ready ? 'text-green-600' : 'text-slate-400'}`}>
          {count}/{JD_MIN}{ready ? ' ✓' : ' min'}
        </span>
      </div>
    </div>
  );
}

// ── Score Panel ───────────────────────────────────────────────────────────────

interface ScorePanelProps {
  score: number;
  gaps: string[];
  mascotState: MacState;
}

function ScorePanel({ score, gaps, mascotState }: ScorePanelProps) {
  const navigate = useNavigate();
  const isLow = score < 40;

  return (
    <motion.section
      initial={{ opacity: 0, y: 32 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: 'easeOut' }}
      className="mt-6 rounded-3xl bg-white border border-slate-200 shadow-card overflow-hidden"
    >
      {/* Score row */}
      <div className="flex flex-col sm:flex-row items-center gap-6 p-6 sm:p-8">
        {/* Mascot */}
        <div className="flex-shrink-0">
          <MacMascot state={mascotState} size={120} />
        </div>

        {/* Dial */}
        <div className="flex-shrink-0">
          <AtsScoreDial score={score} size={140} />
        </div>

        {/* Gap summary */}
        <div className="flex-1 min-w-0">
          <h3 className={`font-bold text-base mb-3 ${isLow ? 'text-red-600' : 'text-amber-600'}`}>
            Top {gaps.length} Gaps Found
          </h3>
          <ul className="space-y-2">
            {gaps.map((gap, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-slate-600">
                <span className={`mt-0.5 flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold text-white
                  ${isLow ? 'bg-red-500' : 'bg-amber-500'}`}>
                  {i + 1}
                </span>
                <span>{gap}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Soft-gate CTA row */}
      <div className="border-t border-slate-100 bg-slate-50 p-4 sm:p-6
                      flex flex-col sm:flex-row gap-3">
        <button
          onClick={() => {
            useAuthStore.getState().setUser({ id: '1', email: 'test@jobifai.com' });
            navigate('/dashboard');
          }}
          className="flex-1 flex items-center justify-center gap-2 px-5 py-3
                     rounded-xl bg-brand-600 hover:bg-brand-700 active:scale-[0.98]
                     text-white font-semibold text-sm shadow-brand
                     transition-all duration-150"
        >
          🔧 Fix My Resume
        </button>
        <button
          onClick={() => {
            useAuthStore.getState().setUser({ id: '1', email: 'test@jobifai.com' });
            navigate('/dashboard');
          }}
          className="flex-1 flex items-center justify-center gap-2 px-5 py-3
                     rounded-xl bg-white hover:bg-slate-50 active:scale-[0.98]
                     text-slate-700 font-semibold text-sm border border-slate-200
                     transition-all duration-150"
        >
          🎤 Start Interview Prep
        </button>
      </div>
    </motion.section>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function LandingPage() {
  const navigate = useNavigate();
  const [pageState, setPageState] = useState<PageState>('idle');
  const [cvFile, setCvFile]       = useState<File | null>(null);
  const [jdText, setJdText]       = useState('');

  // Mascot state is derived from page state + score
  const mascotState: MacState = (() => {
    if (pageState === 'processing') return 'processing';
    if (pageState === 'result') {
      if (MOCK_SCORE < 40)  return 'shocked';
      if (MOCK_SCORE < 70)  return 'warning';
      return 'success';
    }
    return 'idle';
  })();

  const canScan = cvFile !== null && jdText.length >= 400;

  const handleScan = useCallback(() => {
    if (!canScan || pageState !== 'idle') return;
    setPageState('processing');

    // TODO Phase 3: replace with POST /api/ats-score
    setTimeout(() => setPageState('result'), 1500);
  }, [canScan, pageState]);

  return (
    // overflow-y-auto overrides body: overflow-hidden so the result panel is scrollable
    <div className="h-full overflow-y-auto scrollbar-hidden bg-bg">
      <DevNav />
      <Navbar />

      {/* ── Main content — offset below fixed Navbar + DevNav ── */}
      {/* DevNav is 41px, Navbar is 56px = 97px. Use pt-24 (96px) + small gap */}
      <main className="pt-24 pb-16 px-4 max-w-5xl mx-auto">

        {/* ── HERO ─────────────────────────────────────────────── */}
        <section className="text-center pt-8 pb-10">
          <motion.h1
            initial={{ opacity: 0, y: -16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="text-4xl sm:text-5xl font-black text-slate-900 tracking-tight leading-tight"
          >
            Does your resume{' '}
            <span className="text-brand-600">beat the bot?</span>
          </motion.h1>
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.15, duration: 0.5 }}
            className="mt-3 text-lg text-slate-500 font-medium"
          >
            Find out in 10 seconds.{' '}
            <span className="text-brand-500 font-semibold">No login.</span>
          </motion.p>
        </section>

        {/* ── UPLOAD ZONE ──────────────────────────────────────── */}
        {/* Two columns on md+, single column on mobile (PRD §2.2) */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <CvDropZone
            file={cvFile}
            onFile={f => {
              // TODO Phase 3: useDocumentStore.getState().setPendingCvFile(f)
              setCvFile(f);
            }}
            disabled={pageState !== 'idle'}
          />
          <JdTextArea
            value={jdText}
            onChange={v => {
              // TODO Phase 3: useDocumentStore.getState().setPendingJdText(v)
              setJdText(v);
            }}
            disabled={pageState !== 'idle'}
          />
        </section>

        {/* ── SCAN CTA ─────────────────────────────────────────── */}
        <div className="mt-5 flex justify-center">
          <button
            onClick={handleScan}
            disabled={!canScan || pageState !== 'idle'}
            className={`
              relative px-10 py-4 rounded-2xl font-bold text-base
              transition-all duration-200 active:scale-[0.97]
              ${canScan && pageState === 'idle'
                ? 'bg-brand-600 hover:bg-brand-700 text-white shadow-brand cursor-pointer'
                : 'bg-slate-200 text-slate-400 cursor-not-allowed'
              }
            `}
          >
            {pageState === 'processing' ? (
              <span className="flex items-center gap-2">
                <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10"
                    stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor"
                    d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                </svg>
                Scanning…
              </span>
            ) : 'Scan My Resume'}
          </button>
        </div>

        {/* ── HELPER TEXT (idle only) ───────────────────────────── */}
        <AnimatePresence>
          {pageState === 'idle' && !canScan && (
            <motion.p
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="mt-3 text-center text-xs text-slate-400"
            >
              {!cvFile && jdText.length < 400
                ? 'Upload your CV and paste the job description to begin'
                : !cvFile
                  ? 'Upload your CV to begin'
                  : `Add ${400 - jdText.length} more characters to the job description`}
            </motion.p>
          )}
        </AnimatePresence>

        {/* ── PROCESSING STATE — mascot + analysis ticks ───────── */}
        <AnimatePresence>
          {pageState === 'processing' && (
            <motion.div
              key="processing"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="mt-8 flex flex-col items-center gap-4"
            >
              <MacMascot state="processing" size={120} />
              <ProcessingTicks />
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── RESULT STATE ─────────────────────────────────────── */}
        <AnimatePresence>
          {pageState === 'result' && (
            <ScorePanel
              key="result"
              score={MOCK_SCORE}
              gaps={MOCK_GAPS}
              mascotState={mascotState}
            />
          )}
        </AnimatePresence>

      </main>
    </div>
  );
}

// ── Processing analysis ticks ─────────────────────────────────────────────────

const TICKS = ['Parsing CV…', 'Reading JD…', 'Calculating match…'];

function ProcessingTicks() {
  const [step, setStep] = useState(0);

  // Cycle through ticks every ~450ms (1.5s total / 3 steps)
  useState(() => {
    const id = setInterval(() => setStep(s => Math.min(s + 1, TICKS.length - 1)), 480);
    return () => clearInterval(id);
  });

  return (
    <div className="flex flex-col items-center gap-1">
      {TICKS.map((t, i) => (
        <motion.p
          key={t}
          initial={{ opacity: 0, x: -8 }}
          animate={{ opacity: i <= step ? 1 : 0.25, x: 0 }}
          transition={{ delay: i * 0.12 }}
          className={`text-sm font-medium transition-colors
            ${i < step ? 'text-green-500' : i === step ? 'text-brand-600' : 'text-slate-300'}`}
        >
          {i < step ? '✓ ' : i === step ? '⏳ ' : '○ '}{t}
        </motion.p>
      ))}
    </div>
  );
}
