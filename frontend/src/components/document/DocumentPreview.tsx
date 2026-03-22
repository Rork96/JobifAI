/**
 * components/document/DocumentPreview.tsx — Live Resume Preview (Canvas)
 * ─────────────────────────────────────────────────────────────────────────────
 * Task 13 additions on top of the original Task 8-12 foundation:
 *
 *  1. ANIMATED ATS SCORE HEADER
 *     A large circular score badge in the header, bound strictly to
 *     `currentAtsScore` from the Zustand store.  Uses a requestAnimationFrame
 *     count-up/count-down animation whenever the score changes.
 *
 *  2. GAMIFIED SKILL GAP CHECKLIST (floating panel)
 *     A collapsible panel anchored to the right side of the header.
 *     Each gap shows as:  [ ] Docker  +5%
 *     • Clicking a gap appends it to the chat textarea (via ChatPanel ref / event)
 *     • When the gap keyword is detected in resumeData, the checkbox checks off
 *       with a scale-spring animation and a Web Audio "pop" sound.
 *
 *  3. HOVERABLE BULLET POINTS — Edit & Magic buttons
 *     Each experience bullet wraps in a hover group.  On hover, two icon
 *     buttons appear to the right:
 *       ✏️ Edit   — replaces the bullet with an inline <textarea>
 *       ✨ Magic  — calls POST /api/rewrite-section, then shows the diff overlay
 *
 *  4. INLINE EDIT MODE
 *     When ✏️ is clicked, the bullet text becomes a controlled <textarea>.
 *     Cmd+Enter or the Save button commits the edit directly to the Zustand
 *     store without backend roundtrip.
 *
 *  5. DIFF OVERLAY (DiffView)
 *     Renders as a fixed overlay above the DocumentPreview panel when
 *     `pendingDiff` is non-null in the store.
 *     - Old text: red background + strikethrough
 *     - New text: green background
 *     - Score badge: "Accepting this increases your score from X% → Y%"
 *     - ✅ Accept  → calls `applyDiff()` in store + plays accept sound + haptic
 *     - ❌ Reject  → calls `setPendingDiff(null)`
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Check, CheckCircle2, ChevronDown, Download, FileText,
  Loader2, Lock, Sparkles, X, Zap,
} from 'lucide-react';
import { useAppStore, selectIsInterviewComplete, type DiffProposal } from '@/store/useAppStore';
import { BYOK_STORAGE_KEY } from '@/components/paywall/BYOKModal';
import { initAudioContext, playCheckSound, playAcceptSound } from '@/utils/audio';
import type { ResumeData } from '@/types';
import { StandardA4Layout } from './StandardA4Layout';

// ── Bonus keyword pools (used when score is 100% — ghost gaps for elite polish) ─
const BONUS_POOLS: Record<string, string[]> = {
  cloud:    ['FinOps', 'Chaos Engineering', 'SRE Practices', 'Multi-region HA', 'Zero-downtime Deployments'],
  frontend: ['Core Web Vitals', 'WCAG Accessibility', 'Design Systems', 'Bundle Optimization', 'SSR/SSG'],
  backend:  ['API Gateway', 'Event-Driven Architecture', 'Database Sharding', 'Rate Limiting', 'OpenAPI/Swagger'],
  data:     ['MLOps', 'Feature Engineering', 'Data Governance', 'A/B Testing', 'Real-time Pipelines'],
  devops:   ['GitOps', 'Observability', 'Incident Response', 'Capacity Planning', 'SLO/SLA Management'],
  default:  ['Technical Mentoring', 'Cross-functional Leadership', 'Stakeholder Management', 'Technical Documentation', 'Code Review Culture'],
};

const _CLOUD_KW    = ['aws', 'azure', 'gcp', 'cloud', 'kubernetes', 'k8s', 'terraform'];
const _FRONTEND_KW = ['react', 'vue', 'angular', 'typescript', 'css', 'tailwind', 'ui', 'frontend'];
const _BACKEND_KW  = ['node', 'python', 'java', 'api', 'rest', 'graphql', 'microservices', 'backend'];
const _DATA_KW     = ['sql', 'spark', 'ml', 'machine learning', 'data', 'analytics', 'bi', 'tableau'];
const _DEVOPS_KW   = ['ci/cd', 'docker', 'jenkins', 'github actions', 'monitoring', 'devops', 'sre'];

function deriveBonusKeywords(foundKeywords: string[], existingSkills: string[]): string[] {
  const found  = foundKeywords.map((k) => k.toLowerCase());
  const skills = existingSkills.map((s) => s.toLowerCase());
  const all    = [...found, ...skills];

  let category = 'default';
  if (_CLOUD_KW.some((k)    => all.some((a) => a.includes(k)))) category = 'cloud';
  else if (_DEVOPS_KW.some((k)  => all.some((a) => a.includes(k)))) category = 'devops';
  else if (_FRONTEND_KW.some((k) => all.some((a) => a.includes(k)))) category = 'frontend';
  else if (_BACKEND_KW.some((k)  => all.some((a) => a.includes(k)))) category = 'backend';
  else if (_DATA_KW.some((k)    => all.some((a) => a.includes(k)))) category = 'data';

  const pool = BONUS_POOLS[category] ?? BONUS_POOLS.default;
  const existingSet = new Set([...found, ...skills]);
  return pool.filter((kw) => !existingSet.has(kw.toLowerCase())).slice(0, 5);
}

// ── Deterministic gap value (3–7%) per keyword ────────────────────────────────
function getGapValue(gap: string): number {
  let h = 0;
  for (let i = 0; i < gap.length; i++) h = (h * 31 + gap.charCodeAt(i)) | 0;
  return 3 + (Math.abs(h) % 5);
}

// ── Animated ATS score counter hook ───────────────────────────────────────────
function useAnimatedCounter(target: number | null, duration = 700): number | null {
  const [displayed, setDisplayed] = useState<number | null>(target);
  const prevRef = useRef<number>(target ?? 0);
  const rafRef  = useRef<number | null>(null);

  useEffect(() => {
    if (target === null) { setDisplayed(null); return; }

    const start    = prevRef.current;
    const end      = target;
    const startTime = performance.now();

    const update = (now: number) => {
      const elapsed  = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // Ease-out cubic
      const t = 1 - Math.pow(1 - progress, 3);
      setDisplayed(Math.round(start + (end - start) * t));
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(update);
      } else {
        prevRef.current = end;
      }
    };

    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(update);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [target, duration]);

  return displayed;
}

// ── ATS Score Ring ────────────────────────────────────────────────────────────
/**
 * Circular progress ring with animated counter.
 * Ring colour: green (≥75), orange (50–74), red (<50).
 */
const AtsScoreRing: React.FC<{ score: number | null }> = ({ score }) => {
  const animated = useAnimatedCounter(score);

  if (animated === null) return null;

  const pct   = Math.min(100, Math.max(0, animated));
  const color = pct >= 75 ? '#34d399' : pct >= 50 ? '#fb923c' : '#f87171';

  // SVG circle: circumference = 2π × r = 2π × 14 ≈ 87.96
  const r    = 14;
  const circ = 2 * Math.PI * r;
  const dash = (pct / 100) * circ;

  return (
    <div className="flex items-center gap-1.5">
      <div className="relative w-10 h-10 flex items-center justify-center">
        <svg width="40" height="40" className="-rotate-90">
          {/* Track */}
          <circle cx="20" cy="20" r={r} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="3" />
          {/* Progress */}
          <motion.circle
            cx="20" cy="20" r={r} fill="none"
            stroke={color} strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={circ}
            strokeDashoffset={circ - dash}
            animate={{ strokeDashoffset: circ - dash }}
            transition={{ duration: 0.7, ease: 'easeOut' }}
          />
        </svg>
        <span className="absolute text-[10px] font-bold" style={{ color }}>
          {pct}
        </span>
      </div>
      <div>
        <p className="text-[9px] font-semibold text-slate-400 uppercase tracking-wide leading-none">ATS</p>
        <p className="text-[9px] text-slate-500 leading-none">Score</p>
      </div>
    </div>
  );
};

// ── Skill Gap Checklist ───────────────────────────────────────────────────────

/** Dispatches a custom event that ChatPanel listens to — avoids prop-drilling. */
function dispatchInsertSkill(gap: string) {
  window.dispatchEvent(new CustomEvent('jobifai:insertSkill', { detail: { gap } }));
}

/**
 * Dispatches a guided coaching prompt into the chat input when a ghost keyword
 * is clicked.  The prompt instructs the user to surface a real-world example
 * rather than blindly inserting the keyword — preserving resume authenticity.
 *
 * Uses the same `jobifai:insertSkill` event channel as the checklist chips so
 * ChatPanel only needs one listener.
 */
function dispatchGhostKeywordPrompt(keyword: string): void {
  window.dispatchEvent(
    new CustomEvent('jobifai:insertSkill', {
      detail: {
        gap: `I see that '${keyword}' is a missing keyword. Can you help me find a specific example from my experience to include it?`,
      },
    }),
  );
}

// ── Ghost Skill Chip ──────────────────────────────────────────────────────────
/**
 * Renders a missing ATS keyword as a dashed "ghost" placeholder injected inline
 * into the Skills section of the resume canvas.
 *
 * BEHAVIOUR:
 *   • Visually distinct from real skills — dashed border, muted slate tone.
 *   • Shows a tiny "+X%" badge computed deterministically from the keyword hash
 *     so the value is stable across renders but feels unique per-keyword.
 *   • Clicking fires a guided coaching prompt into the chat input — does NOT
 *     write the keyword directly into resumeData (that would be dishonest).
 *   • Framer Motion scale-spring on hover/tap for tactile feedback.
 *
 * ROBUSTNESS:
 *   • Receives only a `keyword: string` — no complex object shape to validate.
 *   • `useCallback` memoises the click handler so the chip never re-renders
 *     unless the keyword itself changes.
 */
const GhostSkillChip: React.FC<{ keyword: string }> = ({ keyword }) => {
  const scoreIncrease = getGapValue(keyword);  // deterministic 3–7 from existing hash fn

  const handleClick = useCallback(() => {
    initAudioContext();
    dispatchGhostKeywordPrompt(keyword);
  }, [keyword]);

  return (
    <motion.button
      type="button"
      onClick={handleClick}
      className="text-xs text-slate-300 border border-slate-200 border-dashed rounded px-2 ml-1 cursor-pointer hover:bg-slate-50 transition inline-flex items-center gap-1.5"
      whileHover={{ scale: 1.05 }}
      whileTap={{ scale: 0.95 }}
      title={`"${keyword}" is a missing keyword — click to get AI help adding it authentically`}
    >
      <span>{keyword}</span>
      {/* Score badge — visually separate from the keyword text */}
      <span
        className="text-[9px] font-bold text-slate-400 bg-slate-100 border border-slate-200 rounded px-1 py-0.5 leading-none tabular-nums"
        aria-label={`potential score increase: +${scoreIncrease} percent`}
      >
        +{scoreIncrease}%
      </span>
    </motion.button>
  );
};

const SkillGapChecklist: React.FC<{
  gaps:          string[];
  missingSkills: Array<{ skill: string; impact_percentage: number }>;
  matchedSkills: string[];
  resumeData:    Partial<ResumeData>;
  // ── Iron Logic overrides (Task 19) ───────────────────────────────────────
  // When present, these come from analysisResult and take strict precedence
  // over the legacy skillGaps / matchedSkills arrays.
  foundKeywords?:   string[];   // green ✅ chips  — analysisResult.foundKeywords
  missingKeywords?: string[];   // red ❌ chips    — analysisResult.missingKeywords
                                // (empty array [] triggers the Triumph state)
}> = ({ gaps, missingSkills, matchedSkills, resumeData, foundKeywords, missingKeywords }) => {
  const [isOpen, setIsOpen] = useState(true);
  const prevSatisfied = useRef<Set<string>>(new Set());

  // ── Resolve effective data sources ────────────────────────────────────────
  // If `analysisResult` provided the Iron Logic arrays, use those.
  // Otherwise fall back to the legacy store fields (scratch-mode / old flow).
  const effectiveGaps    = missingKeywords ?? gaps;
  const effectiveMatched = foundKeywords   ?? matchedSkills;

  // Build a lookup map: skill → impact_percentage (from legacy backend data).
  // Not available in the new analysisResult contract — we use getGapValue() instead.
  const impactMap = new Map(missingSkills.map((s) => [s.skill.toLowerCase(), s.impact_percentage]));

  // Detect which gaps are already covered in the resume (live satisfaction check)
  const resumeText    = JSON.stringify(resumeData).toLowerCase();
  const satisfiedGaps = new Set(
    effectiveGaps.filter((g) => resumeText.includes(g.toLowerCase())),
  );

  // Play pop sound when a gap transitions from unsatisfied → satisfied
  useEffect(() => {
    for (const gap of satisfiedGaps) {
      if (!prevSatisfied.current.has(gap)) {
        playCheckSound();
        if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
          navigator.vibrate([30]);
        }
      }
    }
    prevSatisfied.current = satisfiedGaps;
  });   // intentional: runs every render to detect newly-satisfied gaps

  // Nothing to show at all
  if (effectiveGaps.length === 0 && effectiveMatched.length === 0) return null;

  const pendingGaps   = effectiveGaps.filter((g) => !satisfiedGaps.has(g));
  const completedGaps = effectiveGaps.filter((g) =>  satisfiedGaps.has(g));
  const progress      = completedGaps.length;
  const total         = effectiveGaps.length;

  // ── Triumph condition ─────────────────────────────────────────────────────
  // `missingKeywords` is only defined when we have a real analysisResult.
  // An empty array means the backend found ZERO gaps — perfect keyword coverage.
  const isTriumph = missingKeywords !== undefined && missingKeywords.length === 0;

  return (
    <motion.div
      className="flex-shrink-0 border-b border-gray-200 bg-white"
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 300, damping: 26 }}
    >
      {/* ── Header row ──────────────────────────────────────────────────────── */}
      <button
        onClick={() => setIsOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-2">
          {isTriumph ? (
            <>
              <span className="text-sm leading-none">🏆</span>
              <span className="text-xs font-semibold text-emerald-700">
                Stellar Match
              </span>
            </>
          ) : (
            <>
              <Zap className="w-3.5 h-3.5 text-orange-500" />
              <span className="text-xs font-semibold text-gray-800">
                ATS Gaps
              </span>
              <span className="text-[10px] font-medium text-gray-500">
                {progress}/{total} resolved
              </span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Mini progress bar — only relevant when gaps exist */}
          {!isTriumph && total > 0 && (
            <div className="w-16 h-1 bg-gray-200 rounded-full overflow-hidden">
              <motion.div
                className="h-full bg-gradient-to-r from-orange-500 to-emerald-400 rounded-full"
                animate={{ width: `${(progress / total) * 100}%` }}
                transition={{ duration: 0.5, ease: 'easeOut' }}
              />
            </div>
          )}
          <motion.div animate={{ rotate: isOpen ? 180 : 0 }} transition={{ duration: 0.2 }}>
            <ChevronDown className="w-3.5 h-3.5 text-gray-400" />
          </motion.div>
        </div>
      </button>

      {/* ── Collapsible body ────────────────────────────────────────────────── */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-3 space-y-2">

              {/* ── Triumph empty state ────────────────────────────────────── */}
              {/* Rendered ONLY when analysisResult.missingKeywords is [] — i.e.
                  the backend found ZERO gaps.  No phantom empty space, no header. */}
              {isTriumph && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.97 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ type: 'spring', stiffness: 340, damping: 26 }}
                  className="flex items-start gap-3 bg-gradient-to-br from-emerald-50 to-teal-50 border border-emerald-200 rounded-xl px-3.5 py-3"
                >
                  <span className="text-xl flex-shrink-0 mt-0.5" role="img" aria-label="trophy">🏆</span>
                  <div>
                    <p className="text-xs font-semibold text-emerald-800 leading-snug">
                      Stellar Match!
                    </p>
                    <p className="text-[11px] text-emerald-700 leading-snug mt-0.5">
                      Your resume hits all the critical keywords for this job description.
                    </p>
                  </div>
                </motion.div>
              )}

              {/* ── Missing / pending gaps — clickable chips ───────────────── */}
              {/* Only rendered when there ARE gaps (triumph state hides this) */}
              {!isTriumph && pendingGaps.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {pendingGaps.map((gap) => (
                    <motion.button
                      key={gap}
                      onClick={() => {
                        initAudioContext();
                        dispatchInsertSkill(gap);
                      }}
                      className="flex items-center gap-1.5 text-[11px] font-medium text-orange-700 bg-orange-50 border border-orange-300 hover:bg-orange-100 hover:border-orange-400 rounded-full px-2.5 py-1 transition-colors cursor-pointer"
                      whileHover={{ scale: 1.04 }}
                      whileTap={{ scale: 0.96 }}
                      title={`Click to insert "${gap}" into chat`}
                    >
                      <span className="w-3 h-3 rounded border border-orange-400 flex-shrink-0" />
                      {gap}
                      <span className="text-orange-500 font-semibold">
                        +{impactMap.get(gap.toLowerCase()) ?? getGapValue(gap)}%
                      </span>
                    </motion.button>
                  ))}
                </div>
              )}

              {/* ── Resolved gaps — checked off ────────────────────────────── */}
              {completedGaps.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {completedGaps.map((gap) => (
                    <motion.div
                      key={gap}
                      className="flex items-center gap-1.5 text-[11px] font-medium text-emerald-700/70 bg-emerald-50 border border-emerald-200 rounded-full px-2.5 py-1"
                      initial={{ scale: 1.2 }}
                      animate={{ scale: 1 }}
                      transition={{ type: 'spring', stiffness: 500, damping: 20 }}
                    >
                      <motion.div
                        initial={{ scale: 0 }}
                        animate={{ scale: 1 }}
                        transition={{ type: 'spring', stiffness: 600, damping: 18 }}
                      >
                        <Check className="w-3 h-3 text-emerald-600" />
                      </motion.div>
                      <span className="line-through opacity-60">{gap}</span>
                    </motion.div>
                  ))}
                </div>
              )}

              {/* ── Found / matched keywords — green chips ─────────────────── */}
              {/* Rendered regardless of triumph state — proves the analysis ran */}
              {effectiveMatched.length > 0 && (
                <div>
                  <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1">
                    {isTriumph ? 'All keywords matched' : 'Already matched'}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {effectiveMatched.map((skill) => (
                      <span
                        key={skill}
                        className="flex items-center gap-1 text-[11px] font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2.5 py-1"
                      >
                        <Check className="w-2.5 h-2.5 text-emerald-500" />
                        {skill}
                      </span>
                    ))}
                  </div>
                </div>
              )}

            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};


// ── Diff Overlay ──────────────────────────────────────────────────────────────

const DiffView: React.FC<{ diff: DiffProposal }> = ({ diff }) => {
  const applyDiff      = useAppStore((s) => s.applyDiff);
  const setPendingDiff = useAppStore((s) => s.setPendingDiff);
  const bumpAtsScore   = useAppStore((s) => s.bumpAtsScore);

  const newScore = diff.baselineScore + diff.predictedScoreIncrease;

  const handleAccept = useCallback(() => {
    initAudioContext();
    playAcceptSound();
    applyDiff();
    if (diff.predictedScoreIncrease > 0) {
      bumpAtsScore(diff.predictedScoreIncrease);
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        navigator.vibrate([50]);
      }
    }
  }, [applyDiff, bumpAtsScore, diff.predictedScoreIncrease]);

  const handleReject = useCallback(() => {
    setPendingDiff(null);
  }, [setPendingDiff]);

  return (
    <motion.div
      className="absolute inset-0 z-40 flex flex-col justify-end bg-slate-900/80 backdrop-blur-sm"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <motion.div
        className="bg-slate-800 border-t border-slate-600/60 rounded-t-2xl shadow-2xl"
        initial={{ y: 40, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 40, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 340, damping: 30 }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-700/50">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-orange-400" />
            <span className="text-sm font-semibold text-slate-200">Magic Rewrite</span>
          </div>
          <button onClick={handleReject} className="text-slate-500 hover:text-slate-300 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-3 max-h-[60vh] overflow-y-auto scrollbar-hidden">
          {/* Old text — red strikethrough */}
          <div>
            <p className="text-[10px] font-semibold text-red-400 uppercase tracking-wide mb-1.5">Before</p>
            <div className="bg-red-500/10 border border-red-500/25 rounded-xl px-3.5 py-2.5">
              <p className="text-sm text-red-300/80 line-through leading-relaxed">
                {diff.oldText}
              </p>
            </div>
          </div>

          {/* New text — green highlight */}
          <div>
            <p className="text-[10px] font-semibold text-emerald-400 uppercase tracking-wide mb-1.5">After</p>
            <div className="bg-emerald-500/10 border border-emerald-500/25 rounded-xl px-3.5 py-2.5">
              <p className="text-sm text-emerald-200 leading-relaxed">
                {diff.newText}
              </p>
            </div>
          </div>

          {/* Score impact badge */}
          {diff.predictedScoreIncrease > 0 && (
            <motion.div
              className="flex items-center gap-2 bg-gradient-to-r from-orange-500/10 to-emerald-500/10 border border-orange-400/20 rounded-xl px-3.5 py-2.5"
              initial={{ scale: 0.95 }}
              animate={{ scale: 1 }}
              transition={{ type: 'spring', stiffness: 400, damping: 24 }}
            >
              <Zap className="w-3.5 h-3.5 text-orange-400 flex-shrink-0" />
              <p className="text-xs text-slate-300">
                Accepting this increases your ATS score from{' '}
                <span className="font-bold text-orange-300">{diff.baselineScore}%</span>
                {' → '}
                <span className="font-bold text-emerald-300">{Math.min(100, newScore)}%</span>
              </p>
            </motion.div>
          )}
        </div>

        {/* Accept / Reject */}
        <div className="px-5 pb-5 flex gap-2.5">
          <button
            onClick={handleAccept}
            className="flex-1 flex items-center justify-center gap-2 bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 text-white font-semibold text-sm py-3 rounded-xl transition-all shadow-lg shadow-emerald-500/20 active:scale-[0.98]"
          >
            <Check className="w-4 h-4" />
            Accept
          </button>
          <button
            onClick={handleReject}
            className="flex-1 flex items-center justify-center gap-2 bg-slate-700 hover:bg-slate-600 text-slate-200 font-semibold text-sm py-3 rounded-xl transition-all active:scale-[0.98]"
          >
            <X className="w-4 h-4" />
            Reject
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
};

// ── Main Component ─────────────────────────────────────────────────────────────
export const DocumentPreview: React.FC = () => {

  // ── Store ─────────────────────────────────────────────────────────────────
  const resumeData         = useAppStore((s) => s.resumeData);
  const uploadedResumeText = useAppStore((s) => s.uploadedResumeText);
  const isPremium          = useAppStore((s) => s.isPremium);
  const isComplete         = useAppStore(selectIsInterviewComplete);
  const currentStep        = useAppStore((s) => s.currentStep);
  const currentAtsScore    = useAppStore((s) => s.currentAtsScore);
  const skillGaps          = useAppStore((s) => s.skillGaps);
  const matchedSkills      = useAppStore((s) => s.matchedSkills);
  const missingSkills      = useAppStore((s) => s.missingSkills);
  // Iron Logic (Task 19) — single source of truth when analysis has run
  const analysisResult     = useAppStore((s) => s.analysisResult);
  const pendingDiff        = useAppStore((s) => s.pendingDiff);

  // ── Ghost keywords — inline skill-section injection ──────────────────────
  // Derived from `analysisResult.missingKeywords` after filtering out any
  // keyword already present in `resumeData.skills` (case-insensitive).
  //
  // Guard layers:
  //   1. `analysisResult` may be null  → early-return empty array
  //   2. `missingKeywords` must be a real array (defensive against bad API shapes)
  //   3. Each keyword must be a non-empty string
  //   4. Case-insensitive deduplicate against the current skills list
  // ghostKeywords: real missing keywords, OR bonus keywords when score is 100%
  const ghostKeywords: string[] = (() => {
    if (analysisResult === null) return [];

    const missing = analysisResult.missingKeywords;

    // 100% match — inject "Stand out further" bonus gaps instead
    if (!Array.isArray(missing) || missing.length === 0) {
      return deriveBonusKeywords(
        analysisResult.foundKeywords ?? [],
        (resumeData.skills ?? []).filter((s): s is string => typeof s === 'string'),
      );
    }

    const existingLower = new Set(
      (resumeData.skills ?? [])
        .filter((s): s is string => typeof s === 'string')
        .map((s) => s.toLowerCase()),
    );

    return missing.filter(
      (k): k is string =>
        typeof k === 'string' &&
        k.trim().length > 0 &&
        !existingLower.has(k.toLowerCase()),
    );
  })();

  // True when score is 100 and we're showing enhancement suggestions instead of gaps
  const isBonusMode = analysisResult !== null &&
    Array.isArray(analysisResult.missingKeywords) &&
    analysisResult.missingKeywords.length === 0 &&
    ghostKeywords.length > 0;
  const jobDescription     = useAppStore((s) => s.jobDescription);
  const setPendingDiff     = useAppStore((s) => s.setPendingDiff);

  const hasByokKey = Boolean(localStorage.getItem(BYOK_STORAGE_KEY));
  const isUnlocked = isPremium || hasByokKey;
  const userEmail  = useAppStore((s) => s.user?.email);

  // ── PDF Generation ───────────────────────────────────────────────────────
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const [pdfError,        setPdfError]        = useState('');
  const [premiumToast,    setPremiumToast]    = useState('');

  // Auto-dismiss the premium "coming soon" toast after 3 s
  useEffect(() => {
    if (!premiumToast) return;
    const t = setTimeout(() => setPremiumToast(''), 3000);
    return () => clearTimeout(t);
  }, [premiumToast]);

  const handleDownloadPdf = async () => {
    if (isGeneratingPdf) return;
    setIsGeneratingPdf(true);
    setPdfError('');
    try {
      const [{ pdf }, { ResumePDF }] = await Promise.all([
        import('@react-pdf/renderer'),
        import('./ResumePDF'),
      ]);
      const doc  = <ResumePDF data={resumeData as ResumeData} userEmail={userEmail} />;
      const blob = await pdf(doc).toBlob();
      const safeName = (resumeData.targetTitle ?? 'resume')
        .replace(/[^a-zA-Z0-9\s-]/g, '')
        .trim()
        .replace(/\s+/g, '_');
      const url = URL.createObjectURL(blob);
      const a   = document.createElement('a');
      a.href     = url;
      a.download = `${safeName}_JobifAI.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('[ResumePDF] generation failed:', err);
      setPdfError('PDF generation failed. Please try again.');
    } finally {
      setIsGeneratingPdf(false);
    }
  };

  const hasContent = Object.values(resumeData).some((v) =>
    v !== undefined && v !== '' && (Array.isArray(v) ? v.length > 0 : true),
  );
  // Show the interactive layout when resumeData has content OR when analysis
  // has run (analysisResult is non-null) — this fixes the 100% score case where
  // resumeData may be partially populated but still has a full analysis result.
  const showLayout = hasContent || analysisResult !== null;

  // ── Highlight-flash tracking ───────────────────────────────────────────────
  const seenIdsRef  = useRef<Set<string>>(new Set());
  const [flashingIds, setFlashingIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const fresh: string[] = [];
    for (const exp of resumeData.experiences ?? []) {
      if (!seenIdsRef.current.has(exp.id)) { seenIdsRef.current.add(exp.id); fresh.push(exp.id); }
    }
    for (const edu of resumeData.education ?? []) {
      if (!seenIdsRef.current.has(edu.id)) { seenIdsRef.current.add(edu.id); fresh.push(edu.id); }
    }
    for (const skill of resumeData.skills ?? []) {
      const key = `skill:${skill}`;
      if (!seenIdsRef.current.has(key)) { seenIdsRef.current.add(key); fresh.push(key); }
    }
    if (fresh.length === 0) return;
    setFlashingIds((prev) => { const next = new Set(prev); fresh.forEach((id) => next.add(id)); return next; });
    const timer = setTimeout(() => {
      setFlashingIds((prev) => { const next = new Set(prev); fresh.forEach((id) => next.delete(id)); return next; });
    }, 1400);
    return () => clearTimeout(timer);
  }, [resumeData]);

  // ── Magic Rewrite handler ─────────────────────────────────────────────────
  const handleMagic = useCallback(async (fieldPath: string, oldText: string, section: string) => {
    const baselineScore = useAppStore.getState().currentAtsScore;
    try {
      const res = await fetch('/api/rewrite-section', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          section,
          old_text:        oldText,
          job_description: jobDescription.slice(0, 2000),
          resume_context:  JSON.stringify(resumeData).slice(0, 1500),
        }),
      });
      if (!res.ok) throw new Error(`Rewrite API ${res.status}`);
      const data = await res.json();
      setPendingDiff({
        fieldPath,
        oldText,
        newText:                 data.new_text,
        predictedScoreIncrease:  data.predicted_score_increase,
        baselineScore,
      });
    } catch (err) {
      console.error('[Magic Rewrite] failed:', err);
      setPremiumToast('✨ Magic Rewrite failed — please try again in a moment.');
    }
  }, [jobDescription, resumeData, setPendingDiff]);

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="relative h-full flex flex-col bg-slate-100">

      {/* ── Panel header ─────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 flex items-center justify-between px-5 py-3 border-b border-gray-200 bg-white">
        <div className="flex items-center gap-2">
          <FileText className="w-4 h-4 text-orange-500" />
          <h2 className="text-sm font-semibold text-gray-800">Resume Preview</h2>
        </div>

        <div className="flex items-center gap-3">
          {/* Animated ATS Score Ring */}
          <AnimatePresence>
            {currentAtsScore > 0 && (
              <motion.div
                key="ats-ring"
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                transition={{ type: 'spring', stiffness: 400, damping: 24 }}
              >
                <AtsScoreRing score={currentAtsScore} />
              </motion.div>
            )}
          </AnimatePresence>

          {isComplete && (
            <motion.div
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              className="flex items-center gap-1.5 text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2.5 py-0.5"
            >
              <CheckCircle2 className="w-3 h-3" />
              Complete
            </motion.div>
          )}
          {isComplete && !isUnlocked && (
            <motion.div
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              className="flex items-center gap-1 text-xs text-orange-600 bg-orange-50 border border-orange-200 rounded-full px-2.5 py-0.5"
            >
              <Lock className="w-3 h-3" />
              Export locked
            </motion.div>
          )}
        </div>
      </div>

      {/* ── Skill Gap Checklist ────────────────────────────────────────────── */}
      {/* Visible when:
           • Iron Logic path — analysisResult is non-null (always has data to show)
           • Legacy path     — old skillGaps or matchedSkills arrays have content
          hasContent guard keeps it hidden on the blank "start chatting" placeholder. */}
      <AnimatePresence>
        {(analysisResult !== null || skillGaps.length > 0 || matchedSkills.length > 0) && showLayout && (
          <SkillGapChecklist
            key="skill-gaps"
            gaps={skillGaps}
            missingSkills={missingSkills}
            matchedSkills={matchedSkills}
            resumeData={resumeData}
            // Iron Logic overrides — undefined when no analysisResult yet
            foundKeywords={analysisResult?.foundKeywords}
            missingKeywords={analysisResult?.missingKeywords}
          />
        )}
      </AnimatePresence>

      {/* ── Scrollable resume content ─────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto scrollbar-hidden">

        {!showLayout ? (
          uploadedResumeText?.trim() ? (
            <div className="py-8 px-4">
              <motion.div
                className="bg-white rounded-sm border border-gray-200 shadow-lg mx-auto max-w-[21cm] w-full min-h-[29.7cm] text-black"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ type: 'spring', stiffness: 260, damping: 22 }}
              >
                <div className="h-1 bg-gradient-to-r from-orange-500 via-orange-400 to-amber-400" />
                <div className="p-8">
                  <div className="flex items-center gap-2 mb-3">
                    <Loader2 className="w-3.5 h-3.5 text-orange-500 animate-spin" />
                    <span className="text-xs font-semibold text-orange-600 uppercase tracking-wide">
                      Mac is analyzing your resume…
                    </span>
                  </div>
                  <pre className="text-xs text-gray-500 whitespace-pre-wrap break-words leading-relaxed font-mono max-h-[60vh] overflow-y-auto scrollbar-hidden">
                    {uploadedResumeText.slice(0, 4000)}
                    {uploadedResumeText.length > 4000 && '\n\n[…truncated for preview]'}
                  </pre>
                </div>
              </motion.div>
            </div>
          ) : (
            <div className="h-full flex flex-col items-center justify-center gap-5 px-8 py-10 text-center">
              <div className="w-full max-w-sm space-y-3">
                {[100, 55, 75, 42, 68, 50].map((w, i) => (
                  <motion.div
                    key={i}
                    className="h-2.5 rounded-full bg-gray-200"
                    style={{ width: `${w}%` }}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: [0.4, 0.7, 0.4] }}
                    transition={{
                      opacity: { repeat: Infinity, duration: 1.8, delay: i * 0.1 },
                      x:       { duration: 0.3, delay: i * 0.06 },
                    }}
                  />
                ))}
              </div>
              <div className="mt-2">
                <p className="text-sm font-medium text-gray-500">Your resume appears here as you chat</p>
                <p className="text-xs text-gray-400 mt-1">Answer Mac's questions to fill it in →</p>
              </div>
            </div>
          )
        ) : (
          <div className="py-8 px-4 pb-12">
            <StandardA4Layout
              resumeData={resumeData}
              ghostKeywords={ghostKeywords}
              bonusMode={isBonusMode}
              flashingIds={flashingIds}
              isUnlocked={isUnlocked}
              userEmail={userEmail}
              onMagic={handleMagic}
              onGhostClick={dispatchGhostKeywordPrompt}
              onPaywall={() => setPremiumToast('Magic Rewrite requires Premium — unlock to use it.')}
            />
          </div>
        )}
      </div>

      {/* ── PAYWALL OVERLAY ────────────────────────────────────────────────── */}
      <AnimatePresence>
        {isComplete && !isUnlocked && (
          <motion.div
            key="paywall"
            className="absolute inset-0 flex items-center justify-center z-20"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          >
            <div className="absolute inset-0 backdrop-blur-md bg-slate-900/60" />
            <motion.div
              className="relative z-10 bg-slate-800 border border-slate-700 rounded-3xl shadow-2xl p-8 text-center max-w-xs mx-4"
              initial={{ scale: 0.9, y: 16 }}
              animate={{ scale: 1,   y: 0 }}
              transition={{ type: 'spring', stiffness: 340, damping: 26 }}
            >
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-orange-400 to-amber-500 flex items-center justify-center mx-auto mb-4 shadow-lg shadow-orange-500/30">
                <Sparkles className="w-6 h-6 text-white" />
              </div>
              <h3 className="text-lg font-bold text-slate-100 mb-1.5">Your resume is ready!</h3>
              <p className="text-sm text-slate-400 mb-6">
                Unlock PDF export and ATS optimisation to download your polished resume.
              </p>
              <button className="w-full bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 text-white font-semibold py-3 rounded-2xl transition-all shadow-lg shadow-orange-500/25 hover:shadow-orange-500/40 active:scale-[0.98]">
                Unlock · $5 / 24h
              </button>
              <p className="text-xs text-slate-500 mt-3">
                Or{' '}
                <button className="text-orange-400 hover:text-orange-300 font-medium transition-colors">
                  subscribe monthly
                </button>
                {' '}for unlimited exports
              </p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Export bar (unlocked users only) ──────────────────────────────── */}
      <AnimatePresence>
        {isComplete && isUnlocked && (
          <motion.div
            key="export-bar"
            className="flex-shrink-0 px-4 py-3 border-t border-gray-200 bg-white space-y-2"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
          >
            <button
              onClick={handleDownloadPdf}
              disabled={isGeneratingPdf}
              className={[
                'w-full font-semibold py-3 rounded-2xl transition-all',
                'flex items-center justify-center gap-2 text-sm',
                'shadow-lg shadow-orange-500/25',
                isGeneratingPdf
                  ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                  : 'bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 text-white hover:shadow-orange-500/40 active:scale-[0.98]',
              ].join(' ')}
            >
              {isGeneratingPdf ? (
                <><Loader2 className="w-4 h-4 animate-spin" />Building PDF…</>
              ) : (
                <><Download className="w-4 h-4" />Download ATS-Optimised PDF</>
              )}
            </button>

            {/* ── Premium teaser buttons ─────────────────────────────── */}
            <div className="flex gap-2">
              <button
                onClick={() => setPremiumToast('Generate Cover Letter is coming soon for Premium subscribers!')}
                className="flex-1 flex items-center justify-center gap-1.5 text-xs font-medium text-orange-600 border border-orange-300 rounded-xl py-2 hover:bg-orange-50 transition-colors"
              >
                Cover Letter 🪄
              </button>
              <button
                onClick={() => setPremiumToast('Interview Prep is coming soon for Premium subscribers!')}
                className="flex-1 flex items-center justify-center gap-1.5 text-xs font-medium text-slate-600 border border-gray-300 rounded-xl py-2 hover:bg-gray-50 transition-colors"
              >
                Interview Prep
              </button>
            </div>

            <AnimatePresence>
              {pdfError && (
                <motion.p
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="text-xs text-red-500 text-center"
                >
                  {pdfError}
                </motion.p>
              )}
            </AnimatePresence>
            <p className="text-[10px] text-gray-400 text-center">
              Helvetica · 1-inch margins · ATS text layer · Canadian HR standards
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Premium "Coming Soon" Toast ───────────────────────────────────── */}
      <AnimatePresence>
        {premiumToast && (
          <motion.div
            key="premium-toast"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            className="absolute bottom-20 left-1/2 -translate-x-1/2 z-40 bg-gray-900 text-white text-xs font-medium px-4 py-2.5 rounded-full shadow-lg whitespace-nowrap"
          >
            {premiumToast}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Diff Overlay ──────────────────────────────────────────────────── */}
      <AnimatePresence>
        {pendingDiff && <DiffView key="diff-view" diff={pendingDiff} />}
      </AnimatePresence>

      {/* ARIA live region */}
      <div aria-live="polite" className="sr-only">
        {currentStep !== 'idle' && `Resume updated — now on step: ${currentStep}`}
      </div>
    </div>
  );
};

