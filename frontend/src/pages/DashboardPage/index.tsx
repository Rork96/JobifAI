/**
 * DashboardPage — Route: /dashboard  (protected)
 * PRD §3 — Central Hub
 *
 * Layout (PRD §3 ASCII):
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ NAVBAR: JobifAI logo · user email · Sign Out             │
 *   ├──────────────────────────────────────────────────────────┤
 *   │ CONTEXT BAR                             [MAC MASCOT]     │
 *   │  📄 resume.pdf  ·  💼 Software Engineer...  ·  ATS: 34  │
 *   │  [Change Documents]                                      │
 *   ├──────────────────────────────────────────────────────────┤
 *   │ HARDCORE MENTOR MODE TOGGLE                              │
 *   ├──────────────────────────────────────────────────────────┤
 *   │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
 *   │  │  Fix Resume  │  │  Interview   │  │ Cover Letter │  │
 *   │  │  (available) │  │  (1 free)    │  │ 🔒 premium   │  │
 *   │  └──────────────┘  └──────────────┘  └──────────────┘  │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Mobile: cards collapse to single-column, order: Resume → Interview → Cover Letter
 *
 * Phase 4 wiring points (marked TODO):
 *   - Replace hardcoded context bar with useDocumentStore state
 *   - Wire Hardcore toggle PATCH /api/user/me
 *   - Wire action card navigation with useSessionStore.setOnboardingMode
 *   - Replace MacMascot placeholder with useSessionStore.macState
 */

import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import DevNav from '@/shared/ui/DevNav';
import MacMascot from '@/shared/ui/MacMascot';
import { useAuthStore } from '@/store/useAuthStore';
import { useSessionStore } from '@/store/useSessionStore';

// ── Hardcoded context (Phase 4: replace with useDocumentStore) ────────────────

const MOCK_CV_NAME    = 'resume_2024.pdf';
const MOCK_JD_SNIPPET = 'Senior TypeScript Engineer @ Acme Corp';
const MOCK_ATS_SCORE  = 34;

// ── Navbar ────────────────────────────────────────────────────────────────────

function Navbar() {
  const navigate = useNavigate();
  const user     = useAuthStore(s => s.user);

  const handleSignOut = () => {
    useAuthStore.getState().clearAuth();
    navigate('/');
  };

  return (
    <nav className="fixed top-0 inset-x-0 z-40 glass border-b border-white/20">
      <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
        <span className="font-bold text-lg tracking-tight text-slate-900">
          Jobif<span className="text-brand-600">AI</span>
        </span>
        <div className="flex items-center gap-3">
          {user && (
            <span className="hidden sm:block text-xs text-slate-400 font-mono truncate max-w-[180px]">
              {user.email}
            </span>
          )}
          <button
            onClick={handleSignOut}
            className="text-sm font-medium text-slate-600 hover:text-slate-900
                       transition-colors px-3 py-1.5 rounded-lg hover:bg-slate-100"
          >
            Sign Out
          </button>
        </div>
      </div>
    </nav>
  );
}

// ── Context Bar ───────────────────────────────────────────────────────────────

interface ContextBarProps {
  cvName: string;
  jdSnippet: string;
  atsScore: number;
}

function ContextBar({ cvName, jdSnippet, atsScore }: ContextBarProps) {
  const scoreColor =
    atsScore >= 70 ? 'text-green-600' :
    atsScore >= 40 ? 'text-amber-600' :
    'text-red-600';

  return (
    <div className="rounded-2xl bg-white border border-slate-200 shadow-sm p-4 sm:p-5">
      <div className="flex items-start gap-4">
        {/* Left: CV / JD meta + change button */}
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">
            Active Application
          </p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            {/* CV pill */}
            <div className="flex items-center gap-1.5">
              <span className="text-base">📄</span>
              <span className="text-sm font-medium text-slate-700 truncate max-w-[140px]">
                {cvName}
              </span>
            </div>
            <span className="text-slate-200 hidden sm:block">|</span>
            {/* JD pill */}
            <div className="flex items-center gap-1.5">
              <span className="text-base">💼</span>
              <span className="text-sm font-medium text-slate-700 truncate max-w-[200px]">
                {jdSnippet}
              </span>
            </div>
            <span className="text-slate-200 hidden sm:block">|</span>
            {/* ATS score badge */}
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-semibold text-slate-400">ATS</span>
              <span className={`text-sm font-bold tabular-nums ${scoreColor}`}>
                {atsScore}
                <span className="text-slate-300 font-normal">/100</span>
              </span>
            </div>
          </div>
          <button className="mt-3 text-xs font-medium text-brand-600 hover:text-brand-700
                             hover:underline transition-colors">
            Change Documents
          </button>
        </div>

        {/* Right: Mac Mascot placeholder (PRD §3.4) */}
        <div className="flex-shrink-0 hidden sm:block">
          {/* TODO Phase 4: drive state from useSessionStore.macState */}
          <MacMascot state="idle" size={80} />
        </div>
      </div>
    </div>
  );
}

// ── Hardcore Mode Toggle ──────────────────────────────────────────────────────

function HardcoreToggle() {
  const isHardcore    = useSessionStore(s => s.isHardcoreMode);
  const toggleHardcore = useSessionStore(s => s.toggleHardcoreMode);

  return (
    <div className={`
      rounded-2xl border p-4 sm:p-5 flex items-center justify-between gap-4
      transition-colors duration-300
      ${isHardcore
        ? 'bg-red-950/5 border-red-300'
        : 'bg-white border-slate-200'}
    `}>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-base">{isHardcore ? '🔥' : '🧘'}</span>
          <span className="font-semibold text-sm text-slate-900">
            Hardcore Mentor Mode
          </span>
          {isHardcore && (
            <span className="text-xs font-bold text-red-600 bg-red-100 px-2 py-0.5 rounded-full">
              ON
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-slate-500 leading-relaxed">
          {isHardcore
            ? 'Brutal, unfiltered feedback. Your recruiter will not be this kind.'
            : 'Activate for no-fluff, recruiter-brutal feedback on every suggestion.'}
        </p>
      </div>

      {/* Toggle switch */}
      <button
        onClick={() => {
          // TODO Phase 4: fire PATCH /api/user/me after toggle
          toggleHardcore();
        }}
        aria-pressed={isHardcore}
        className={`
          relative flex-shrink-0 w-11 h-6 rounded-full transition-colors duration-200
          focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2
          ${isHardcore
            ? 'bg-red-500 focus-visible:ring-red-500'
            : 'bg-slate-200 focus-visible:ring-brand-500'}
        `}
      >
        <span className={`
          absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-sm
          transition-transform duration-200
          ${isHardcore ? 'translate-x-5' : 'translate-x-0'}
        `} />
      </button>
    </div>
  );
}

// ── Action Cards ──────────────────────────────────────────────────────────────

type CardVariant = 'available' | 'quota' | 'premium-only';

interface ActionCardProps {
  icon: string;
  title: string;
  description: string;
  cta: string;
  variant: CardVariant;
  quotaLabel?: string;
  onClick: () => void;
  delay?: number;
}

function ActionCard({
  icon, title, description, cta, variant, quotaLabel, onClick, delay = 0,
}: ActionCardProps) {
  const isLocked = variant === 'premium-only';

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: 'easeOut', delay }}
      className={`
        relative flex flex-col rounded-2xl border p-5 sm:p-6
        transition-shadow duration-200
        ${isLocked
          ? 'bg-slate-50 border-slate-200'
          : 'bg-white border-slate-200 hover:shadow-card cursor-pointer group'}
      `}
      onClick={!isLocked ? onClick : undefined}
    >
      {/* Lock badge */}
      {isLocked && (
        <div className="absolute top-3 right-3 flex items-center gap-1
                        bg-amber-100 text-amber-700 text-xs font-bold
                        px-2 py-0.5 rounded-full">
          🔒 Premium
        </div>
      )}

      {/* Icon */}
      <div className={`
        w-12 h-12 rounded-xl flex items-center justify-center text-2xl mb-4
        ${isLocked ? 'bg-slate-100' : 'bg-brand-50 group-hover:bg-brand-100 transition-colors'}
      `}>
        {icon}
      </div>

      {/* Copy */}
      <h3 className={`font-bold text-base mb-1 ${isLocked ? 'text-slate-400' : 'text-slate-900'}`}>
        {title}
      </h3>
      <p className={`text-sm leading-relaxed flex-1 ${isLocked ? 'text-slate-400' : 'text-slate-500'}`}>
        {description}
      </p>

      {/* Quota badge */}
      {quotaLabel && !isLocked && (
        <div className="mt-3 inline-flex items-center gap-1 text-xs font-semibold
                        text-brand-600 bg-brand-50 px-2.5 py-1 rounded-full w-fit">
          {quotaLabel}
        </div>
      )}

      {/* CTA */}
      <button
        disabled={isLocked}
        className={`
          mt-4 w-full flex items-center justify-center gap-2 px-4 py-2.5
          rounded-xl font-semibold text-sm transition-all duration-150
          ${isLocked
            ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
            : 'bg-brand-600 hover:bg-brand-700 active:scale-[0.98] text-white shadow-brand'}
        `}
      >
        {cta}
      </button>
    </motion.div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const navigate = useNavigate();

  return (
    <div className="h-full overflow-y-auto scrollbar-hidden bg-bg">
      <DevNav />
      <Navbar />

      {/* Offset: DevNav (41px) + Navbar (56px) */}
      <main className="pt-24 pb-16 px-4 max-w-5xl mx-auto">

        {/* ── WELCOME HEADING ─────────────────────────────────── */}
        <motion.div
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="mb-6"
        >
          <h1 className="text-2xl sm:text-3xl font-black text-slate-900 tracking-tight">
            Your Career Hub
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Pick a tool to start improving your application.
          </p>
        </motion.div>

        {/* ── CONTEXT BAR ──────────────────────────────────────── */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.05 }}
          className="mb-4"
        >
          <ContextBar
            cvName={MOCK_CV_NAME}
            jdSnippet={MOCK_JD_SNIPPET}
            atsScore={MOCK_ATS_SCORE}
          />
        </motion.div>

        {/* ── HARDCORE TOGGLE ──────────────────────────────────── */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.1 }}
          className="mb-6"
        >
          <HardcoreToggle />
        </motion.div>

        {/* ── ACTION CARDS ─────────────────────────────────────── */}
        {/* Single column mobile, 3-col md+. Order: Resume → Interview → Cover Letter */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <ActionCard
            icon="🔧"
            title="Fix My Resume"
            description="AI rewrites every bullet point to match the job description and pass ATS keyword filters."
            cta="Start Fixing"
            variant="available"
            quotaLabel="3 free rewrites"
            onClick={() => navigate('/workspace?mode=resume')}
            delay={0.15}
          />
          <ActionCard
            icon="🎤"
            title="Interview Prep"
            description="Practice answers to role-specific questions with real-time AI coaching and follow-ups."
            cta="Start Prep"
            variant="quota"
            quotaLabel="1 free session"
            onClick={() => navigate('/workspace?mode=interview')}
            delay={0.2}
          />
          <ActionCard
            icon="✉️"
            title="Cover Letter"
            description="Generate a tailored, job-specific cover letter that complements your rewritten resume."
            cta="Unlock — $5"
            variant="premium-only"
            onClick={() => navigate('/paywall')}
            delay={0.25}
          />
        </div>

      </main>
    </div>
  );
}
