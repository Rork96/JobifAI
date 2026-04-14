/**
 * LandingPage — Route: /
 * Step 1.6 — Lead Magnet Teaser Flow (Phase 13 visual redesign — warm parchment palette)
 *
 * State machine:
 *   idle      → dual-intake cards (resume + JD), "Analyze" CTA disabled until both ready
 *   analyzing → mascot processing; real calls: uploadResume (if file) + parseJob (if URL)
 *               + runAtsAnalysis (embedding cosine + Gemini keyword extraction)
 *   result    → teaser panel: REAL score + missing keywords + "Fix My Resume Now" CTA
 *
 * All three backend calls are unauthenticated — /api/upload-resume, /api/parse-job,
 * and /api/ats-score have no auth dependency.  Auth happens AFTER the teaser via
 * AuthModal, then DashboardPage calls persistResume() to write the row.
 *
 * Architecture guardrails:
 *   - NEVER calls uploadResumeFile() or runAtsAnalysis() from outside the store.
 *   - uploadResume() (api.ts) is called directly here to get parsed text before auth.
 *   - runAtsAnalysis() is called via the store action.
 *   - After auth, DashboardPage reads pendingCvFile + pendingJdText + pendingResumeText.
 *
 * Design: warm parchment palette — #f5f3ec bg, #c96442 terracotta accent, #141413 text.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate }              from 'react-router-dom';
import DevNav                       from '@/shared/ui/DevNav';
import MacMascot, { type MacState } from '@/shared/ui/MacMascot';
import AtsScoreDial                 from '@/shared/ui/AtsScoreDial';
import AuthModal, { type AuthIntent } from '@/shared/ui/AuthModal';
import { useDocumentStore }         from '@/store/useDocumentStore';
import { useAuthStore }             from '@/store/useAuthStore';
import { uploadResume, parseJob, ApiError } from '@/lib/api';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const CV_MIN_CHARS  = 200;
const JD_MIN_CHARS  = 100;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type PageState    = 'idle' | 'analyzing' | 'result' | 'error';
type CvInputMode  = 'file' | 'paste';
type JdInputMode  = 'paste' | 'url';

// ─────────────────────────────────────────────────────────────────────────────
// Shared — pill tab bar
// ─────────────────────────────────────────────────────────────────────────────

function TabBar<T extends string>({
  options, value, onChange,
}: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex bg-[#e8e6dc] rounded-xl p-1 gap-1 w-fit">
      {options.map(opt => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={[
            'px-4 py-1.5 text-xs font-semibold rounded-lg transition-all duration-200',
            value === opt.value
              ? 'bg-white shadow-sm text-[#141413]'
              : 'text-[#87867f] hover:text-[#6b6963]',
          ].join(' ')}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ResumeInputCard
// ─────────────────────────────────────────────────────────────────────────────

interface ResumeInputCardProps {
  mode:         CvInputMode;
  onModeChange: (m: CvInputMode) => void;
  file:         File | null;
  onFile:       (f: File) => void;
  pastedText:   string;
  onPastedText: (t: string) => void;
  disabled:     boolean;
}

function ResumeInputCard({
  mode, onModeChange, file, onFile, pastedText, onPastedText, disabled,
}: ResumeInputCardProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f && (f.type === 'application/pdf' || f.name.endsWith('.docx') || f.name.endsWith('.txt'))) {
      onFile(f);
    }
  }, [onFile]);

  const isFileReady  = mode === 'file'  && file !== null;
  const isPasteReady = mode === 'paste' && pastedText.trim().length >= CV_MIN_CHARS;
  const isReady      = isFileReady || isPasteReady;

  return (
    <motion.div
      layout
      className={[
        'relative flex flex-col gap-4 rounded-3xl border p-6 transition-all duration-300',
        isReady
          ? 'bg-white border-[#c96442]/30 shadow-[0_4px_24px_rgba(201,100,66,0.08)]'
          : 'bg-white/90 backdrop-blur-sm border-[#e3e0d6] shadow-md shadow-[#e3e0d6]/60',
        disabled ? 'pointer-events-none opacity-60' : '',
      ].join(' ')}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className={[
            'flex items-center justify-center w-8 h-8 rounded-full text-sm font-bold',
            isReady
              ? 'bg-[#c96442]/10 text-[#c96442]'
              : 'bg-[#e8e6dc] text-[#87867f]',
          ].join(' ')}>
            {isReady ? '✓' : '📄'}
          </span>
          <div>
            <p className="text-sm font-bold text-[#141413] leading-none">Your Resume</p>
            <p className="text-[10px] text-[#b0aea5] mt-0.5 leading-none">
              {isReady ? 'Ready to analyse' : 'Upload or paste your CV'}
            </p>
          </div>
        </div>
        <TabBar
          options={[
            { value: 'file' as CvInputMode,  label: 'Upload File' },
            { value: 'paste' as CvInputMode, label: 'Paste Text' },
          ]}
          value={mode}
          onChange={onModeChange}
        />
      </div>

      {/* ── File drop zone ── */}
      <AnimatePresence mode="wait">
        {mode === 'file' && (
          <motion.div
            key="file"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.18 }}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.docx,.txt"
              className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); }}
            />
            <div
              onDragOver={e => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={[
                'flex flex-col items-center justify-center gap-3 rounded-2xl border-2',
                'border-dashed p-8 cursor-pointer transition-all duration-200 min-h-[160px]',
                dragging
                  ? 'border-[#c96442] bg-[#c96442]/[0.04]'
                  : file
                    ? 'border-[#c96442]/40 bg-[#c96442]/[0.03] hover:border-[#c96442]/60'
                    : 'border-[#e3e0d6] hover:border-[#c96442]/40 hover:bg-[#c96442]/[0.02]',
              ].join(' ')}
            >
              <div className={`w-12 h-12 rounded-2xl flex items-center justify-center text-2xl
                ${file ? 'bg-[#c96442]/10' : 'bg-[#e8e6dc]'}`}>
                {file ? '📄' : '⬆️'}
              </div>
              <div className="text-center">
                <p className="text-sm font-semibold text-[#141413]">
                  {file ? file.name : 'Drop PDF or DOCX here'}
                </p>
                <p className="text-xs text-[#b0aea5] mt-0.5">
                  {file ? 'Click to change file' : 'or click to browse — max 5 MB'}
                </p>
              </div>
            </div>
          </motion.div>
        )}

        {/* ── Paste zone ── */}
        {mode === 'paste' && (
          <motion.div
            key="paste"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.18 }}
            className="flex flex-col gap-1.5"
          >
            <textarea
              value={pastedText}
              onChange={e => onPastedText(e.target.value)}
              placeholder={
                'Paste your full resume text here…\n\nInclude your experience, skills, and education sections for the best analysis.'
              }
              rows={7}
              className={[
                'w-full resize-none rounded-2xl border px-4 py-3 text-sm leading-relaxed',
                'text-[#141413] placeholder:text-[#b0aea5] bg-[#f5f4f0] focus:bg-white',
                'focus:outline-none transition-colors duration-200',
                isPasteReady
                  ? 'border-[#c96442]/40 focus:border-[#c96442]/70'
                  : 'border-[#e3e0d6] focus:border-[#c96442]/50',
              ].join(' ')}
            />
            <div className="flex justify-between items-center px-1">
              <span className="text-[10px] text-[#b0aea5]">
                {isPasteReady ? '✓ Enough content to analyse' : `Minimum ${CV_MIN_CHARS} characters`}
              </span>
              <span className={`text-[10px] font-mono tabular-nums
                ${isPasteReady ? 'text-[#c96442]' : 'text-[#b0aea5]'}`}>
                {pastedText.length.toLocaleString()} chars
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// JdInputCard
// ─────────────────────────────────────────────────────────────────────────────

type JdScrapeState = 'idle' | 'fetching' | 'done' | 'error';

interface JdInputCardProps {
  mode:           JdInputMode;
  onModeChange:   (m: JdInputMode) => void;
  pastedText:     string;
  onPastedText:   (t: string) => void;
  urlValue:       string;
  onUrlChange:    (v: string) => void;
  scrapeState:    JdScrapeState;
  scrapeError:    string;
  onFetch:        () => void;
  disabled:       boolean;
}

function JdInputCard({
  mode, onModeChange, pastedText, onPastedText,
  urlValue, onUrlChange, scrapeState, scrapeError, onFetch, disabled,
}: JdInputCardProps) {
  const isPasteReady = mode === 'paste' && pastedText.trim().length >= JD_MIN_CHARS;
  const isUrlReady   = mode === 'url'   && scrapeState === 'done' && pastedText.trim().length >= JD_MIN_CHARS;
  const isReady      = isPasteReady || isUrlReady;

  return (
    <motion.div
      layout
      className={[
        'relative flex flex-col gap-4 rounded-3xl border p-6 transition-all duration-300',
        isReady
          ? 'bg-white border-[#c96442]/30 shadow-[0_4px_24px_rgba(201,100,66,0.08)]'
          : 'bg-white/90 backdrop-blur-sm border-[#e3e0d6] shadow-md shadow-[#e3e0d6]/60',
        disabled ? 'pointer-events-none opacity-60' : '',
      ].join(' ')}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className={[
            'flex items-center justify-center w-8 h-8 rounded-full text-sm font-bold',
            isReady
              ? 'bg-[#c96442]/10 text-[#c96442]'
              : 'bg-amber-50 text-amber-600',
          ].join(' ')}>
            {isReady ? '✓' : '💼'}
          </span>
          <div>
            <p className="text-sm font-bold text-[#141413] leading-none">Job Description</p>
            <p className="text-[10px] text-[#b0aea5] mt-0.5 leading-none">
              {isReady ? 'Ready to analyse' : 'Paste or link the job posting'}
            </p>
          </div>
        </div>
        <TabBar
          options={[
            { value: 'paste' as JdInputMode, label: 'Paste Text' },
            { value: 'url'   as JdInputMode, label: 'Job URL'    },
          ]}
          value={mode}
          onChange={onModeChange}
        />
      </div>

      <AnimatePresence mode="wait">
        {/* ── Paste mode ── */}
        {mode === 'paste' && (
          <motion.div
            key="paste"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.18 }}
            className="flex flex-col gap-1.5"
          >
            <textarea
              value={pastedText}
              onChange={e => onPastedText(e.target.value)}
              placeholder={
                'Paste the full job description here…\n\nInclude required skills, responsibilities, and qualifications for the most accurate keyword analysis.'
              }
              rows={7}
              className={[
                'w-full resize-none rounded-2xl border px-4 py-3 text-sm leading-relaxed',
                'text-[#141413] placeholder:text-[#b0aea5] bg-[#f5f4f0] focus:bg-white',
                'focus:outline-none transition-colors duration-200',
                isPasteReady
                  ? 'border-[#c96442]/40 focus:border-[#c96442]/70'
                  : 'border-[#e3e0d6] focus:border-[#c96442]/50',
              ].join(' ')}
            />
            <div className="flex justify-between items-center px-1">
              <span className="text-[10px] text-[#b0aea5]">
                {isPasteReady ? '✓ Enough content to analyse' : `Minimum ${JD_MIN_CHARS} characters`}
              </span>
              <span className={`text-[10px] font-mono tabular-nums
                ${isPasteReady ? 'text-[#c96442]' : 'text-[#b0aea5]'}`}>
                {pastedText.length.toLocaleString()} chars
              </span>
            </div>
          </motion.div>
        )}

        {/* ── URL mode ── */}
        {mode === 'url' && (
          <motion.div
            key="url"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.18 }}
            className="flex flex-col gap-3"
          >
            <div className="flex gap-2">
              <input
                type="url"
                value={urlValue}
                onChange={e => onUrlChange(e.target.value)}
                placeholder="https://jobs.example.com/senior-engineer…"
                className={[
                  'flex-1 rounded-xl border px-4 py-2.5 text-sm text-[#141413]',
                  'placeholder:text-[#b0aea5] bg-[#f5f4f0] focus:bg-white focus:outline-none',
                  'transition-colors duration-200',
                  scrapeState === 'error'
                    ? 'border-red-300 focus:border-red-400'
                    : scrapeState === 'done'
                      ? 'border-[#c96442]/40'
                      : 'border-[#e3e0d6] focus:border-[#c96442]/50',
                ].join(' ')}
                onKeyDown={e => { if (e.key === 'Enter') onFetch(); }}
              />
              <button
                type="button"
                onClick={onFetch}
                disabled={!urlValue.trim() || scrapeState === 'fetching'}
                className={[
                  'px-4 py-2.5 rounded-xl text-sm font-semibold transition-all duration-200',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                  scrapeState === 'fetching'
                    ? 'bg-[#e8e6dc] text-[#87867f] cursor-wait'
                    : 'bg-[#c96442] hover:bg-[#b5593b] active:scale-95 text-white shadow-sm',
                ].join(' ')}
              >
                {scrapeState === 'fetching' ? (
                  <span className="flex items-center gap-1.5">
                    <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>
                    </svg>
                    Fetching
                  </span>
                ) : 'Fetch →'}
              </button>
            </div>

            {scrapeState === 'error' && (
              <div className="rounded-xl bg-red-50 border border-red-100 px-4 py-3">
                <p className="text-xs text-red-600 font-medium">{scrapeError}</p>
                <p className="text-[10px] text-red-400 mt-0.5">
                  Try the "Paste Text" tab and paste the job description manually.
                </p>
              </div>
            )}

            {scrapeState === 'done' && pastedText.trim().length > 0 && (
              <div className="rounded-xl bg-[#c96442]/[0.06] border border-[#c96442]/20 px-4 py-3 flex items-start gap-2">
                <span className="text-[#c96442] text-sm mt-0.5 flex-shrink-0">✓</span>
                <div className="min-w-0">
                  <p className="text-xs text-[#c96442] font-semibold">Job description fetched</p>
                  <p className="text-[10px] text-[#87867f] mt-0.5 line-clamp-2 leading-relaxed">
                    {pastedText.slice(0, 120)}…
                  </p>
                </div>
              </div>
            )}

            {(scrapeState === 'idle' || scrapeState === 'error') && (
              <p className="text-[10px] text-[#b0aea5] px-1">
                Works best with direct job posting links. LinkedIn and Glassdoor may be blocked — use Paste Text instead.
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Analyzing state
// ─────────────────────────────────────────────────────────────────────────────

const PARSE_STEPS = [
  'Initializing AI Parser…',
  'Analyzing your career structure…',
  'Mapping experience to industry standards…',
  'Optimizing for ATS visibility…',
] as const;

const STEP_INTERVAL_MS = 4_000;

function AnalyzingState() {
  const [activeStep, setActiveStep] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setActiveStep(prev => Math.min(prev + 1, PARSE_STEPS.length - 1));
    }, STEP_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.3 }}
      className="flex flex-col items-center gap-8 py-12"
    >
      <MacMascot state="processing" size={120} />

      <div className="flex flex-col items-start gap-2.5 w-full max-w-xs">
        {PARSE_STEPS.map((label, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, x: -12 }}
            animate={{ opacity: i <= activeStep ? 1 : 0.25, x: 0 }}
            transition={{ delay: i * 0.12, duration: 0.3 }}
            className="flex items-center gap-3"
          >
            <span className={[
              'flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold',
              i < activeStep   ? 'bg-[#c96442] text-white'      :
              i === activeStep ? 'bg-[#c96442] text-white'      :
                                 'bg-[#e8e6dc] text-[#87867f]',
            ].join(' ')}>
              {i < activeStep ? '✓' : i + 1}
            </span>
            <span className={[
              'text-sm font-medium transition-colors duration-500',
              i < activeStep   ? 'text-[#c96442]'  :
              i === activeStep ? 'text-[#141413]'  :
                                 'text-[#b0aea5]',
            ].join(' ')}>
              {label}
            </span>
          </motion.div>
        ))}
      </div>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Teaser Panel
// ─────────────────────────────────────────────────────────────────────────────

interface TeaserPanelProps {
  score:         number | null;
  missingSkills: string[];
  matchedSkills: string[];
  onFixResume:   () => void;
  onStartOver:   () => void;
}

function TeaserPanel({ score, missingSkills, matchedSkills, onFixResume, onStartOver }: TeaserPanelProps) {
  const analysisReady = score !== null;
  const s = score ?? 0;

  const mascotState: MacState =
    !analysisReady ? 'idle' :
    s >= 70 ? 'success' :
    s >= 40 ? 'warning' :
    'shocked';

  const verdict =
    !analysisReady
      ? { headline: 'Analysis unavailable', sub: 'Could not reach the analysis server. You can still proceed to fix your resume.', color: 'text-[#6b6963]', bg: 'bg-[#f5f4f0]', border: 'border-[#e3e0d6]' } :
    s >= 70
      ? { headline: 'Strong match — good foundation!', sub: 'Your resume aligns well. AI can push it further.', color: 'text-green-700', bg: 'bg-green-50', border: 'border-green-200' } :
    s >= 40
      ? { headline: 'Moderate match — needs keywords.', sub: 'ATS may shortlist you, but you\'re likely being filtered out.', color: 'text-amber-700', bg: 'bg-amber-50', border: 'border-amber-200' } :
      { headline: 'ATS will likely reject this resume.', sub: 'Critical keywords are missing. The bot won\'t even show you to a human.', color: 'text-red-700', bg: 'bg-red-50', border: 'border-red-200' };

  return (
    <motion.div
      initial={{ opacity: 0, y: 32, scale: 0.97 }}
      animate={{ opacity: 1, y: 0,  scale: 1 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      className="rounded-3xl bg-white border border-[#e3e0d6] shadow-[0_8px_40px_rgba(0,0,0,0.08)] overflow-hidden"
    >
      {/* Score row */}
      <div className="flex flex-col sm:flex-row items-center gap-6 p-7 sm:p-10">
        <div className="flex-shrink-0">
          <MacMascot state={mascotState} size={110} />
        </div>
        {analysisReady && (
          <div className="flex-shrink-0">
            <AtsScoreDial score={s} size={130} />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full ${verdict.bg} ${verdict.border} border mb-3`}>
            <span className={`text-xs font-bold ${verdict.color}`}>{verdict.headline}</span>
          </div>
          <p className="text-sm text-[#6b6963] leading-relaxed">{verdict.sub}</p>

          {analysisReady && missingSkills.length > 0 && (
            <div className="mt-4">
              <p className="text-[10px] font-bold text-[#b0aea5] uppercase tracking-widest mb-2">
                Critical Missing Keywords
              </p>
              <div className="flex flex-wrap gap-1.5">
                {missingSkills.slice(0, 6).map(kw => (
                  <span key={kw}
                    className="text-xs font-semibold text-red-600 bg-red-50 border border-red-200 px-2.5 py-1 rounded-full">
                    – {kw}
                  </span>
                ))}
                {missingSkills.length > 6 && (
                  <span className="text-xs font-medium text-[#b0aea5] px-2 py-1">
                    +{missingSkills.length - 6} more
                  </span>
                )}
              </div>
            </div>
          )}

          {analysisReady && matchedSkills.length > 0 && (
            <div className="mt-3">
              <p className="text-[10px] font-bold text-[#b0aea5] uppercase tracking-widest mb-1.5">
                Already Matched
              </p>
              <div className="flex flex-wrap gap-1">
                {matchedSkills.slice(0, 4).map(kw => (
                  <span key={kw}
                    className="text-[10px] font-semibold text-[#c96442] bg-[#c96442]/[0.07] border border-[#c96442]/25 px-2 py-0.5 rounded-full">
                    ✓ {kw}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* CTA strip */}
      <div className="border-t border-[#e3e0d6] bg-[#f5f4f0]/60 p-5 sm:p-7 flex flex-col sm:flex-row gap-3 items-center">
        <button
          onClick={onFixResume}
          className={[
            'flex-1 sm:flex-none flex items-center justify-center gap-2 px-8 py-3.5',
            'rounded-2xl text-white font-bold text-sm',
            'transition-all duration-200 active:scale-[0.98]',
            'hover:-translate-y-0.5',
          ].join(' ')}
          style={{
            background: 'linear-gradient(135deg, #c96442 0%, #e07a52 100%)',
            boxShadow: '0 4px 20px rgba(201,100,66,0.30)',
          }}
        >
          🔧 Fix My Resume Now
        </button>
        <button
          onClick={onFixResume}
          className={[
            'flex-1 sm:flex-none flex items-center justify-center gap-2 px-7 py-3.5',
            'rounded-2xl bg-white hover:bg-[#f5f4f0] active:scale-[0.98]',
            'text-[#141413] font-semibold text-sm border border-[#e3e0d6] shadow-sm',
            'transition-all duration-150',
          ].join(' ')}
        >
          🎤 Interview Prep
        </button>
        <button
          onClick={onStartOver}
          className="text-sm text-[#b0aea5] hover:text-[#6b6963] transition-colors underline-offset-2 hover:underline self-center sm:ml-auto"
        >
          Start over
        </button>
      </div>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Navbar
// ─────────────────────────────────────────────────────────────────────────────

function Navbar() {
  return (
    <nav className="fixed top-0 inset-x-0 z-40 border-b border-[#e3e0d6] bg-[#f5f3ec]/90 backdrop-blur-xl">
      <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
        {/* Logo */}
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-[#c96442] flex items-center justify-center flex-shrink-0">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-white">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <polyline points="14,2 14,8 20,8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <span className="font-black text-[1.05rem] tracking-tight text-[#141413] select-none">
            Jobif<span className="text-[#c96442]">AI</span>
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button className="text-sm font-medium text-[#6b6963] hover:text-[#141413] transition-colors px-3 py-1.5 rounded-lg hover:bg-[#e8e6dc]">
            Sign In
          </button>
          <button
            className="text-sm font-semibold text-white px-4 py-1.5 rounded-lg transition-all duration-200 hover:-translate-y-0.5"
            style={{
              background: 'linear-gradient(135deg, #c96442 0%, #e07a52 100%)',
              boxShadow: '0 1px 4px rgba(201,100,66,0.35)',
            }}
          >
            Pricing
          </button>
        </div>
      </div>
    </nav>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

export default function LandingPage() {
  const navigate = useNavigate();
  const user     = useAuthStore(s => s.user);

  const parseAndLoadDocument = useDocumentStore(s => s.parseAndLoadDocument);
  const setJobDescription    = useDocumentStore(s => s.setJobDescription);

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [errorMsg,    setErrorMsg]    = useState('');

  const [cvMode,       setCvMode]       = useState<CvInputMode>('file');
  const [cvFile,       setCvFile]       = useState<File | null>(null);
  const [cvPastedText, setCvPastedText] = useState('');

  const [jdMode,        setJdMode]        = useState<JdInputMode>('paste');
  const [jdPastedText,  setJdPastedText]  = useState('');
  const [jdUrl,         setJdUrl]         = useState('');
  const [jdScrapeState, setJdScrapeState] = useState<JdScrapeState>('idle');
  const [jdScrapeError, setJdScrapeError] = useState('');

  const resolvedCvTextRef = useRef('');
  const resolvedJdTextRef = useRef('');

  const [authOpen,   setAuthOpen]   = useState(false);
  const [authIntent, setAuthIntent] = useState<AuthIntent>('general');

  const activeText = cvMode === 'paste' ? cvPastedText.trim() : '';

  const cvReady =
    (cvMode === 'file'  && cvFile !== null) ||
    (cvMode === 'paste' && activeText.length >= CV_MIN_CHARS);
  const jdReady =
    (jdMode === 'paste' && jdPastedText.trim().length >= JD_MIN_CHARS) ||
    (jdMode === 'url'   && jdScrapeState === 'done' && jdPastedText.trim().length >= JD_MIN_CHARS);

  const canAnalyze = activeText.length >= CV_MIN_CHARS && !isAnalyzing;

  const handleFetchJd = useCallback(async () => {
    const url = jdUrl.trim();
    if (!url) return;
    setJdScrapeState('fetching');
    setJdScrapeError('');
    try {
      const res = await parseJob({ url });
      if (res.success && res.text.trim().length >= JD_MIN_CHARS) {
        setJdPastedText(res.text);
        setJdScrapeState('done');
      } else if (res.success) {
        setJdScrapeState('error');
        setJdScrapeError('The fetched page had too little text. Try pasting manually.');
      } else {
        setJdScrapeState('error');
        setJdScrapeError(res.error_hint || 'Could not fetch the job posting. Paste the text manually.');
      }
    } catch {
      setJdScrapeState('error');
      setJdScrapeError('Network error. Please check your connection and try again.');
    }
  }, [jdUrl]);

  const handleAnalyze = async () => {
    if (!activeText) return;
    setIsAnalyzing(true);
    setErrorMsg('');
    try {
      await parseAndLoadDocument(activeText, jdPastedText.trim());
      setJobDescription(jdPastedText.trim());
      navigate('/workspace');
    } catch (error) {
      console.error('[LandingPage] Parsing failed:', error);
      setErrorMsg('Failed to parse resume. Check the browser console.');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleFixResume = useCallback((_intent: AuthIntent = 'fix-resume') => {
    navigate('/workspace');
  }, [navigate]);

  const handleStartOver = useCallback(() => {
    setIsAnalyzing(false);
    setErrorMsg('');
    setCvFile(null);
    setCvPastedText('');
    setJdPastedText('');
    setJdUrl('');
    setJdScrapeState('idle');
    setJdScrapeError('');
  }, []);

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="h-full overflow-y-auto scrollbar-hidden bg-[#f5f3ec]">
      <DevNav />
      <Navbar />

      {/* Subtle decorative warmth — purely cosmetic */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden" aria-hidden="true">
        <div className="absolute -top-40 left-1/2 -translate-x-1/2 w-[900px] h-[500px] rounded-full bg-[#c96442]/[0.04] blur-[160px]" />
      </div>

      <main className="relative pt-24 pb-20 px-4 max-w-5xl mx-auto">

        {/* ── Hero ────────────────────────────────────────────────────── */}
        <section className="text-center pt-10 pb-10">

          {/* Trust badge */}
          <motion.div
            initial={{ opacity: 0, y: -12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            className="inline-flex items-center gap-2 rounded-full border border-[#c96442]/25 bg-[#c96442]/[0.06] px-4 py-1.5 mb-6"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-[#c96442] animate-pulse" />
            <span className="text-[11px] font-bold text-[#c96442] uppercase tracking-widest">
              Free ATS Analysis · No signup required
            </span>
          </motion.div>

          <motion.h1
            initial={{ opacity: 0, y: -16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.05, ease: [0.16, 1, 0.3, 1] }}
            className="text-4xl sm:text-5xl lg:text-[3.75rem] font-black text-[#141413] tracking-tight leading-[1.08]"
            style={{ fontFamily: 'Georgia, serif' }}
          >
            Does your resume{' '}
            <span style={{ color: '#c96442' }}>beat the bot?</span>
          </motion.h1>

          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.25, duration: 0.5 }}
            className="mt-5 text-lg sm:text-xl text-[#6b6963] font-medium max-w-xl mx-auto leading-relaxed"
          >
            Get a real AI score in 30 seconds — see exactly which keywords
            are killing your chances.
          </motion.p>

          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.4, duration: 0.4 }}
            className="mt-3 text-xs text-[#b0aea5] font-medium"
          >
            Trusted by 1,200+ job seekers this month
          </motion.p>
        </section>

        {/* ── Content area ─────────────────────────────────────────────── */}
        <AnimatePresence mode="wait">

          {/* IDLE / ERROR state */}
          {!isAnalyzing && (
            <motion.div
              key="intake"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -16 }}
              transition={{ duration: 0.3 }}
            >
              {/* Error banner */}
              {!!errorMsg && (
                <motion.div
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mb-5 rounded-2xl bg-red-50 border border-red-200 px-5 py-4 flex items-start gap-3"
                >
                  <span className="text-red-500 text-lg flex-shrink-0">⚠️</span>
                  <div>
                    <p className="text-sm font-semibold text-red-700">{errorMsg}</p>
                    <p className="text-xs text-red-500 mt-0.5">Please fix the issue above and try again.</p>
                  </div>
                </motion.div>
              )}

              {/* Dual intake cards */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
                <ResumeInputCard
                  mode={cvMode}
                  onModeChange={m => { setCvMode(m); setCvFile(null); setCvPastedText(''); }}
                  file={cvFile}
                  onFile={setCvFile}
                  pastedText={cvPastedText}
                  onPastedText={setCvPastedText}
                  disabled={false}
                />
                <JdInputCard
                  mode={jdMode}
                  onModeChange={m => { setJdMode(m); setJdPastedText(''); setJdScrapeState('idle'); }}
                  pastedText={jdPastedText}
                  onPastedText={setJdPastedText}
                  urlValue={jdUrl}
                  onUrlChange={setJdUrl}
                  scrapeState={jdScrapeState}
                  scrapeError={jdScrapeError}
                  onFetch={handleFetchJd}
                  disabled={false}
                />
              </div>

              {/* Analyze CTA */}
              <div className="flex flex-col items-center gap-3">
                <button
                  onClick={handleAnalyze}
                  disabled={!canAnalyze}
                  className={[
                    'relative px-12 py-4 rounded-2xl font-bold text-base',
                    'transition-all duration-200 active:scale-[0.97]',
                    canAnalyze
                      ? 'text-white hover:-translate-y-0.5 cursor-pointer'
                      : 'bg-[#e8e6dc] text-[#b0aea5] cursor-not-allowed',
                  ].join(' ')}
                  style={canAnalyze ? {
                    background: 'linear-gradient(135deg, #c96442 0%, #e07a52 100%)',
                    boxShadow: '0 4px 20px rgba(201,100,66,0.35)',
                  } : undefined}
                >
                  Analyze My Resume →
                </button>
                <AnimatePresence>
                  {!canAnalyze && (
                    <motion.p
                      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                      className="text-xs text-[#b0aea5] text-center"
                    >
                      {!cvReady ? 'Add your resume to continue' : 'Ready to analyze'}
                    </motion.p>
                  )}
                </AnimatePresence>
              </div>
            </motion.div>
          )}

          {/* ANALYZING state */}
          {isAnalyzing && (
            <motion.div
              key="analyzing"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
            >
              <AnalyzingState />
            </motion.div>
          )}

        </AnimatePresence>

        {/* ── Value props ───────────────────────────────────────────────── */}
        <AnimatePresence>
          {!isAnalyzing && !errorMsg && (
            <motion.div
              key="props"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ delay: 0.4, duration: 0.5 }}
              className="mt-16 grid grid-cols-1 sm:grid-cols-3 gap-4 text-center"
            >
              {[
                { icon: '🎯', iconBg: 'bg-[#c96442]/[0.08]', title: 'Semantic scoring',  body: 'Real AI embeddings — not keyword counting' },
                { icon: '✂️', iconBg: 'bg-[#e8e6dc]',         title: 'Targeted rewrites', body: 'AI rewrites every bullet to hit JD keywords' },
                { icon: '🔒', iconBg: 'bg-[#e8e6dc]',         title: 'Your data only',    body: 'Stored against your account — nothing shared' },
              ].map(item => (
                <motion.div
                  key={item.title}
                  whileHover={{ y: -3 }}
                  transition={{ duration: 0.2 }}
                  className="rounded-2xl bg-white border border-[#e3e0d6] px-5 py-7 shadow-sm hover:shadow-md hover:border-[#c96442]/30 transition-all duration-200"
                >
                  <div className={`w-10 h-10 ${item.iconBg} rounded-2xl flex items-center justify-center text-xl mx-auto mb-3`}>
                    {item.icon}
                  </div>
                  <p className="font-bold text-sm text-[#141413]">{item.title}</p>
                  <p className="mt-1.5 text-xs text-[#87867f] leading-relaxed">{item.body}</p>
                </motion.div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

      </main>

      <AuthModal
        isOpen={authOpen}
        onClose={() => setAuthOpen(false)}
        intent={authIntent}
      />
    </div>
  );
}
