/**
 * WorkspacePage — Route: /workspace?mode=resume|interview|cover
 * PRD §4 — Sandwich UI Protocol
 *
 * Layout (PRD §4.3):
 *
 *   Desktop (md+):
 *   ┌─────────────────────────────────┬──────────────────────┐
 *   │ RESUME PANEL (scrollable, flex-1)│ MAC COACHING SIDEBAR │
 *   │                                 │                      │
 *   │  • Bullet → click to improve    │  [MacMascot .webm]   │
 *   │    ┌─ SandwichDiffInline ─────┐ │  ╰── speech bubble   │
 *   │    │ ✨ AI Suggestion  +6 pts │ │                      │
 *   │    │ [Accept]  [Reject]       │ │  ── Keywords ──      │
 *   │    └─────────────────────────┘ │  [TypeScript ×6]     │
 *   │  • Bullet 2 (dimmed, 40% op)   │  [CI/CD ×4]          │
 *   └─────────────────────────────────┴──────────────────────┘
 *
 *   Mobile (<md):
 *   Resume Panel takes full screen.
 *   Coaching panel is a BOTTOM DRAWER (40vh collapsed, 80vh expanded).
 *   iOS-style spring animation + backdrop blur.
 *
 * State sync (refresh):
 *   - Store hydrated → render immediately.
 *   - Store empty → loadLatestResume(userId) → redirect to /dashboard if no data.
 *
 * Parser: if structured parsing fails → raw text split into paragraph-bullets,
 *   so the user ALWAYS sees their own data, never a blank screen.
 */

import { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence, useDragControls, useMotionValue, animate } from 'framer-motion';
import DevNav             from '@/shared/ui/DevNav';
import MacMascot, { type MacState } from '@/shared/ui/MacMascot';
import SandwichDiffInline from '@/shared/ui/SandwichDiffInline';
import { useSessionStore }  from '@/store/useSessionStore';
import { useAuthStore }     from '@/store/useAuthStore';
import { useDocumentStore, type PendingDiff } from '@/store/useDocumentStore';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type WorkspaceMode = 'resume' | 'interview' | 'cover';

interface ResumeBullet  { id: string; text: string; }
interface ResumeSection { id: string; company: string; role: string; period: string; location: string; bullets: ResumeBullet[]; }
interface ResumeHeader  { name: string; title: string; contact: string; }

// ─────────────────────────────────────────────────────────────────────────────
// Resilient resume text → section parser
// ─────────────────────────────────────────────────────────────────────────────
//
// Strategy (in order):
//   1. Detect bullet-prefixed lines (-•*▪ or 1.) — classic CV format
//   2. If few/no bullets found, split double-newline paragraphs into bullets
//   3. Absolute fallback: split every line into its own bullet
//
// This guarantees the user ALWAYS sees their data — never an empty workspace.

const BULLET_RE         = /^[-•*▪·✓➤→▸]\s+/;
const NUMBERED_RE       = /^\d+[.)]\s+/;
const DATE_RE           = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|20\d{2}|19\d{2}|present|current)\b/i;
const SECTION_HEADER_RE = /^(experience|work history|employment|education|skills|summary|objective|profile|projects|certifications|achievements|publications|references)\s*:?\s*$/i;

function isBullet(line: string)   { return BULLET_RE.test(line) || NUMBERED_RE.test(line); }
function stripBullet(line: string) { return line.replace(BULLET_RE, '').replace(NUMBERED_RE, '').trim(); }
function isDate(line: string)      { return DATE_RE.test(line); }
function isHeader(line: string)    { return SECTION_HEADER_RE.test(line) && line.length < 35; }

function makeBullet(sectionId: string, idx: number, text: string): ResumeBullet {
  return { id: `${sectionId}-b${idx}`, text: text.trim() };
}

function parseResumeToSections(rawText: string): ResumeSection[] {
  if (!rawText?.trim()) return [];

  const lines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  // ── Pass 1: structured parsing (classic bullet CV format) ──────────────────
  const sections: ResumeSection[] = [];
  let current: ResumeSection | null = null;
  let si = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isHeader(line)) continue;

    if (isBullet(line)) {
      if (!current) {
        const id = `s${si++}`;
        current = { id, company: 'Experience', role: '', period: '', location: '', bullets: [] };
        sections.push(current);
      }
      const text = stripBullet(line);
      if (text.length >= 8)
        current.bullets.push(makeBullet(current.id, current.bullets.length, text));

    } else if (isDate(line) && current && !current.period) {
      current.period = line.slice(0, 60);

    } else {
      // Try to detect a new company/role header
      const next  = lines[i + 1] ?? '';
      const next2 = lines[i + 2] ?? '';
      const looksLikeHeader =
        isBullet(next) || isDate(next) || isBullet(next2) || isDate(next2) || !current;

      if (looksLikeHeader) {
        const id     = `s${si++}`;
        const split  = line.match(/^(.+?)\s*(?:\bat\b|[|·—–])\s*(.+)$/i);
        if (split) {
          current = { id, role: split[1].trim(), company: split[2].trim(), period: '', location: '', bullets: [] };
        } else {
          const nextIsRole = next && !isBullet(next) && !isDate(next) && next.length < 60;
          if (nextIsRole) { current = { id, company: line, role: next, period: '', location: '', bullets: [] }; i++; }
          else            { current = { id, company: line, role: '', period: '', location: '', bullets: [] }; }
        }
        sections.push(current);
      }
    }
  }

  const structured = sections.filter(s => s.bullets.length > 0);
  if (structured.length > 0) return structured;

  // ── Pass 2: paragraph fallback ─────────────────────────────────────────────
  // CV uses dense paragraphs instead of bullet points.
  // Split by blank lines → each paragraph block → one "bullet".
  const blocks = rawText
    .split(/\n\s*\n/)
    .map(b => b.replace(/\n/g, ' ').trim())
    .filter(b => b.length >= 15);

  if (blocks.length > 0) {
    const id = 's0';
    return [{
      id,
      company:  'Experience',
      role:     '',
      period:   '',
      location: '',
      bullets:  blocks.map((text, idx) => makeBullet(id, idx, text)),
    }];
  }

  // ── Pass 3: absolute fallback — line by line ───────────────────────────────
  const id = 's0';
  return [{
    id,
    company:  'Resume Content',
    role:     '',
    period:   '',
    location: '',
    bullets:  lines
      .filter(l => l.length >= 8)
      .map((text, idx) => makeBullet(id, idx, text)),
  }];
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const MIN_BULLET_LEN = 10;

function buildResumeContext(sections: ResumeSection[], excludeId: string): string {
  return sections
    .flatMap(s => s.bullets)
    .filter(b => b.id !== excludeId)
    .map(b => b.text)
    .join(' | ')
    .slice(0, 1400);
}

// ─────────────────────────────────────────────────────────────────────────────
// Workspace Navbar
// ─────────────────────────────────────────────────────────────────────────────

function WorkspaceNavbar({ mode, atsScore }: { mode: WorkspaceMode; atsScore: number | null }) {
  const navigate = useNavigate();
  const user     = useAuthStore(s => s.user);
  const BADGE = {
    resume:    { label: 'Fix Resume',     cls: 'bg-brand-100 text-brand-700' },
    interview: { label: 'Interview Prep', cls: 'bg-blue-100 text-blue-700'   },
    cover:     { label: 'Cover Letter',   cls: 'bg-pink-100 text-pink-700'   },
  };
  const b = BADGE[mode];
  return (
    <nav className="fixed top-0 inset-x-0 z-40 glass border-b border-white/20">
      <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <button onClick={() => navigate('/dashboard')}
            className="text-slate-400 hover:text-slate-700 transition-colors text-sm">
            ← Dashboard
          </button>
          <span className="text-slate-200 hidden sm:block">|</span>
          <span className="font-bold text-base tracking-tight text-slate-900 hidden sm:block">
            Jobif<span className="text-brand-600">AI</span>
          </span>
        </div>
        <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${b.cls}`}>{b.label}</span>
        <div className="flex items-center gap-3">
          <div className="hidden sm:flex items-center gap-1 text-xs">
            <span className="text-slate-400 font-medium">ATS</span>
            {atsScore !== null ? (
              <span className={`font-bold tabular-nums ${atsScore >= 70 ? 'text-green-600' : atsScore >= 40 ? 'text-amber-600' : 'text-red-600'}`}>
                {atsScore}<span className="text-slate-300 font-normal">/100</span>
              </span>
            ) : <span className="text-slate-400">—</span>}
          </div>
          {user && <span className="hidden md:block text-xs text-slate-400 font-mono truncate max-w-[140px]">{user.email}</span>}
        </div>
      </div>
    </nav>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Mac Coaching Panel — Desktop sidebar (hidden on mobile)
// ─────────────────────────────────────────────────────────────────────────────

interface CoachingPanelProps {
  macState:      MacState;
  macSays:       string;
  atsScore:      number | null;
  diff:          PendingDiff | null;
  missingSkills: string[];
  matchedSkills: string[];
  atsGaps:       string[];
}

function CoachingPanel({ macState, macSays, atsScore, diff, missingSkills, matchedSkills, atsGaps }: CoachingPanelProps) {
  const displayMissing = missingSkills.length > 0
    ? missingSkills.slice(0, 8)
    : atsGaps.map(g => { const m = g.match(/["']([^"']+)["']/); return m ? m[1] : g; }).filter(Boolean).slice(0, 8);

  return (
    <aside className="flex flex-col gap-0 overflow-y-auto scrollbar-hidden">

      {/* ── MacMascot dock ───────────────────────────────────────── */}
      <div className="flex flex-col items-center pt-6 pb-4 px-5">
        {/*
          Fixed 140×140 dock — video fills it exactly via absolute inset-0.
          No overflow: the mascot never clips or bleeds outside this box.
        */}
        <div className="relative" style={{ width: 140, height: 140 }}>
          <MacMascot state={macState} size={140} />
        </div>

        {/* ── Speech bubble pointing UP toward mascot ───────────── */}
        <div className="relative mt-3 w-full">
          {/* Tail pointing up */}
          <div className="absolute -top-2 left-1/2 -translate-x-1/2
                          w-0 h-0
                          border-l-[8px] border-l-transparent
                          border-r-[8px] border-r-transparent
                          border-b-[8px] border-b-slate-100" />
          <div className="rounded-2xl bg-slate-100 border border-slate-200 px-4 py-3">
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">
              Mac says
            </p>
            <p className="text-sm text-slate-700 leading-snug">{macSays}</p>
          </div>
        </div>
      </div>

      {/* ── Divider ──────────────────────────────────────────────── */}
      <div className="mx-5 h-px bg-slate-100" />

      {/* ── ATS score ────────────────────────────────────────────── */}
      <div className="px-5 py-4">
        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">
          ATS Score
        </p>
        <div className="flex items-baseline gap-1">
          {atsScore !== null ? (
            <>
              <span className={`text-3xl font-black tabular-nums ${atsScore >= 70 ? 'text-green-600' : atsScore >= 40 ? 'text-amber-600' : 'text-red-600'}`}>
                {atsScore}
              </span>
              <span className="text-sm text-slate-400">/100</span>
            </>
          ) : <span className="text-3xl font-black text-slate-300">—</span>}
          {diff && (
            <span className="ml-2 text-xs font-bold text-green-600 bg-green-50 border border-green-200 px-2 py-0.5 rounded-full">
              +{diff.scoreImpact} if accepted
            </span>
          )}
        </div>
        {atsScore !== null && atsScore < 50 && (
          <p className="mt-1 text-xs text-red-500 font-medium">ATS may reject this resume.</p>
        )}
      </div>

      {/* ── Missing keywords ─────────────────────────────────────── */}
      {displayMissing.length > 0 && (
        <>
          <div className="mx-5 h-px bg-slate-100" />
          <div className="px-5 py-4">
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3">
              Missing Keywords
            </p>
            <div className="flex flex-wrap gap-1.5">
              {displayMissing.map(kw => (
                <span key={kw}
                  className="text-xs font-semibold text-red-600 bg-red-50 border border-red-200 px-2.5 py-1 rounded-full">
                  – {kw}
                </span>
              ))}
            </div>
          </div>
        </>
      )}

      {/* ── Matched keywords ─────────────────────────────────────── */}
      {matchedSkills.length > 0 && (
        <>
          <div className="mx-5 h-px bg-slate-100" />
          <div className="px-5 py-4">
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3">
              Matched
            </p>
            <div className="flex flex-wrap gap-1.5">
              {matchedSkills.slice(0, 10).map(kw => (
                <span key={kw}
                  className="text-xs font-semibold text-green-700 bg-green-50 border border-green-200 px-2.5 py-1 rounded-full">
                  ✓ {kw}
                </span>
              ))}
            </div>
          </div>
        </>
      )}

      {/* ── No keyword data ───────────────────────────────────────── */}
      {displayMissing.length === 0 && matchedSkills.length === 0 && (
        <div className="px-5 pb-4">
          <p className="text-xs text-slate-400">
            Run ATS analysis from the Dashboard to unlock keyword coaching.
          </p>
        </div>
      )}

    </aside>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Mobile Bottom Drawer — iOS-style (hidden on desktop)
// ─────────────────────────────────────────────────────────────────────────────

const DRAWER_PEEK  = 72;    // px — handle + mascot strip always visible
const DRAWER_MID   = 0.40;  // 40vh collapsed (PRD §4.3)
const DRAWER_FULL  = 0.78;  // 78vh expanded

function MobileDrawer(props: CoachingPanelProps) {
  const { macState, macSays, atsScore, diff, missingSkills, matchedSkills, atsGaps } = props;
  const dragControls = useDragControls();
  const [isOpen, setIsOpen] = useState(false);

  // We track position with a motion value so spring feels native
  const drawerY = useMotionValue(0);   // 0 = fully open position; positive = further down

  const displayMissing = missingSkills.length > 0
    ? missingSkills.slice(0, 8)
    : atsGaps.map(g => { const m = g.match(/["']([^"']+)["']/); return m ? m[1] : g; }).filter(Boolean).slice(0, 8);

  return (
    <>
      {/* Scrim — blurred backdrop when drawer is open */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            key="scrim"
            className="fixed inset-0 z-30 pointer-events-auto"
            style={{ backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)', background: 'rgba(0,0,0,0.12)' }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => setIsOpen(false)}
          />
        )}
      </AnimatePresence>

      {/* Drawer — fixed to bottom, z-40 so it sits above scrim */}
      <motion.div
        className="fixed bottom-0 left-0 right-0 z-40 bg-white rounded-t-4xl shadow-sheet"
        style={{ height: isOpen ? `${DRAWER_FULL * 100}vh` : `${DRAWER_MID * 100}vh` }}
        animate={{ height: isOpen ? `${DRAWER_FULL * 100}vh` : `${DRAWER_MID * 100}vh` }}
        initial={false}
        transition={{ type: 'spring', damping: 32, stiffness: 320, mass: 0.9 }}
        drag="y"
        dragControls={dragControls}
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={0.12}
        onDragEnd={(_, info) => {
          // Snap based on velocity + position
          if (info.velocity.y > 200 || info.offset.y > 80)  setIsOpen(false);
          if (info.velocity.y < -200 || info.offset.y < -80) setIsOpen(true);
        }}
      >
        {/* ── iOS-style handle ─────────────────────────────────────── */}
        <div
          className="flex flex-col items-center pt-3 pb-2 cursor-grab active:cursor-grabbing"
          onPointerDown={e => dragControls.start(e)}
          onClick={() => setIsOpen(o => !o)}
        >
          <div className="w-9 h-[5px] rounded-full bg-slate-300" />
        </div>

        {/* ── Peek row — always visible ─────────────────────────────── */}
        <div className="flex items-center gap-3 px-4 pb-3">
          {/* Mascot — small in peek strip */}
          <MacMascot state={macState} size={48} />

          {/* Speech bubble inline */}
          <div className="flex-1 min-w-0 rounded-2xl bg-slate-100 border border-slate-200 px-3 py-2">
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest leading-none mb-0.5">
              Mac says
            </p>
            <p className="text-sm text-slate-700 leading-snug line-clamp-2">{macSays}</p>
          </div>

          {/* ATS mini */}
          {atsScore !== null && (
            <div className="flex-shrink-0 text-right">
              <p className="text-[8px] font-bold text-slate-400 uppercase tracking-widest leading-none mb-0.5">ATS</p>
              <p className={`text-xl font-black tabular-nums leading-none ${atsScore >= 70 ? 'text-green-600' : atsScore >= 40 ? 'text-amber-600' : 'text-red-600'}`}>
                {atsScore}
              </p>
            </div>
          )}
        </div>

        {/* ── Expanded content — visible only when isOpen ───────────── */}
        <AnimatePresence>
          {isOpen && (
            <motion.div
              key="expanded"
              className="overflow-y-auto scrollbar-hidden px-4 pb-8"
              style={{ height: `calc(${DRAWER_FULL * 100}vh - 120px)` }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: { delay: 0.1 } }}
              exit={{ opacity: 0, transition: { duration: 0.08 } }}
            >
              {/* Diff chip */}
              {diff && (
                <div className="mb-4 pt-1">
                  <span className="inline-flex items-center gap-1.5 text-xs font-bold text-green-700 bg-green-50 border border-green-200 px-3 py-1.5 rounded-full">
                    ✨ +{diff.scoreImpact} ATS pts — accept or reject the suggestion ↑
                  </span>
                </div>
              )}

              <div className="h-px bg-slate-100 mb-4" />

              {displayMissing.length > 0 && (
                <div className="mb-4">
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Missing Keywords</p>
                  <div className="flex flex-wrap gap-1.5">
                    {displayMissing.map(kw => (
                      <span key={kw} className="text-xs font-semibold text-red-600 bg-red-50 border border-red-200 px-2.5 py-1 rounded-full">
                        – {kw}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {matchedSkills.length > 0 && (
                <div>
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Matched</p>
                  <div className="flex flex-wrap gap-1.5">
                    {matchedSkills.slice(0, 10).map(kw => (
                      <span key={kw} className="text-xs font-semibold text-green-700 bg-green-50 border border-green-200 px-2.5 py-1 rounded-full">
                        ✓ {kw}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {displayMissing.length === 0 && matchedSkills.length === 0 && (
                <p className="text-xs text-slate-400 text-center py-4">
                  Run ATS analysis from the Dashboard to see keyword gaps.
                </p>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Resume Panel — full-width document view
// ─────────────────────────────────────────────────────────────────────────────

interface ResumePanelProps {
  header:            ResumeHeader;
  sections:          ResumeSection[];
  pendingDiff:       PendingDiff | null;
  improvingBulletId: string | null;
  onBulletClick:     (b: ResumeBullet, s: ResumeSection) => void;
  onAccept:          () => void;
  onReject:          () => void;
}

function ResumePanel({ header, sections, pendingDiff, improvingBulletId, onBulletClick, onAccept, onReject }: ResumePanelProps) {
  const hasDiff = pendingDiff !== null;

  return (
    <div className="rounded-2xl bg-white border border-slate-200 shadow-sm overflow-hidden">

      {/* Header */}
      <div className="border-b border-slate-100 p-5 sm:p-7">
        <h2 className="text-xl sm:text-2xl font-black text-slate-900">{header.name}</h2>
        {header.title   && <p className="text-sm font-semibold text-brand-600 mt-0.5">{header.title}</p>}
        {header.contact && <p className="text-xs text-slate-400 mt-1">{header.contact}</p>}
      </div>

      {/* Sections */}
      <div className="p-5 sm:p-7 space-y-7">
        <p className="text-xs font-bold text-slate-400 uppercase tracking-widest -mb-3">Experience</p>

        {sections.map(section => {
          const sectionHasTarget = (hasDiff && section.bullets.some(b => b.id === pendingDiff?.fieldPath))
                                || section.bullets.some(b => b.id === improvingBulletId);
          const sectionDimmed = (hasDiff || improvingBulletId !== null) && !sectionHasTarget;

          return (
            <div key={section.id} className={`transition-opacity duration-300 ${sectionDimmed ? 'opacity-40' : ''}`}>

              {/* Section header */}
              {(section.role || section.company) && (
                <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-0.5 mb-3">
                  <div>
                    {section.role    && <span className="font-bold text-slate-900 text-sm">{section.role}</span>}
                    {section.role && section.company && <span className="text-slate-400 text-sm"> · </span>}
                    {section.company && <span className="font-semibold text-slate-700 text-sm">{section.company}</span>}
                  </div>
                  {(section.period || section.location) && (
                    <span className="text-xs text-slate-400 tabular-nums">
                      {[section.period, section.location].filter(Boolean).join(' · ')}
                    </span>
                  )}
                </div>
              )}

              {/* Bullets */}
              <ul className="space-y-1.5">
                {section.bullets.map(bullet => {
                  const isImproving   = bullet.id === improvingBulletId;
                  const isTargeted    = hasDiff && bullet.id === pendingDiff?.fieldPath;
                  const isDimmed      = (hasDiff || improvingBulletId !== null) && !isTargeted && !isImproving && sectionHasTarget;
                  const isHighlighted = isTargeted || isImproving;
                  const isImprovable  = bullet.text.trim().length >= MIN_BULLET_LEN;

                  return (
                    <li key={bullet.id}>
                      <div
                        role="button"
                        tabIndex={isImprovable ? 0 : -1}
                        onClick={() => onBulletClick(bullet, section)}
                        onKeyDown={e => e.key === 'Enter' && onBulletClick(bullet, section)}
                        aria-label={isImprovable ? `Improve: ${bullet.text.slice(0, 50)}` : undefined}
                        aria-disabled={!isImprovable}
                        className={`
                          flex items-start gap-2 text-sm leading-relaxed
                          transition-all duration-200 rounded-lg
                          ${isDimmed ? 'opacity-40' : ''}
                          ${isHighlighted
                            ? 'bg-amber-50 border border-amber-200 px-3 py-2 -mx-3 cursor-default'
                            : isImprovable
                              ? 'px-0 py-0.5 cursor-pointer hover:bg-slate-50 hover:-mx-2 hover:px-2 group'
                              : 'px-0 py-0.5 cursor-default opacity-60'}
                        `}
                      >
                        <span className={`mt-2 flex-shrink-0 w-1.5 h-1.5 rounded-full
                          ${isHighlighted ? 'bg-amber-500' : 'bg-slate-300 group-hover:bg-brand-400 transition-colors'}`}
                        />
                        <span className={isHighlighted ? 'text-amber-900 font-medium' : 'text-slate-700'}>
                          {bullet.text}
                        </span>

                        {isHighlighted && !isImproving && (
                          <span className="ml-auto flex-shrink-0 text-[10px] font-bold text-amber-600 bg-amber-100 px-2 py-0.5 rounded-full self-start mt-0.5">
                            original
                          </span>
                        )}
                        {isImproving && (
                          <span className="ml-auto flex-shrink-0 text-[10px] font-bold text-amber-600 bg-amber-100 px-2 py-0.5 rounded-full self-start mt-0.5 flex items-center gap-1">
                            <svg className="animate-spin w-2.5 h-2.5" viewBox="0 0 24 24" fill="none">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/>
                            </svg>
                            rewriting…
                          </span>
                        )}
                      </div>

                      {/* Sandwich Diff */}
                      <AnimatePresence>
                        {(isTargeted || isImproving) && (
                          <SandwichDiffInline
                            key={`diff-${bullet.id}`}
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

        {!hasDiff && improvingBulletId === null && sections.length > 0 && (
          <p className="text-xs text-slate-400 text-center pt-2">
            👆 Click any bullet to get an instant AI rewrite
          </p>
        )}
      </div>
    </div>
  );
}

// Loading skeleton
function ResumeSkeleton() {
  return (
    <div className="rounded-2xl bg-white border border-slate-200 shadow-sm p-6 space-y-5 animate-pulse">
      <div className="space-y-2 pb-5 border-b border-slate-100">
        <div className="h-6 w-48 rounded bg-slate-200"/>
        <div className="h-3.5 w-32 rounded bg-slate-100"/>
        <div className="h-3 w-64 rounded bg-slate-100"/>
      </div>
      {[0, 1, 2].map(i => (
        <div key={i} className="space-y-2">
          <div className="h-3.5 w-40 rounded bg-slate-200"/>
          <div className="h-3 w-full rounded bg-slate-100"/>
          <div className="h-3 w-5/6 rounded bg-slate-100"/>
          <div className="h-3 w-3/4 rounded bg-slate-100"/>
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

const VALID_MODES: WorkspaceMode[] = ['resume', 'interview', 'cover'];
const isValidMode = (m: string | null): m is WorkspaceMode => VALID_MODES.includes(m as WorkspaceMode);

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

  // ── Refresh hydration ──────────────────────────────────────────────────────
  const [attempted, setAttempted] = useState(false);

  useEffect(() => {
    if (!user) return;
    if (resumeRawText) { setAttempted(true); return; }
    loadLatestResume(user.id).then(() => setAttempted(true));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // Redirect to dashboard if still empty after load completes
  useEffect(() => {
    if (!attempted || isLoadingResume) return;
    if (!resumeRawText) navigate('/dashboard', { replace: true });
  }, [attempted, isLoadingResume, resumeRawText, navigate]);

  // ── URL mode ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const modeParam = searchParams.get('mode');
    setWorkspaceMode(isValidMode(modeParam) ? modeParam : 'resume');
  }, [searchParams, setWorkspaceMode]);

  const mode = workspaceMode ?? 'resume';

  // ── Parse resume text ──────────────────────────────────────────────────────
  const parsedSections = useMemo(
    () => resumeRawText ? parseResumeToSections(resumeRawText) : null,
    [resumeRawText],
  );

  const resumeHeader = useMemo((): ResumeHeader => {
    if (!resumeRawText) return { name: '', title: '', contact: '' };
    const fl = resumeRawText.split('\n').map(l => l.trim()).filter(l => l.length > 0).slice(0, 5);
    return { name: fl[0] ?? '', title: fl[1] ?? activeCvFilename ?? '', contact: fl.slice(2, 4).join(' · ') };
  }, [resumeRawText, activeCvFilename]);

  const [sections, setSections] = useState<ResumeSection[]>(() => parsedSections ?? []);

  useEffect(() => {
    if (parsedSections && parsedSections.length > 0) setSections(parsedSections);
  }, [parsedSections]);

  // ── Mascot state machine (PRD §4.4) ───────────────────────────────────────
  const macState: MacState =
    isLoadingResume            ? 'processing' :
    improvingBulletId !== null ? 'processing' :
    lastRewriteFailed          ? 'warning'    :
    pendingDiff !== null && (pendingDiff.scoreImpact >= 6) ? 'success' :
    'idle';

  const macSays: string =
    isLoadingResume
      ? 'Loading your resume…'
      : improvingBulletId !== null
        ? 'Rewriting your bullet against the job description…'
        : lastRewriteFailed
          ? 'Something went wrong. Try a different bullet or check your connection.'
          : pendingDiff !== null
            ? `Nice — accept to add +${pendingDiff.scoreImpact} ATS points. Reject to try another bullet.`
            : sections.length > 0
              ? 'Click any bullet to get an instant AI rewrite. I\'ll improve it for this exact job.'
              : 'Loading your resume…';

  // ── AbortController ────────────────────────────────────────────────────────
  const abortRef = useRef<AbortController | null>(null);

  // ── Bullet click ───────────────────────────────────────────────────────────
  const handleBulletClick = useCallback((bullet: ResumeBullet, _section: ResumeSection) => {
    if (!resumeRawText) return;
    if (bullet.text.trim().length < MIN_BULLET_LEN) return;
    if (bullet.id === improvingBulletId) return;
    if (pendingDiff?.fieldPath === bullet.id) return;
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    void improveBullet(bullet.id, bullet.text, buildResumeContext(sections, bullet.id), abortRef.current.signal);
  }, [resumeRawText, improvingBulletId, pendingDiff, sections, improveBullet]);

  // ── Accept / Reject ────────────────────────────────────────────────────────
  const handleAccept = useCallback(() => {
    if (!pendingDiff) return;
    setSections(prev => prev.map(s => ({
      ...s,
      bullets: s.bullets.map(b => b.id === pendingDiff.fieldPath ? { ...b, text: pendingDiff.proposedText } : b),
    })));
    bumpAtsScore(pendingDiff.scoreImpact);
    applyDiff();
  }, [pendingDiff, applyDiff, bumpAtsScore]);

  const handleReject = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    rejectDiff();
  }, [rejectDiff]);

  useEffect(() => () => { abortRef.current?.abort(); }, []);

  // ── Coaching panel props ───────────────────────────────────────────────────
  const coachingProps: CoachingPanelProps = {
    macState, macSays, atsScore: currentAtsScore,
    diff: pendingDiff, missingSkills, matchedSkills, atsGaps,
  };

  const isHydrating = !attempted || isLoadingResume;

  // ── Render ─────────────────────────────────────────────────────────────────
  //
  // Desktop (md+): fixed navbar → flex-row main:
  //   │ Resume panel (flex-1, overflow-y-auto) │ Coaching sidebar (w-72, overflow-y-auto) │
  //
  // Mobile (<md): fixed navbar → scrollable resume → fixed bottom drawer
  //   The drawer sits outside the main scroll flow (fixed position).
  //   We add pb-[40vh] to the resume so content doesn't hide under the drawer.

  return (
    <div className="h-full flex flex-col overflow-hidden bg-bg">
      <DevNav />
      <WorkspaceNavbar mode={mode} atsScore={currentAtsScore} />

      {/*
        Main area: below the fixed navbars.
        pt-[97px] = DevNav (≈41px) + WorkspaceNavbar (56px).
        On desktop: side-by-side panels. On mobile: full-width resume only.
      */}
      <div className="flex-1 flex flex-row overflow-hidden pt-[97px]">

        {/* ── Resume panel ─────────────────────────────────────────────────── */}
        <main className="flex-1 overflow-y-auto scrollbar-hidden px-4 py-4
                         pb-[45vh] md:pb-4">
          <div className="max-w-2xl mx-auto md:ml-auto md:mr-0 lg:mx-auto">
            {isHydrating ? (
              <ResumeSkeleton />
            ) : sections.length > 0 ? (
              <ResumePanel
                header={resumeHeader}
                sections={sections}
                pendingDiff={pendingDiff}
                improvingBulletId={improvingBulletId}
                onBulletClick={handleBulletClick}
                onAccept={handleAccept}
                onReject={handleReject}
              />
            ) : null}
          </div>
        </main>

        {/* ── Desktop coaching sidebar (hidden on mobile) ───────────────────── */}
        <aside className="hidden md:flex md:flex-col w-72 lg:w-80 flex-shrink-0
                          border-l border-slate-200 bg-white overflow-y-auto scrollbar-hidden">
          <CoachingPanel {...coachingProps} />
        </aside>

      </div>

      {/* ── Mobile bottom drawer (hidden on desktop) ─────────────────────────── */}
      <div className="md:hidden">
        <MobileDrawer {...coachingProps} />
      </div>

    </div>
  );
}
