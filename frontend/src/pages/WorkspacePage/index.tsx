/**
 * WorkspacePage — Route: /workspace?mode=resume|interview|cover  (protected)
 * PRD §4 — Sandwich UI Protocol
 *
 * Two-panel layout:
 *   Left/Main  — Resume Panel: document sections + SandwichDiffInline (PRD §4.1)
 *   Right      — Mac Coaching Panel: mascot + coaching copy + keyword chips
 *
 * Mobile-first column order (PRD §4):
 *   <768px  : CoachingPanel stacked ABOVE ResumePanel (flex-col, coaching first in DOM)
 *   ≥768px  : flex-row-reverse → CoachingPanel on right, ResumePanel on left
 *
 * Sandwich UI visual layers (PRD §4.1):
 *   Top    — SandwichDiffInline: proposed text + score chip + Accept/Reject
 *   Middle — Targeted bullet: amber highlight (also shown during loading)
 *   Bottom — All other resume content: opacity-40
 *
 * Phase 8 wiring:
 *   - Clicking a bullet triggers POST /api/rewrite-section via
 *     useDocumentStore.improveBullet() — real Gemini response.
 *   - Loading state: bullet shows amber highlight + SandwichDiffInline skeleton.
 *   - Accept: calls applyDiff() + bumpAtsScore() → local bullet text replaced.
 *   - Reject: calls rejectDiff() → sandwich dismissed.
 *   - Mac mascot: processing (loading) → warning (diff ready) → idle (clean).
 *   - Error handling: ApiError → toast, bullet reverts to normal state.
 *   - AbortController: clicking a second bullet cancels the in-flight request.
 *
 * TODO Phase 9:
 *   - Replace MOCK_RESUME with useDocumentStore.resumeData (structured sections)
 *   - Replace MOCK_RESUME_HEADER with real user data from DB
 *   - Wire onAccept to DB persist (updateResumeScore / content_json patch)
 */

import { useRef, useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import DevNav from '@/shared/ui/DevNav';
import MacMascot from '@/shared/ui/MacMascot';
import SandwichDiffInline from '@/shared/ui/SandwichDiffInline';
import { useSessionStore }  from '@/store/useSessionStore';
import { useAuthStore }     from '@/store/useAuthStore';
import { useDocumentStore, type PendingDiff } from '@/store/useDocumentStore';

// ── Types ─────────────────────────────────────────────────────────────────────

type WorkspaceMode = 'resume' | 'interview' | 'cover';

interface ResumeBullet {
  id:   string;
  text: string;
}

interface ResumeSection {
  id:       string;
  company:  string;
  role:     string;
  period:   string;
  location: string;
  bullets:  ResumeBullet[];
}

// ── Mock resume data (Phase 9: replace with useDocumentStore.resumeData) ──────
// The resume sections are kept local so Accept can update text optimistically.
// Real structured resume data from the DB is wired in Phase 9.

const MOCK_RESUME_HEADER = {
  name:    'Alex Johnson',
  title:   'Software Engineer',
  contact: 'alex@example.com · github.com/alexj · San Francisco, CA',
};

const INITIAL_SECTIONS: ResumeSection[] = [
  {
    id:       'acme',
    company:  'Acme Corporation',
    role:     'Software Engineer',
    period:   'Jan 2022 – Present',
    location: 'San Francisco, CA',
    bullets:  [
      {
        id:   'acme-b0',
        text: 'Built internal tooling for the data team using Python and SQL, reducing manual reporting time by 3 hours/week.',
      },
      {
        id:   'acme-b1',
        text: 'Worked on frontend features for the main product dashboard.',
      },
      {
        id:   'acme-b2',
        text: 'Participated in code reviews and improved team collaboration processes.',
      },
    ],
  },
  {
    id:       'startup',
    company:  'StartupXYZ',
    role:     'Junior Developer',
    period:   'Jun 2020 – Dec 2021',
    location: 'Remote',
    bullets:  [
      {
        id:   'startup-b0',
        text: 'Maintained legacy codebase and resolved critical production bugs, achieving 99.2% uptime.',
      },
      {
        id:   'startup-b1',
        text: 'Helped migrate the deployment pipeline to AWS infrastructure.',
      },
    ],
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a condensed "other bullets" context string for the rewrite API.
 * Excludes the targeted bullet to prevent the AI echoing it back.
 * Truncated to 1 400 chars — the backend cap is 1 500.
 */
function buildResumeContext(sections: ResumeSection[], excludeBulletId: string): string {
  return sections
    .flatMap(s => s.bullets)
    .filter(b => b.id !== excludeBulletId)
    .map(b => b.text)
    .join(' | ')
    .slice(0, 1400);
}

// ── Navbar ────────────────────────────────────────────────────────────────────

function WorkspaceNavbar({ mode, atsScore }: { mode: WorkspaceMode; atsScore: number | null }) {
  const navigate = useNavigate();
  const user     = useAuthStore(s => s.user);

  const MODE_BADGE: Record<WorkspaceMode, { label: string; color: string }> = {
    resume:    { label: 'Fix Resume',     color: 'bg-brand-100 text-brand-700' },
    interview: { label: 'Interview Prep', color: 'bg-blue-100 text-blue-700'  },
    cover:     { label: 'Cover Letter',   color: 'bg-pink-100 text-pink-700'  },
  };
  const badge = MODE_BADGE[mode];

  return (
    <nav className="fixed top-0 inset-x-0 z-40 glass border-b border-white/20">
      <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between gap-3">
        {/* Left: logo + back */}
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={() => navigate('/dashboard')}
            className="text-slate-400 hover:text-slate-700 transition-colors text-sm"
            aria-label="Back to Hub"
          >
            ← Hub
          </button>
          <span className="text-slate-200 hidden sm:block">|</span>
          <span className="font-bold text-base tracking-tight text-slate-900 hidden sm:block">
            Jobif<span className="text-brand-600">AI</span>
          </span>
        </div>

        {/* Centre: mode badge */}
        <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${badge.color}`}>
          {badge.label}
        </span>

        {/* Right: ATS score + email */}
        <div className="flex items-center gap-3">
          <div className="hidden sm:flex items-center gap-1 text-xs">
            <span className="text-slate-400 font-medium">ATS</span>
            {atsScore !== null ? (
              <span className={`font-bold tabular-nums ${
                atsScore >= 70 ? 'text-green-600' :
                atsScore >= 40 ? 'text-amber-600' :
                'text-red-600'
              }`}>
                {atsScore}<span className="text-slate-300 font-normal">/100</span>
              </span>
            ) : (
              <span className="text-slate-400">—</span>
            )}
          </div>
          {user && (
            <span className="hidden md:block text-xs text-slate-400 font-mono truncate max-w-[140px]">
              {user.email}
            </span>
          )}
        </div>
      </div>
    </nav>
  );
}

// ── Coaching Panel (right column) ─────────────────────────────────────────────

interface CoachingPanelProps {
  isImproving:    boolean;
  hasPendingDiff: boolean;
  diff:           PendingDiff | null;
  atsScore:       number | null;
  missingSkills:  string[];
  matchedSkills:  string[];
  atsGaps:        string[];
}

function CoachingPanel({
  isImproving,
  hasPendingDiff,
  diff,
  atsScore,
  missingSkills,
  matchedSkills,
  atsGaps,
}: CoachingPanelProps) {
  // Derive missing keywords: prefer structured missingSkills, fall back to atsGaps
  const displayMissing: string[] = missingSkills.length > 0
    ? missingSkills
    : atsGaps
        .map(g => {
          // Strip the "Missing: "TypeScript" (appears 6× in JD)" prefix to just "TypeScript"
          const m = g.match(/["']([^"']+)["']/);
          return m ? m[1] : g;
        })
        .slice(0, 5);

  const macState: 'idle' | 'processing' | 'warning' =
    isImproving    ? 'processing' :
    hasPendingDiff ? 'warning'    :
    'idle';

  const macSays =
    isImproving
      ? 'Analysing your bullet against the job description…'
      : hasPendingDiff && diff
        ? `Review the AI suggestion below. Accepting will add +${diff.scoreImpact} ATS pts.`
        : 'Click any bullet to get an instant AI rewrite suggestion.';

  return (
    <aside className="flex flex-col gap-4">

      {/* Mascot + copy */}
      <div className="rounded-2xl bg-white border border-slate-200 p-4 flex items-center gap-4">
        <MacMascot state={macState} size={72} />
        <div className="min-w-0">
          <p className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-0.5">
            Mac Says
          </p>
          <p className="text-sm text-slate-700 leading-snug">{macSays}</p>
        </div>
      </div>

      {/* ATS score panel */}
      <div className="rounded-2xl bg-white border border-slate-200 p-4">
        <p className="text-xs font-bold text-slate-400 uppercase tracking-wide mb-2">
          Current ATS Score
        </p>
        <div className="flex items-baseline gap-1">
          {atsScore !== null ? (
            <>
              <span className={`text-3xl font-black tabular-nums ${
                atsScore >= 70 ? 'text-green-600' :
                atsScore >= 40 ? 'text-amber-600' :
                'text-red-600'
              }`}>{atsScore}</span>
              <span className="text-sm text-slate-400">/100</span>
            </>
          ) : (
            <span className="text-3xl font-black text-slate-300">—</span>
          )}
          {hasPendingDiff && diff && (
            <span className="ml-2 text-xs font-bold text-green-600 bg-green-50
                             border border-green-200 px-2 py-0.5 rounded-full">
              +{diff.scoreImpact} if accepted
            </span>
          )}
        </div>
        {atsScore !== null && atsScore < 50 && (
          <p className="mt-1 text-xs text-red-600 font-medium">
            ATS may reject this resume.
          </p>
        )}
      </div>

      {/* Keyword panels */}
      <div className="rounded-2xl bg-white border border-slate-200 p-4">
        {displayMissing.length > 0 ? (
          <>
            <p className="text-xs font-bold text-slate-400 uppercase tracking-wide mb-3">
              Missing Keywords
            </p>
            <div className="flex flex-wrap gap-2 mb-4">
              {displayMissing.map(kw => (
                <span
                  key={kw}
                  className="text-xs font-semibold text-red-600 bg-red-50
                             border border-red-200 px-2.5 py-1 rounded-full"
                >
                  – {kw}
                </span>
              ))}
            </div>
          </>
        ) : (
          <p className="text-xs text-slate-400 mb-4">
            Run ATS analysis from the dashboard to see keyword gaps.
          </p>
        )}

        {matchedSkills.length > 0 && (
          <>
            <p className="text-xs font-bold text-slate-400 uppercase tracking-wide mb-3">
              Matched Keywords
            </p>
            <div className="flex flex-wrap gap-2">
              {matchedSkills.map(kw => (
                <span
                  key={kw}
                  className="text-xs font-semibold text-green-700 bg-green-50
                             border border-green-200 px-2.5 py-1 rounded-full"
                >
                  ✓ {kw}
                </span>
              ))}
            </div>
          </>
        )}
      </div>

    </aside>
  );
}

// ── Resume Panel (left/main column) ──────────────────────────────────────────

interface ResumePanelProps {
  sections:          ResumeSection[];
  pendingDiff:       PendingDiff | null;
  improvingBulletId: string | null;
  onBulletClick:     (bullet: ResumeBullet, section: ResumeSection) => void;
  onAccept:          () => void;
  onReject:          () => void;
}

function ResumePanel({
  sections,
  pendingDiff,
  improvingBulletId,
  onBulletClick,
  onAccept,
  onReject,
}: ResumePanelProps) {
  const hasDiff = pendingDiff !== null;

  return (
    <div className="rounded-2xl bg-white border border-slate-200 shadow-sm overflow-hidden">
      {/* Resume header */}
      <div className="border-b border-slate-100 p-5 sm:p-7">
        <h2 className="text-xl sm:text-2xl font-black text-slate-900">
          {MOCK_RESUME_HEADER.name}
        </h2>
        <p className="text-sm font-semibold text-brand-600 mt-0.5">
          {MOCK_RESUME_HEADER.title}
        </p>
        <p className="text-xs text-slate-400 mt-1">
          {MOCK_RESUME_HEADER.contact}
        </p>
      </div>

      {/* Experience sections */}
      <div className="p-5 sm:p-7 space-y-7">
        <p className="text-xs font-bold text-slate-400 uppercase tracking-widest -mb-3">
          Experience
        </p>

        {sections.map((section) => {
          const sectionContainsTarget = (hasDiff && section.bullets.some(b => b.id === pendingDiff?.fieldPath))
            || section.bullets.some(b => b.id === improvingBulletId);
          const sectionDimmed = (hasDiff || improvingBulletId !== null) && !sectionContainsTarget;

          return (
            <div
              key={section.id}
              className={`transition-opacity duration-300 ${sectionDimmed ? 'opacity-40' : ''}`}
            >
              {/* Section header */}
              <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-0.5 mb-3">
                <div>
                  <span className="font-bold text-slate-900 text-sm">{section.role}</span>
                  <span className="text-slate-400 text-sm"> · {section.company}</span>
                </div>
                <span className="text-xs text-slate-400 tabular-nums">
                  {section.period} · {section.location}
                </span>
              </div>

              {/* Bullets */}
              <ul className="space-y-1.5">
                {section.bullets.map((bullet) => {
                  const isImproving = bullet.id === improvingBulletId;
                  const isTargeted  = hasDiff && bullet.id === pendingDiff?.fieldPath;
                  const isDimmed    = (hasDiff || improvingBulletId !== null)
                                      && !isTargeted && !isImproving && sectionContainsTarget;

                  // Show amber highlight when: has a diff for this bullet OR is being improved
                  const isHighlighted = isTargeted || isImproving;

                  return (
                    <li key={bullet.id}>
                      {/* Middle layer: original bullet */}
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => onBulletClick(bullet, section)}
                        onKeyDown={e => e.key === 'Enter' && onBulletClick(bullet, section)}
                        aria-label={`Improve bullet: ${bullet.text.slice(0, 40)}…`}
                        className={`
                          flex items-start gap-2 text-sm leading-relaxed
                          transition-all duration-300 rounded-lg
                          ${isDimmed ? 'opacity-40' : ''}
                          ${isHighlighted
                            ? 'bg-amber-50 border border-amber-200 px-3 py-2 -mx-3 cursor-default'
                            : 'px-0 py-0.5 cursor-pointer hover:bg-slate-50 hover:rounded-lg hover:-mx-2 hover:px-2'}
                        `}
                      >
                        <span className={`mt-1.5 flex-shrink-0 w-1.5 h-1.5 rounded-full
                          ${isHighlighted ? 'bg-amber-500' : 'bg-slate-400'}`}
                        />
                        <span className={isHighlighted ? 'text-amber-900 font-medium' : 'text-slate-700'}>
                          {bullet.text}
                        </span>
                        {isHighlighted && !isImproving && (
                          <span className="ml-auto flex-shrink-0 text-xs font-semibold
                                           text-amber-600 bg-amber-100 px-2 py-0.5 rounded-full">
                            original
                          </span>
                        )}
                        {isImproving && (
                          <span className="ml-auto flex-shrink-0 text-xs font-semibold
                                           text-amber-600 bg-amber-100 px-2 py-0.5 rounded-full
                                           flex items-center gap-1">
                            <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
                              <circle className="opacity-25" cx="12" cy="12" r="10"
                                stroke="currentColor" strokeWidth="4" />
                              <path className="opacity-75" fill="currentColor"
                                d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                            </svg>
                            improving…
                          </span>
                        )}
                      </div>

                      {/* Top layer: SandwichDiffInline — shown during loading AND when diff ready */}
                      <AnimatePresence>
                        {(isTargeted || isImproving) && (
                          <SandwichDiffInline
                            key={`sandwich-${bullet.id}`}
                            diff={isTargeted ? pendingDiff : null}
                            loading={isImproving}
                            onAccept={onAccept}
                            onReject={onReject}
                          />
                        )}
                      </AnimatePresence>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}

        {/* Hint when no bullet is selected */}
        {!hasDiff && improvingBulletId === null && (
          <p className="text-xs text-slate-400 text-center pt-2">
            👆 Click any bullet to get an instant AI improvement
          </p>
        )}
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

const VALID_MODES: WorkspaceMode[] = ['resume', 'interview', 'cover'];
const isValidMode = (m: string | null): m is WorkspaceMode =>
  VALID_MODES.includes(m as WorkspaceMode);

export default function WorkspacePage() {
  const [searchParams]  = useSearchParams();
  const { setWorkspaceMode, workspaceMode } = useSessionStore();

  // Local resume state — Phase 9 will hydrate from useDocumentStore.resumeData
  const [sections, setSections] = useState<ResumeSection[]>(INITIAL_SECTIONS);

  // Document store: AI diff state + ATS score + keywords
  const {
    pendingDiff,
    improvingBulletId,
    currentAtsScore,
    missingSkills,
    matchedSkills,
    atsGaps,
    applyDiff,
    rejectDiff,
    bumpAtsScore,
    improveBullet,
  } = useDocumentStore();

  // AbortController ref — cancels in-flight /api/rewrite-section if user clicks
  // a different bullet before the current request resolves.
  const abortRef = useRef<AbortController | null>(null);

  // Hydrate workspaceMode from URL param on mount (PRD §4.8)
  useEffect(() => {
    const modeParam = searchParams.get('mode');
    setWorkspaceMode(isValidMode(modeParam) ? modeParam : 'resume');
  }, [searchParams, setWorkspaceMode]);

  const mode = workspaceMode ?? 'resume';

  // ── Bullet click handler ─────────────────────────────────────────────────

  const handleBulletClick = useCallback((bullet: ResumeBullet, _section: ResumeSection) => {
    // Do nothing if this bullet is already being improved or already has a diff
    if (bullet.id === improvingBulletId) return;
    if (pendingDiff?.fieldPath === bullet.id) return;

    // Cancel any in-flight request for a different bullet
    abortRef.current?.abort();
    abortRef.current = new AbortController();

    const resumeContext = buildResumeContext(sections, bullet.id);
    void improveBullet(bullet.id, bullet.text, resumeContext, abortRef.current.signal);
  }, [improvingBulletId, pendingDiff, sections, improveBullet]);

  // ── Accept handler ───────────────────────────────────────────────────────

  const handleAccept = useCallback(() => {
    if (!pendingDiff) return;

    // Optimistically apply the proposed text to local section state
    setSections(prev =>
      prev.map(section => ({
        ...section,
        bullets: section.bullets.map(b =>
          b.id === pendingDiff.fieldPath
            ? { ...b, text: pendingDiff.proposedText }
            : b
        ),
      }))
    );

    bumpAtsScore(pendingDiff.scoreImpact);
    applyDiff();
    // TODO Phase 9: PATCH /api/resume/accept-diff to persist to DB
  }, [pendingDiff, applyDiff, bumpAtsScore]);

  // ── Reject handler ───────────────────────────────────────────────────────

  const handleReject = useCallback(() => {
    // If still loading, cancel the request
    abortRef.current?.abort();
    abortRef.current = null;
    rejectDiff();
  }, [rejectDiff]);

  // ── Cleanup on unmount ───────────────────────────────────────────────────

  useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);

  return (
    <div className="h-full overflow-y-auto scrollbar-hidden bg-bg">
      <DevNav />
      <WorkspaceNavbar mode={mode} atsScore={currentAtsScore} />

      {/* Offset: DevNav 41px + Navbar 56px */}
      <main className="pt-24 pb-16 px-4 max-w-6xl mx-auto">

        {/*
          Two-panel layout.
          DOM order: CoachingPanel first → appears ABOVE ResumePanel on mobile.
          flex-col on mobile, flex-row-reverse on md+ → Coaching snaps to right column.
        */}
        <div className="flex flex-col md:flex-row-reverse gap-5">

          {/* ── RIGHT: Mac Coaching Panel (top on mobile) ─────── */}
          <div className="w-full md:w-72 lg:w-80 md:flex-shrink-0">
            <div className="md:sticky md:top-24">
              <CoachingPanel
                isImproving={improvingBulletId !== null}
                hasPendingDiff={pendingDiff !== null}
                diff={pendingDiff}
                atsScore={currentAtsScore}
                missingSkills={missingSkills}
                matchedSkills={matchedSkills}
                atsGaps={atsGaps}
              />
            </div>
          </div>

          {/* ── LEFT: Resume Panel (below on mobile) ──────────── */}
          <div className="flex-1 min-w-0">
            <ResumePanel
              sections={sections}
              pendingDiff={pendingDiff}
              improvingBulletId={improvingBulletId}
              onBulletClick={handleBulletClick}
              onAccept={handleAccept}
              onReject={handleReject}
            />
          </div>

        </div>
      </main>
    </div>
  );
}
