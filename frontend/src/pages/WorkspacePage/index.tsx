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
 *   Middle — Targeted bullet: amber highlight
 *   Bottom — All other resume content: opacity-40
 *
 * Simulation (Phase 4):
 *   On mount, pendingDiff is immediately set to MOCK_DIFF targeting acme-b1
 *   so the Sandwich UI is visible without any API call.
 *
 * Phase 5 wiring points (marked TODO):
 *   - Replace MOCK_RESUME with useDocumentStore.resumeData
 *   - Replace MOCK_DIFF initialisation with POST /api/rewrite-section response
 *   - Wire onAccept → useDocumentStore.applyDiff() + bumpAtsScore()
 *   - Wire onReject → useDocumentStore.rejectDiff()
 *   - Replace coaching copy with real API-driven coaching text
 *   - Drive MacMascot state from useSessionStore.macState
 */

import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import DevNav from '@/shared/ui/DevNav';
import MacMascot from '@/shared/ui/MacMascot';
import SandwichDiffInline from '@/shared/ui/SandwichDiffInline';
import { useSessionStore } from '@/store/useSessionStore';
import { useAuthStore } from '@/store/useAuthStore';
import type { PendingDiff } from '@/store/useDocumentStore';

// ── Types ─────────────────────────────────────────────────────────────────────

type WorkspaceMode = 'resume' | 'interview' | 'cover';

interface ResumeBullet {
  id: string;
  text: string;
}

interface ResumeSection {
  id: string;
  company: string;
  role: string;
  period: string;
  location: string;
  bullets: ResumeBullet[];
}

// ── Mock data (Phase 5: replace with useDocumentStore.resumeData) ─────────────

const MOCK_RESUME_HEADER = {
  name: 'Alex Johnson',
  title: 'Software Engineer',
  contact: 'alex@example.com · github.com/alexj · San Francisco, CA',
};

const MOCK_RESUME: ResumeSection[] = [
  {
    id: 'acme',
    company: 'Acme Corporation',
    role: 'Software Engineer',
    period: 'Jan 2022 – Present',
    location: 'San Francisco, CA',
    bullets: [
      {
        id: 'acme-b0',
        text: 'Built internal tooling for the data team using Python and SQL, reducing manual reporting time by 3 hours/week.',
      },
      {
        id: 'acme-b1',
        text: 'Worked on frontend features for the main product dashboard.',
      },
      {
        id: 'acme-b2',
        text: 'Participated in code reviews and improved team collaboration processes.',
      },
    ],
  },
  {
    id: 'startup',
    company: 'StartupXYZ',
    role: 'Junior Developer',
    period: 'Jun 2020 – Dec 2021',
    location: 'Remote',
    bullets: [
      {
        id: 'startup-b0',
        text: 'Maintained legacy codebase and resolved critical production bugs, achieving 99.2% uptime.',
      },
      {
        id: 'startup-b1',
        text: 'Helped migrate the deployment pipeline to AWS infrastructure.',
      },
    ],
  },
];

// Simulated diff targeting acme-b1 (second bullet of first job)
const MOCK_DIFF: PendingDiff = {
  fieldPath: 'acme-b1',
  originalText: 'Worked on frontend features for the main product dashboard.',
  proposedText:
    'Architected and shipped 4 TypeScript-powered dashboard features, cutting average page load time by 38% and growing daily active users by 12% quarter-over-quarter.',
  scoreImpact: 6,
};

const MOCK_MISSING_KEYWORDS = ['TypeScript', 'CI/CD pipeline', 'quantified impact', 'React'];
const MOCK_MATCHED_KEYWORDS = ['Python', 'SQL', 'AWS'];

// ── Navbar ────────────────────────────────────────────────────────────────────

function WorkspaceNavbar({ mode, atsScore }: { mode: WorkspaceMode; atsScore: number }) {
  const navigate = useNavigate();
  const user     = useAuthStore(s => s.user);

  const MODE_BADGE: Record<WorkspaceMode, { label: string; color: string }> = {
    resume:    { label: 'Fix Resume',    color: 'bg-brand-100 text-brand-700' },
    interview: { label: 'Interview Prep', color: 'bg-blue-100 text-blue-700' },
    cover:     { label: 'Cover Letter',  color: 'bg-pink-100 text-pink-700' },
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
            <span className="font-bold text-red-600 tabular-nums">
              {atsScore}<span className="text-slate-300 font-normal">/100</span>
            </span>
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
  hasPendingDiff: boolean;
  diff: PendingDiff | null;
  atsScore: number;
}

function CoachingPanel({ hasPendingDiff, diff, atsScore }: CoachingPanelProps) {
  return (
    <aside className="flex flex-col gap-4">

      {/* Mascot */}
      <div className="rounded-2xl bg-white border border-slate-200 p-4 flex items-center gap-4">
        {/* TODO Phase 5: drive state from useSessionStore.macState */}
        <MacMascot state={hasPendingDiff ? 'warning' : 'idle'} size={72} />
        <div className="min-w-0">
          <p className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-0.5">
            Mac Says
          </p>
          <p className="text-sm text-slate-700 leading-snug">
            {hasPendingDiff && diff
              ? `This bullet needs quantified impact and TypeScript keywords to clear ATS filters.`
              : `Select a bullet to receive an AI suggestion.`}
          </p>
        </div>
      </div>

      {/* ATS score panel */}
      <div className="rounded-2xl bg-white border border-slate-200 p-4">
        <p className="text-xs font-bold text-slate-400 uppercase tracking-wide mb-2">
          Current ATS Score
        </p>
        <div className="flex items-baseline gap-1">
          <span className="text-3xl font-black text-red-600 tabular-nums">{atsScore}</span>
          <span className="text-sm text-slate-400">/100</span>
          {hasPendingDiff && diff && (
            <span className="ml-2 text-xs font-bold text-green-600 bg-green-50
                             border border-green-200 px-2 py-0.5 rounded-full">
              +{diff.scoreImpact} if accepted
            </span>
          )}
        </div>
        <p className="mt-1 text-xs text-red-600 font-medium">
          ATS will reject this resume.
        </p>
      </div>

      {/* Missing keyword chips */}
      <div className="rounded-2xl bg-white border border-slate-200 p-4">
        <p className="text-xs font-bold text-slate-400 uppercase tracking-wide mb-3">
          Missing Keywords
        </p>
        <div className="flex flex-wrap gap-2">
          {MOCK_MISSING_KEYWORDS.map(kw => (
            <span
              key={kw}
              className="text-xs font-semibold text-red-600 bg-red-50
                         border border-red-200 px-2.5 py-1 rounded-full"
            >
              – {kw}
            </span>
          ))}
        </div>

        <p className="text-xs font-bold text-slate-400 uppercase tracking-wide mt-4 mb-3">
          Matched Keywords
        </p>
        <div className="flex flex-wrap gap-2">
          {MOCK_MATCHED_KEYWORDS.map(kw => (
            <span
              key={kw}
              className="text-xs font-semibold text-green-700 bg-green-50
                         border border-green-200 px-2.5 py-1 rounded-full"
            >
              ✓ {kw}
            </span>
          ))}
        </div>
      </div>

    </aside>
  );
}

// ── Resume Panel (left/main column) ──────────────────────────────────────────

interface ResumePanelProps {
  sections: ResumeSection[];
  pendingDiff: PendingDiff | null;
  onAccept: () => void;
  onReject: () => void;
}

function ResumePanel({ sections, pendingDiff, onAccept, onReject }: ResumePanelProps) {
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
          // Dim entire section header when diff is active and this section doesn't contain the target
          const sectionContainsTarget = hasDiff &&
            section.bullets.some(b => b.id === pendingDiff?.fieldPath);
          const sectionDimmed = hasDiff && !sectionContainsTarget;

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
                  const isTargeted = hasDiff && bullet.id === pendingDiff?.fieldPath;
                  const isDimmed   = hasDiff && !isTargeted && sectionContainsTarget;

                  return (
                    <li key={bullet.id}>
                      {/* Middle layer: original bullet, amber if targeted */}
                      <div
                        className={`
                          flex items-start gap-2 text-sm leading-relaxed
                          transition-all duration-300 rounded-lg
                          ${isDimmed   ? 'opacity-40' : ''}
                          ${isTargeted
                            ? 'bg-amber-50 border border-amber-200 px-3 py-2 -mx-3'
                            : 'px-0 py-0.5'}
                        `}
                      >
                        <span className={`mt-1.5 flex-shrink-0 w-1.5 h-1.5 rounded-full
                          ${isTargeted ? 'bg-amber-500' : 'bg-slate-400'}`}
                        />
                        <span className={isTargeted ? 'text-amber-900 font-medium' : 'text-slate-700'}>
                          {bullet.text}
                        </span>
                        {isTargeted && (
                          <span className="ml-auto flex-shrink-0 text-xs font-semibold
                                           text-amber-600 bg-amber-100 px-2 py-0.5 rounded-full">
                            original
                          </span>
                        )}
                      </div>

                      {/* Top layer: SandwichDiffInline — renders directly below targeted bullet */}
                      <AnimatePresence>
                        {isTargeted && pendingDiff && (
                          <SandwichDiffInline
                            key="sandwich"
                            diff={pendingDiff}
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

  // Local state: resume bullets + pending diff
  const [sections,     setSections]     = useState<ResumeSection[]>(MOCK_RESUME);
  const [pendingDiff,  setPendingDiff]  = useState<PendingDiff | null>(null);
  const [atsScore,     setAtsScore]     = useState(34);

  // Hydrate workspaceMode from URL param on mount (PRD §4.8)
  useEffect(() => {
    const modeParam = searchParams.get('mode');
    setWorkspaceMode(isValidMode(modeParam) ? modeParam : 'resume');
  }, [searchParams, setWorkspaceMode]);

  // Simulation: auto-set pendingDiff on mount so Sandwich UI is visible immediately
  useEffect(() => {
    const t = setTimeout(() => setPendingDiff(MOCK_DIFF), 300);
    return () => clearTimeout(t);
  }, []);

  const mode = workspaceMode ?? 'resume';

  const handleAccept = () => {
    if (!pendingDiff) return;
    // TODO Phase 5: useDocumentStore.applyDiff() + bumpAtsScore(pendingDiff.scoreImpact)
    // Optimistic: apply proposed text into the local section state
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
    setAtsScore(s => s + pendingDiff.scoreImpact);
    setPendingDiff(null);
  };

  const handleReject = () => {
    // TODO Phase 5: useDocumentStore.rejectDiff()
    setPendingDiff(null);
  };

  return (
    <div className="h-full overflow-y-auto scrollbar-hidden bg-bg">
      <DevNav />
      <WorkspaceNavbar mode={mode} atsScore={atsScore} />

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
                hasPendingDiff={pendingDiff !== null}
                diff={pendingDiff}
                atsScore={atsScore}
              />
            </div>
          </div>

          {/* ── LEFT: Resume Panel (below on mobile) ──────────── */}
          <div className="flex-1 min-w-0">
            <ResumePanel
              sections={sections}
              pendingDiff={pendingDiff}
              onAccept={handleAccept}
              onReject={handleReject}
            />
          </div>

        </div>
      </main>
    </div>
  );
}
