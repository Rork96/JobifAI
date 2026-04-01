/**
 * WorkspacePage — Route: /workspace?mode=resume|interview|cover  (protected)
 * PRD §4 — Sandwich UI Protocol
 *
 * Layout (single-column, full-height):
 * ┌──────────────────────────────────────────────────────────────┐
 * │ NAVBAR (fixed, z-40)                        ATS: 72/100     │
 * ├──────────────────────────────────────────────────────────────┤
 * │ RESUME PANEL — full-width, scrollable                       │
 * │  Header: Name / Title / Contact                             │
 * │  ── Experience ──────────────────────────────────────────── │
 * │  • Bullet  ← click to improve (PRD §4.1)                   │
 * │    ┌── SandwichDiffInline ──────────────────────────────┐   │
 * │    │ ✨ AI Suggestion          +6 ATS pts               │   │
 * │    │ [✓ Accept]  [✗ Reject]                             │   │
 * │    └────────────────────────────────────────────────────┘   │
 * │  • Bullet 2 (dimmed)                                        │
 * ├──────────────────────────────────────────────────────────────┤
 * │ BOTTOM SHEET — permanent coaching panel (PRD §4)            │
 * │  ▲ coach  [MacMascot]  "Mac Says…"  ATS: 72              │
 * │  ── (expanded) ────────────────────────────────────────────  │
 * │  Missing: TypeScript · React · CI/CD                        │
 * │  Matched: Python · SQL · Git                                │
 * └──────────────────────────────────────────────────────────────┘
 *
 * PRD §4 mandate: "No sidebars. No modals. No separate tabs."
 *
 * State synchronisation (PRD §4.8):
 *   - On mount: if store has resumeRawText → hydrated (normal navigation).
 *   - On refresh (store is empty): call loadLatestResume(userId).
 *   - If no resume found after load → redirect to /dashboard.
 *   - MacMascot state: processing → success → warning → idle (priority order).
 */

import { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import DevNav          from '@/shared/ui/DevNav';
import MacMascot, { type MacState } from '@/shared/ui/MacMascot';
import SandwichDiffInline from '@/shared/ui/SandwichDiffInline';
import BottomSheet     from '@/shared/ui/BottomSheet';
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

interface ResumeHeader {
  name:    string;
  title:   string;
  contact: string;
}

// ── Resume text → structured section parser ───────────────────────────────────
//
// Converts plain text from /api/upload-resume into ResumeSection[].
// Heuristic: detects bullet-prefixed lines and section headers.
// Falls back to EMPTY_SECTIONS if no bullets are found (shouldn't happen
// in practice — the redirect guards handle the no-resume case first).

const BULLET_RE         = /^[-•*▪·✓]\s+/;
const NUMBERED_RE       = /^\d+[.)]\s+/;
const DATE_RE           = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december|20\d{2}|19\d{2}|present|current)\b/i;
const SECTION_HEADER_RE = /^(experience|work history|employment|education|skills|summary|objective|profile|projects|certifications|achievements|publications|references)/i;

const EMPTY_SECTIONS: ResumeSection[] = [];

function isBulletLine(line: string)    { return BULLET_RE.test(line) || NUMBERED_RE.test(line); }
function isDateLine(line: string)      { return DATE_RE.test(line); }
function stripBullet(line: string)     { return line.replace(BULLET_RE, '').replace(NUMBERED_RE, '').trim(); }

function parseResumeToSections(rawText: string): ResumeSection[] {
  if (!rawText?.trim()) return EMPTY_SECTIONS;

  const lines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) return EMPTY_SECTIONS;

  const sections: ResumeSection[] = [];
  let currentSection: ResumeSection | null = null;
  let sectionIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (SECTION_HEADER_RE.test(line) && line.length < 30) continue;

    if (isBulletLine(line)) {
      if (!currentSection) {
        const id = `s${sectionIndex++}`;
        currentSection = { id, company: 'Experience', role: '', period: '', location: '', bullets: [] };
        sections.push(currentSection);
      }
      const text = stripBullet(line);
      if (text.length > 4) {
        currentSection.bullets.push({ id: `${currentSection.id}-b${currentSection.bullets.length}`, text });
      }
    } else if (isDateLine(line) && currentSection) {
      if (!currentSection.period) currentSection.period = line.slice(0, 50);
    } else {
      const nextLine  = lines[i + 1] ?? '';
      const next2Line = lines[i + 2] ?? '';
      const looksLikeHeader =
        isBulletLine(nextLine) || isDateLine(nextLine) ||
        isBulletLine(next2Line) || isDateLine(next2Line) ||
        currentSection === null;

      if (looksLikeHeader) {
        const id     = `s${sectionIndex++}`;
        const splitM = line.match(/^(.+?)\s*(?:\bat\b|[|·—–])\s*(.+)$/i);
        if (splitM) {
          currentSection = { id, role: splitM[1].trim(), company: splitM[2].trim(), period: '', location: '', bullets: [] };
        } else {
          const nextIsRole = nextLine && !isBulletLine(nextLine) && !isDateLine(nextLine) && nextLine.length < 60;
          if (nextIsRole) {
            currentSection = { id, company: line, role: nextLine, period: '', location: '', bullets: [] };
            i++;
          } else {
            currentSection = { id, company: line, role: '', period: '', location: '', bullets: [] };
          }
        }
        sections.push(currentSection);
      }
    }
  }

  return sections.filter(s => s.bullets.length > 0);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimum text length for a bullet to be AI-improvable (guards against stub text). */
const MIN_BULLET_LENGTH = 10;

/**
 * Build a condensed "other bullets" context string for the rewrite API.
 * Excludes the targeted bullet to prevent the AI echoing it back.
 */
function buildResumeContext(sections: ResumeSection[], excludeBulletId: string): string {
  return sections
    .flatMap(s => s.bullets)
    .filter(b => b.id !== excludeBulletId)
    .map(b => b.text)
    .join(' | ')
    .slice(0, 1400);
}

// ── Workspace Navbar ──────────────────────────────────────────────────────────

function WorkspaceNavbar({ mode, atsScore }: { mode: WorkspaceMode; atsScore: number | null }) {
  const navigate = useNavigate();
  const user     = useAuthStore(s => s.user);

  const MODE_BADGE: Record<WorkspaceMode, { label: string; color: string }> = {
    resume:    { label: 'Fix Resume',     color: 'bg-brand-100 text-brand-700' },
    interview: { label: 'Interview Prep', color: 'bg-blue-100 text-blue-700'   },
    cover:     { label: 'Cover Letter',   color: 'bg-pink-100 text-pink-700'   },
  };
  const badge = MODE_BADGE[mode];

  return (
    <nav className="fixed top-0 inset-x-0 z-40 glass border-b border-white/20">
      <div className="max-w-3xl mx-auto px-4 h-14 flex items-center justify-between gap-3">
        {/* Left */}
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={() => navigate('/dashboard')}
            className="text-slate-400 hover:text-slate-700 transition-colors text-sm"
            aria-label="Back to Dashboard"
          >
            ← Dashboard
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

// ── Resume Panel ──────────────────────────────────────────────────────────────
//
// Full-width, focused purely on the document.  The coaching content lives in
// the BottomSheet — this panel renders only the resume and the Sandwich diff.

interface ResumePanelProps {
  header:            ResumeHeader;
  sections:          ResumeSection[];
  pendingDiff:       PendingDiff | null;
  improvingBulletId: string | null;
  onBulletClick:     (bullet: ResumeBullet, section: ResumeSection) => void;
  onAccept:          () => void;
  onReject:          () => void;
}

function ResumePanel({
  header,
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
        <h2 className="text-xl sm:text-2xl font-black text-slate-900">{header.name}</h2>
        <p className="text-sm font-semibold text-brand-600 mt-0.5">{header.title}</p>
        {header.contact && (
          <p className="text-xs text-slate-400 mt-1">{header.contact}</p>
        )}
      </div>

      {/* Experience sections */}
      <div className="p-5 sm:p-7 space-y-7">
        <p className="text-xs font-bold text-slate-400 uppercase tracking-widest -mb-3">
          Experience
        </p>

        {sections.map((section) => {
          const sectionContainsTarget =
            (hasDiff && section.bullets.some(b => b.id === pendingDiff?.fieldPath)) ||
            section.bullets.some(b => b.id === improvingBulletId);
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
                  {section.role && section.company && (
                    <span className="text-slate-400 text-sm"> · </span>
                  )}
                  <span className="font-semibold text-slate-700 text-sm">{section.company}</span>
                </div>
                {(section.period || section.location) && (
                  <span className="text-xs text-slate-400 tabular-nums">
                    {[section.period, section.location].filter(Boolean).join(' · ')}
                  </span>
                )}
              </div>

              {/* Bullets */}
              <ul className="space-y-1.5">
                {section.bullets.map((bullet) => {
                  const isImproving   = bullet.id === improvingBulletId;
                  const isTargeted    = hasDiff && bullet.id === pendingDiff?.fieldPath;
                  const isDimmed      = (hasDiff || improvingBulletId !== null)
                                        && !isTargeted && !isImproving && sectionContainsTarget;
                  const isHighlighted = isTargeted || isImproving;
                  const isImprovable  = bullet.text.trim().length >= MIN_BULLET_LENGTH;

                  return (
                    <li key={bullet.id}>
                      {/* Middle layer: original bullet */}
                      <div
                        role="button"
                        tabIndex={isImprovable ? 0 : -1}
                        onClick={() => onBulletClick(bullet, section)}
                        onKeyDown={e => e.key === 'Enter' && onBulletClick(bullet, section)}
                        aria-label={
                          isImprovable
                            ? `Improve: ${bullet.text.slice(0, 40)}…`
                            : 'Bullet too short to improve'
                        }
                        aria-disabled={!isImprovable}
                        className={`
                          flex items-start gap-2 text-sm leading-relaxed
                          transition-all duration-300 rounded-lg
                          ${isDimmed ? 'opacity-40' : ''}
                          ${isHighlighted
                            ? 'bg-amber-50 border border-amber-200 px-3 py-2 -mx-3 cursor-default'
                            : isImprovable
                              ? 'px-0 py-0.5 cursor-pointer hover:bg-slate-50 hover:-mx-2 hover:px-2'
                              : 'px-0 py-0.5 cursor-not-allowed opacity-50'}
                        `}
                      >
                        <span className={`mt-1.5 flex-shrink-0 w-1.5 h-1.5 rounded-full
                          ${isHighlighted ? 'bg-amber-500' : 'bg-slate-400'}`}
                        />
                        <span className={isHighlighted ? 'text-amber-900 font-medium' : 'text-slate-700'}>
                          {bullet.text}
                        </span>

                        {/* "original" badge while diff is visible */}
                        {isHighlighted && !isImproving && (
                          <span className="ml-auto flex-shrink-0 text-xs font-semibold
                                           text-amber-600 bg-amber-100 px-2 py-0.5 rounded-full">
                            original
                          </span>
                        )}

                        {/* Spinner badge while improving */}
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

                      {/* Top layer: SandwichDiffInline */}
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

        {/* Hint when idle */}
        {!hasDiff && improvingBulletId === null && sections.length > 0 && (
          <p className="text-xs text-slate-400 text-center pt-2">
            👆 Click any bullet to get an instant AI improvement
          </p>
        )}
      </div>
    </div>
  );
}

// ── Loading skeleton ──────────────────────────────────────────────────────────

function ResumeSkeleton() {
  return (
    <div className="rounded-2xl bg-white border border-slate-200 shadow-sm p-6 space-y-5 animate-pulse">
      {/* Header */}
      <div className="space-y-2 pb-5 border-b border-slate-100">
        <div className="h-6 w-48 rounded bg-slate-200" />
        <div className="h-3.5 w-32 rounded bg-slate-100" />
        <div className="h-3 w-56 rounded bg-slate-100" />
      </div>
      {/* Sections */}
      {[0, 1].map(i => (
        <div key={i} className="space-y-2">
          <div className="h-3.5 w-40 rounded bg-slate-200" />
          <div className="h-3 w-full rounded bg-slate-100" />
          <div className="h-3 w-5/6 rounded bg-slate-100" />
          <div className="h-3 w-4/6 rounded bg-slate-100" />
        </div>
      ))}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

const VALID_MODES: WorkspaceMode[] = ['resume', 'interview', 'cover'];
const isValidMode = (m: string | null): m is WorkspaceMode =>
  VALID_MODES.includes(m as WorkspaceMode);

export default function WorkspacePage() {
  const [searchParams] = useSearchParams();
  const navigate       = useNavigate();

  const { setWorkspaceMode, workspaceMode } = useSessionStore();
  const user = useAuthStore(s => s.user);

  const {
    resumeRawText,
    activeCvFilename,
    isLoadingResume,
    pendingDiff,
    improvingBulletId,
    lastRewriteFailed,
    currentAtsScore,
    missingSkills,
    matchedSkills,
    atsGaps,
    applyDiff,
    rejectDiff,
    bumpAtsScore,
    improveBullet,
    loadLatestResume,
  } = useDocumentStore();

  // ── Refresh hydration (PRD §4.8) ──────────────────────────────────────────
  //
  // On a hard refresh, Zustand store resets — resumeRawText is null.
  // We attempt loadLatestResume() once; if there's no row in DB after
  // the load completes, we redirect back to /dashboard (no blank workspace).
  const [attempted, setAttempted] = useState(false);

  useEffect(() => {
    if (!user) return;
    if (resumeRawText) {
      // Already hydrated (normal navigation from Dashboard or DashboardPage effect)
      setAttempted(true);
      return;
    }
    // Attempt to load from DB — sets resumeRawText if a row with raw_text exists
    loadLatestResume(user.id).then(() => setAttempted(true));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // After load attempt completes: redirect if still no resume
  useEffect(() => {
    if (!attempted || isLoadingResume) return;
    if (!resumeRawText) {
      navigate('/dashboard', { replace: true });
    }
  }, [attempted, isLoadingResume, resumeRawText, navigate]);

  // ── Mode from URL ──────────────────────────────────────────────────────────
  useEffect(() => {
    const modeParam = searchParams.get('mode');
    setWorkspaceMode(isValidMode(modeParam) ? modeParam : 'resume');
  }, [searchParams, setWorkspaceMode]);

  const mode = workspaceMode ?? 'resume';

  // ── Derive sections and header from parsed resume text ─────────────────────
  const parsedSections = useMemo(
    () => resumeRawText ? parseResumeToSections(resumeRawText) : null,
    [resumeRawText],
  );

  const resumeHeader = useMemo((): ResumeHeader => {
    if (!resumeRawText) return { name: '', title: '', contact: '' };
    const firstLines = resumeRawText
      .split('\n').map(l => l.trim()).filter(l => l.length > 0).slice(0, 5);
    const name    = firstLines[0] ?? '';
    const title   = firstLines[1] ?? activeCvFilename ?? '';
    const contact = firstLines.slice(2, 4).join(' · ');
    return { name, title, contact };
  }, [resumeRawText, activeCvFilename]);

  // Local section state — allows optimistic Accept text replacement
  const [sections, setSections] = useState<ResumeSection[]>(() => parsedSections ?? []);

  // Re-hydrate when resumeRawText arrives after a page refresh
  useEffect(() => {
    if (parsedSections && parsedSections.length > 0) {
      setSections(parsedSections);
    }
  }, [parsedSections]);

  // ── Mascot state machine (PRD §2.7) ───────────────────────────────────────
  // Priority: processing > warning > success > idle
  const macState: MacState =
    improvingBulletId !== null ? 'processing' :
    lastRewriteFailed          ? 'warning'    :
    pendingDiff !== null       ? 'success'    :
    'idle';

  const macSays: string =
    isLoadingResume
      ? 'Loading your resume…'
      : improvingBulletId !== null
        ? 'Analysing your bullet against the job description…'
        : lastRewriteFailed
          ? 'Something went wrong. Try a different bullet or check your connection.'
          : pendingDiff !== null
            ? `Review the AI suggestion. Accepting will add +${pendingDiff.scoreImpact} ATS pts.`
            : 'Click any bullet point to get an instant AI rewrite.';

  // ── AbortController ────────────────────────────────────────────────────────
  const abortRef = useRef<AbortController | null>(null);

  // ── Bullet click handler ───────────────────────────────────────────────────
  const handleBulletClick = useCallback((bullet: ResumeBullet, _section: ResumeSection) => {
    // Guard: no real resume (placeholders must not trigger API calls)
    if (!resumeRawText) return;
    // Guard: bullet too short
    if (bullet.text.trim().length < MIN_BULLET_LENGTH) return;
    // Guard: already being worked on or has a diff
    if (bullet.id === improvingBulletId) return;
    if (pendingDiff?.fieldPath === bullet.id) return;

    abortRef.current?.abort();
    abortRef.current = new AbortController();

    const resumeContext = buildResumeContext(sections, bullet.id);
    void improveBullet(bullet.id, bullet.text, resumeContext, abortRef.current.signal);
  }, [resumeRawText, improvingBulletId, pendingDiff, sections, improveBullet]);

  // ── Accept handler ─────────────────────────────────────────────────────────
  const handleAccept = useCallback(() => {
    if (!pendingDiff) return;
    setSections(prev =>
      prev.map(s => ({
        ...s,
        bullets: s.bullets.map(b =>
          b.id === pendingDiff.fieldPath ? { ...b, text: pendingDiff.proposedText } : b
        ),
      }))
    );
    bumpAtsScore(pendingDiff.scoreImpact);
    applyDiff();
  }, [pendingDiff, applyDiff, bumpAtsScore]);

  // ── Reject handler ─────────────────────────────────────────────────────────
  const handleReject = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    rejectDiff();
  }, [rejectDiff]);

  // ── Cleanup ────────────────────────────────────────────────────────────────
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  // ── Render ─────────────────────────────────────────────────────────────────
  //
  // Layout: h-full flex-col.
  //   - Fixed navbar (z-40) sits above in the stacking context.
  //   - main is flex-1 overflow-y-auto — scrolls independently.
  //   - BottomSheet is flex-shrink-0 — always visible at the bottom.
  //
  // pt-[97px] clears DevNav (≈41px) + WorkspaceNavbar (56px).

  const isHydrating = !attempted || isLoadingResume;

  return (
    <div className="h-full flex flex-col overflow-hidden bg-bg">
      <DevNav />
      <WorkspaceNavbar mode={mode} atsScore={currentAtsScore} />

      {/* Scrollable resume content */}
      <main className="flex-1 overflow-y-auto pt-[97px] px-4 pb-4">
        <div className="max-w-3xl mx-auto py-4">

          {/* Loading state */}
          {isHydrating && <ResumeSkeleton />}

          {/* Resume panel — only shown when we have real parsed sections */}
          {!isHydrating && sections.length > 0 && (
            <ResumePanel
              header={resumeHeader}
              sections={sections}
              pendingDiff={pendingDiff}
              improvingBulletId={improvingBulletId}
              onBulletClick={handleBulletClick}
              onAccept={handleAccept}
              onReject={handleReject}
            />
          )}

        </div>
      </main>

      {/* Permanent coaching panel — PRD §4 Sandwich UI Protocol bottom anchor */}
      <BottomSheet
        macState={macState}
        macSays={macSays}
        atsScore={currentAtsScore}
        diff={pendingDiff}
        missingSkills={missingSkills}
        matchedSkills={matchedSkills}
        atsGaps={atsGaps}
      />
    </div>
  );
}
