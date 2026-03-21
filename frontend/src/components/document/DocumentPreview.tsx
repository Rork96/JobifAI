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
  Check, CheckCircle2, ChevronDown, Download, Edit3, FileText,
  Loader2, Lock, Sparkles, X, Zap,
} from 'lucide-react';
import { useAppStore, selectIsInterviewComplete, type DiffProposal } from '@/store/useAppStore';
import { BYOK_STORAGE_KEY } from '@/components/paywall/BYOKModal';
import { initAudioContext, playCheckSound, playAcceptSound } from '@/utils/audio';
import type { ResumeData } from '@/types';

// ── Section-fade preset ───────────────────────────────────────────────────────
const sectionVariants = {
  hidden:  { opacity: 0, y: 14 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { type: 'spring', stiffness: 280, damping: 24 },
  },
};

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

const SkillGapChecklist: React.FC<{
  gaps:          string[];
  missingSkills: Array<{ skill: string; impact_percentage: number }>;
  matchedSkills: string[];
  resumeData:    Partial<ResumeData>;
}> = ({ gaps, missingSkills, matchedSkills, resumeData }) => {
  const [isOpen, setIsOpen] = useState(true);
  const prevSatisfied = useRef<Set<string>>(new Set());

  // Build a lookup map: skill → impact_percentage (from real backend data)
  const impactMap = new Map(missingSkills.map((s) => [s.skill.toLowerCase(), s.impact_percentage]));

  // Detect which gaps are already covered in the resume
  const resumeText = JSON.stringify(resumeData).toLowerCase();
  const satisfiedGaps = new Set(
    gaps.filter((g) => resumeText.includes(g.toLowerCase())),
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
  });   // runs after every render — intentional (checks newly satisfied gaps)

  if (gaps.length === 0 && matchedSkills.length === 0) return null;

  const pendingGaps    = gaps.filter((g) => !satisfiedGaps.has(g));
  const completedGaps  = gaps.filter((g) =>  satisfiedGaps.has(g));
  const progress       = completedGaps.length;
  const total          = gaps.length;

  return (
    <motion.div
      className="flex-shrink-0 border-b border-gray-200 bg-white"
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 300, damping: 26 }}
    >
      {/* Header row */}
      <button
        onClick={() => setIsOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Zap className="w-3.5 h-3.5 text-orange-500" />
          <span className="text-xs font-semibold text-gray-800">
            ATS Gaps
          </span>
          <span className="text-[10px] font-medium text-gray-500">
            {progress}/{total} resolved
          </span>
        </div>
        <div className="flex items-center gap-2">
          {/* Mini progress bar */}
          <div className="w-16 h-1 bg-gray-200 rounded-full overflow-hidden">
            <motion.div
              className="h-full bg-gradient-to-r from-orange-500 to-emerald-400 rounded-full"
              animate={{ width: `${(progress / total) * 100}%` }}
              transition={{ duration: 0.5, ease: 'easeOut' }}
            />
          </div>
          <motion.div animate={{ rotate: isOpen ? 180 : 0 }} transition={{ duration: 0.2 }}>
            <ChevronDown className="w-3.5 h-3.5 text-gray-400" />
          </motion.div>
        </div>
      </button>

      {/* Collapsible gap list */}
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
              {/* Missing / pending gaps — clickable chips */}
              {pendingGaps.length > 0 && (
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
                      <span className="text-orange-500 font-semibold">+{impactMap.get(gap.toLowerCase()) ?? getGapValue(gap)}%</span>
                    </motion.button>
                  ))}
                </div>
              )}

              {/* Resolved gaps — checked off */}
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

              {/* Matched skills — already in the resume */}
              {matchedSkills.length > 0 && (
                <div>
                  <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1">
                    Already matched
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {matchedSkills.map((skill) => (
                      <span
                        key={skill}
                        className="flex items-center gap-1 text-[11px] font-medium text-slate-500 bg-slate-50 border border-slate-200 rounded-full px-2.5 py-1"
                      >
                        <Check className="w-2.5 h-2.5 text-slate-400" />
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

// ── Hoverable Bullet ──────────────────────────────────────────────────────────

interface HoverableBulletProps {
  text:      string;
  fieldPath: string;  // e.g. 'experiences.exp_123.responsibilities.0'
  onEdit:    (fieldPath: string, currentText: string) => void;
  onMagic:   (fieldPath: string, currentText: string, section: string) => void;
  section:   string;  // label for the magic rewrite prompt
}

const HoverableBullet: React.FC<HoverableBulletProps> = ({
  text, fieldPath, onEdit, onMagic, section,
}) => {
  const [hovered,    setHovered]    = useState(false);
  const [isEditing,  setIsEditing]  = useState(false);
  const [editValue,  setEditValue]  = useState(text);
  const [isMagicking, setIsMagicking] = useState(false);
  const editRef = useRef<HTMLTextAreaElement>(null);

  const updateResumeData = useAppStore((s) => s.updateResumeData);
  const applyFieldEdit   = useAppStore((s) => s.applyDiff);
  const setPendingDiff   = useAppStore((s) => s.setPendingDiff);

  // Focus textarea on edit mode
  useEffect(() => {
    if (isEditing) setTimeout(() => editRef.current?.focus(), 30);
  }, [isEditing]);

  const commitEdit = useCallback(() => {
    if (editValue.trim() && editValue !== text) {
      // Build a fake DiffProposal with no score increase to reuse applyDiff
      useAppStore.setState((state) => ({
        pendingDiff: {
          fieldPath,
          oldText:  text,
          newText:  editValue.trim(),
          predictedScoreIncrease: 0,
          baselineScore: state.currentAtsScore ?? 0,
        },
      }));
      applyFieldEdit();
    }
    setIsEditing(false);
  }, [editValue, text, fieldPath, applyFieldEdit]);

  const handleMagicClick = useCallback(async () => {
    setIsMagicking(true);
    try {
      onMagic(fieldPath, text, section);
    } finally {
      setIsMagicking(false);
    }
  }, [fieldPath, text, section, onMagic]);

  if (isEditing) {
    return (
      <li className="flex gap-2">
        <span className="text-orange-500/70 flex-shrink-0 mt-1 select-none">›</span>
        <div className="flex-1 space-y-1.5">
          <textarea
            ref={editRef}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') commitEdit();
              if (e.key === 'Escape') setIsEditing(false);
            }}
            rows={2}
            className="w-full text-sm text-gray-800 bg-gray-50 border border-brand-400/40 rounded-lg px-2.5 py-1.5 resize-none outline-none focus:border-brand-500/60 transition-colors"
          />
          <div className="flex gap-1.5">
            <button
              onClick={commitEdit}
              className="text-[11px] font-semibold text-white bg-brand-600 hover:bg-brand-500 rounded-md px-2.5 py-1 transition-colors"
            >
              Save ⌘↩
            </button>
            <button
              onClick={() => setIsEditing(false)}
              className="text-[11px] font-medium text-gray-500 hover:text-gray-700 rounded-md px-2 py-1 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      </li>
    );
  }

  return (
    <li
      className="flex gap-2 group/bullet relative"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span className="text-orange-500/70 flex-shrink-0 mt-0.5 select-none">›</span>
      <span className="text-sm text-gray-700 flex-1 leading-relaxed">{text}</span>

      {/* Hover action buttons */}
      <AnimatePresence>
        {hovered && (
          <motion.div
            className="absolute right-0 top-0 flex items-center gap-1 bg-white border border-gray-200 rounded-lg px-1.5 py-1 shadow-md z-10"
            initial={{ opacity: 0, scale: 0.85, x: 4 }}
            animate={{ opacity: 1, scale: 1, x: 0 }}
            exit={{ opacity: 0, scale: 0.85, x: 4 }}
            transition={{ type: 'spring', stiffness: 500, damping: 28 }}
          >
            {/* Edit button */}
            <button
              onClick={() => { setIsEditing(true); setEditValue(text); }}
              className="flex items-center gap-1 text-[10px] font-medium text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-md px-1.5 py-0.5 transition-colors"
              title="Edit this bullet"
            >
              <Edit3 className="w-2.5 h-2.5" />
              Edit
            </button>

            <div className="w-px h-3 bg-gray-200" />

            {/* Magic button */}
            <button
              onClick={handleMagicClick}
              disabled={isMagicking}
              className="flex items-center gap-1 text-[10px] font-medium text-orange-600 hover:text-orange-700 hover:bg-orange-50 rounded-md px-1.5 py-0.5 transition-colors disabled:opacity-50"
              title="AI Magic Rewrite"
            >
              {isMagicking ? (
                <Loader2 className="w-2.5 h-2.5 animate-spin" />
              ) : (
                <Sparkles className="w-2.5 h-2.5" />
              )}
              Magic
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </li>
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
  const pendingDiff        = useAppStore((s) => s.pendingDiff);
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
    const baselineScore = useAppStore.getState().currentAtsScore ?? 0;
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
            {currentAtsScore !== null && (
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
      <AnimatePresence>
        {(skillGaps.length > 0 || matchedSkills.length > 0) && hasContent && (
          <SkillGapChecklist
            key="skill-gaps"
            gaps={skillGaps}
            missingSkills={missingSkills}
            matchedSkills={matchedSkills}
            resumeData={resumeData}
          />
        )}
      </AnimatePresence>

      {/* ── Scrollable resume content ─────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto scrollbar-hidden">

        {!hasContent ? (
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
            {/* ── A4 Paper Sheet ─────────────────────────────────────────── */}
            <motion.div
              className="bg-white rounded-sm border border-gray-200 shadow-lg mx-auto max-w-[21cm] w-full min-h-[29.7cm] text-black"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ type: 'spring', stiffness: 260, damping: 22 }}
            >
              <div className="h-1 bg-gradient-to-r from-orange-500 via-orange-400 to-amber-400" />

              <div className="p-12 space-y-6">
                <motion.div
                  className="space-y-6"
                  initial="hidden"
                  animate="visible"
                  variants={{ visible: { transition: { staggerChildren: 0.08 } } }}
                >

                  {/* ── Target Title ──────────────────────────────────── */}
                  {resumeData.targetTitle && (
                    <motion.div variants={sectionVariants}>
                      <h1 className="text-2xl font-bold text-gray-900 tracking-tight leading-tight">
                        {resumeData.targetTitle}
                      </h1>
                      <div className="mt-2 h-0.5 w-12 bg-gradient-to-r from-orange-500 to-amber-400 rounded-full" />
                    </motion.div>
                  )}

                  {/* ── Professional Summary ──────────────────────────── */}
                  {resumeData.summary && (
                    <motion.section variants={sectionVariants} className="group/section">
                      <SectionHeading>Professional Summary</SectionHeading>
                      <div className="relative">
                        <p className="text-sm text-gray-700 leading-relaxed">
                          {resumeData.summary}
                        </p>
                        {/* Magic button for summary */}
                        <SectionMagicButton
                          onMagic={() => handleMagic('summary', resumeData.summary!, 'Professional Summary')}
                        />
                      </div>
                    </motion.section>
                  )}

                  {/* ── Work Experience ───────────────────────────────── */}
                  {(resumeData.experiences?.length ?? 0) > 0 && (
                    <motion.section variants={sectionVariants}>
                      <SectionHeading>Experience</SectionHeading>
                      <div className="space-y-5">
                        {resumeData.experiences!.map((exp) => {
                          const isFlashing = flashingIds.has(exp.id);
                          return (
                            <motion.div
                              key={exp.id}
                              initial={{ opacity: 0, x: -10 }}
                              animate={{
                                opacity: 1,
                                x: 0,
                                boxShadow: isFlashing
                                  ? [
                                      '0 0 0 2px rgba(251,146,60,0.7), 0 0 16px rgba(251,146,60,0.2)',
                                      '0 0 0 2px rgba(251,146,60,0.3), 0 0 8px rgba(251,146,60,0.1)',
                                      '0 0 0 0px rgba(251,146,60,0)',
                                    ]
                                  : '0 0 0 0px rgba(251,146,60,0)',
                              }}
                              transition={{
                                opacity: { duration: 0.3 },
                                x: { duration: 0.3 },
                                boxShadow: { duration: 1.4, ease: 'easeOut' },
                              }}
                              className="border-l-2 border-orange-400 pl-4 rounded-r-lg"
                            >
                              <div className="flex items-start justify-between gap-4">
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm font-semibold text-gray-900">{exp.title}</p>
                                  <p className="text-xs font-medium text-orange-600 mt-0.5">{exp.company}</p>
                                </div>
                                <p className="text-xs text-gray-500 whitespace-nowrap flex-shrink-0 font-mono">
                                  {exp.startDate} – {exp.endDate ?? 'Present'}
                                </p>
                              </div>

                              {exp.responsibilities.length > 0 && (
                                <ul className="mt-2.5 space-y-2">
                                  {exp.responsibilities.map((r, i) => (
                                    <HoverableBullet
                                      key={i}
                                      text={r}
                                      fieldPath={`experiences.${exp.id}.responsibilities.${i}`}
                                      section={`${exp.title} at ${exp.company}`}
                                      onEdit={(fp, t) => {
                                        // handled inline by HoverableBullet
                                      }}
                                      onMagic={handleMagic}
                                    />
                                  ))}
                                </ul>
                              )}

                              {exp.metrics.length > 0 && (
                                <div className="mt-2.5 flex flex-wrap gap-1.5">
                                  {exp.metrics.map((m, i) => (
                                    <span
                                      key={i}
                                      className="text-xs bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-full px-2.5 py-0.5 font-medium"
                                    >
                                      📈 {m}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </motion.div>
                          );
                        })}
                      </div>
                    </motion.section>
                  )}

                  {/* ── Skills ────────────────────────────────────────── */}
                  {(resumeData.skills?.length ?? 0) > 0 && (
                    <motion.section variants={sectionVariants}>
                      <SectionHeading>Skills</SectionHeading>
                      <div className="flex flex-wrap gap-1.5">
                        {resumeData.skills!.map((skill) => {
                          const key = `skill:${skill}`;
                          const isFlashing = flashingIds.has(key);
                          return (
                            <motion.span
                              key={skill}
                              initial={{ opacity: 0, scale: 0.8 }}
                              animate={{
                                opacity: 1,
                                scale: 1,
                                boxShadow: isFlashing
                                  ? ['0 0 0 2px rgba(251,146,60,0.6)', '0 0 0 1px rgba(251,146,60,0.2)', '0 0 0 0px rgba(251,146,60,0)']
                                  : '0 0 0 0px rgba(251,146,60,0)',
                              }}
                              transition={{
                                opacity: { duration: 0.25 },
                                scale: { type: 'spring', stiffness: 380, damping: 22 },
                                boxShadow: { duration: 1.4, ease: 'easeOut' },
                              }}
                              className="text-xs bg-orange-50 text-orange-700 border border-orange-200 rounded-full px-3 py-1 font-medium"
                            >
                              {skill}
                            </motion.span>
                          );
                        })}
                      </div>
                    </motion.section>
                  )}

                  {/* ── Education ─────────────────────────────────────── */}
                  {(resumeData.education?.length ?? 0) > 0 && (
                    <motion.section variants={sectionVariants}>
                      <SectionHeading>Education</SectionHeading>
                      <div className="space-y-3">
                        {resumeData.education!.map((edu) => {
                          const isFlashing = flashingIds.has(edu.id);
                          return (
                            <motion.div
                              key={edu.id}
                              animate={{
                                boxShadow: isFlashing
                                  ? ['0 0 0 2px rgba(251,146,60,0.6)', '0 0 0 0px rgba(251,146,60,0)']
                                  : '0 0 0 0px rgba(251,146,60,0)',
                              }}
                              transition={{ duration: 1.4, ease: 'easeOut' }}
                              className="flex items-start justify-between gap-4 rounded-lg"
                            >
                              <div>
                                <p className="text-sm font-semibold text-gray-900">
                                  {edu.degree} in {edu.field}
                                </p>
                                <p className="text-xs text-gray-600 mt-0.5">
                                  {edu.institution}
                                  {edu.honours && (
                                    <span className="text-orange-600/80">{' · '}{edu.honours}</span>
                                  )}
                                </p>
                              </div>
                              <p className="text-xs text-gray-500 flex-shrink-0 font-mono">
                                {edu.graduationYear}
                              </p>
                            </motion.div>
                          );
                        })}
                      </div>
                    </motion.section>
                  )}

                  {/* ── HR compliance footer ──────────────────────────── */}
                  {hasContent && (
                    <motion.div
                      variants={sectionVariants}
                      className="pt-4 border-t border-dashed border-gray-200"
                    >
                      <p className="text-[10px] text-gray-400 text-center">
                        ✓ Canadian HR standards · Reverse chronological · No discriminatory fields
                      </p>
                    </motion.div>
                  )}

                </motion.div>
              </div>
            </motion.div>
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

// ── Sub-components ────────────────────────────────────────────────────────────

const SectionHeading: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="flex items-center gap-3 mb-3">
    <h3 className="text-[9px] font-bold uppercase tracking-[0.18em] text-orange-600 whitespace-nowrap">
      {children}
    </h3>
    <div className="flex-1 h-px bg-gray-200" />
  </div>
);

/** Floating ✨ Magic button that appears on section hover (summary, title). */
const SectionMagicButton: React.FC<{ onMagic: () => void }> = ({ onMagic }) => {
  const [loading, setLoading] = useState(false);
  return (
    <motion.button
      className="absolute -top-1 right-0 opacity-0 group-hover/section:opacity-100 flex items-center gap-1 text-[10px] font-medium text-orange-300 hover:text-orange-200 bg-slate-800/90 hover:bg-orange-500/10 border border-orange-500/20 rounded-lg px-2 py-1 transition-colors"
      initial={{ opacity: 0 }}
      whileHover={{ scale: 1.04 }}
      whileTap={{ scale: 0.96 }}
      onClick={async () => {
        setLoading(true);
        await onMagic();
        setLoading(false);
      }}
      title="AI Magic Rewrite"
    >
      {loading
        ? <Loader2 className="w-2.5 h-2.5 animate-spin" />
        : <Sparkles className="w-2.5 h-2.5" />
      }
      Magic
    </motion.button>
  );
};
