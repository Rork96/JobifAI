/**
 * BottomSheet — PRD §4 Sandwich UI Protocol — Coach Panel
 * FSD location: shared/ui/BottomSheet.tsx
 *
 * A permanently-docked panel at the bottom of WorkspacePage.
 * It is NOT a modal or a floating box — it lives in the normal document
 * flow as the last child of the page's flex-col container, always visible.
 *
 * Two heights (animated by Framer Motion):
 *   Collapsed (PEEK_H): drag-handle + MacMascot + "Mac Says" + ATS score
 *   Expanded  (OPEN_H): + Missing/Matched keyword chips + diff status
 *
 * Drag-handle tap toggles between the two states.
 * The MacMascot is always visible in the peek strip — it drives the state
 * machine (idle → processing → success → warning) based on live store state.
 *
 * PRD §4 mandate: "No sidebars. No modals. No separate tabs."
 */

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import MacMascot, { type MacState } from '@/shared/ui/MacMascot';
import type { PendingDiff } from '@/store/useDocumentStore';

// ── Layout constants ──────────────────────────────────────────────────────────

/** Height of the always-visible peek strip (handle + mascot row). */
const PEEK_H = 76;

/** Full height when expanded. */
const OPEN_H = 320;

// ── Types ─────────────────────────────────────────────────────────────────────

interface BottomSheetProps {
  macState:      MacState;
  macSays:       string;
  atsScore:      number | null;
  /** Set when an AI suggestion is waiting for Accept/Reject. */
  diff:          PendingDiff | null;
  missingSkills: string[];
  matchedSkills: string[];
  /** Legacy gap strings from older ATS analysis — used if missingSkills is empty. */
  atsGaps:       string[];
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function BottomSheet({
  macState,
  macSays,
  atsScore,
  diff,
  missingSkills,
  matchedSkills,
  atsGaps,
}: BottomSheetProps) {
  const [isOpen, setIsOpen] = useState(false);

  // Normalise keyword lists: prefer structured missingSkills, fall back to atsGaps
  const displayMissing: string[] =
    missingSkills.length > 0
      ? missingSkills.slice(0, 8)
      : atsGaps
          .map(g => {
            const m = g.match(/["']([^"']+)["']/);
            return m ? m[1] : g;
          })
          .filter(Boolean)
          .slice(0, 8);

  const expandedContentH = OPEN_H - PEEK_H;

  return (
    <motion.div
      className="w-full bg-white border-t border-slate-200 shadow-[0_-4px_24px_rgba(0,0,0,0.07)] overflow-hidden flex-shrink-0"
      animate={{ height: isOpen ? OPEN_H : PEEK_H }}
      initial={false}
      transition={{ type: 'spring', damping: 30, stiffness: 300 }}
    >
      {/* ── Drag handle ─────────────────────────────────────────────────────── */}
      <div className="flex justify-center pt-2.5 pb-1">
        <button
          onClick={() => setIsOpen(o => !o)}
          aria-label={isOpen ? 'Collapse coach panel' : 'Expand coach panel'}
          className="group flex flex-col items-center gap-0.5 px-4 py-0.5"
        >
          <div className="w-8 h-1 rounded-full bg-slate-300 group-hover:bg-slate-400 transition-colors" />
          <span className="text-[9px] font-bold text-slate-400 uppercase tracking-widest leading-none">
            {isOpen ? '▼ close' : '▲ coach'}
          </span>
        </button>
      </div>

      {/* ── Peek row — always visible ────────────────────────────────────────── */}
      {/*
        h-[46px]: mascot 40px + 3px padding each side.
        flex items-center so everything is vertically centred.
        The mascot is always visible here as the permanent UI resident (PRD §2.7).
      */}
      <div className="flex items-center gap-3 px-4 h-[46px]">

        {/* MacMascot — always present, state-driven */}
        <MacMascot state={macState} size={40} />

        {/* Mac Says copy */}
        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wide leading-none mb-0.5">
            Mac Says
          </p>
          <p className="text-sm text-slate-700 leading-snug line-clamp-1">{macSays}</p>
        </div>

        {/* ATS score badge — always visible in peek */}
        {atsScore !== null && (
          <div className="flex-shrink-0 text-right">
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wide leading-none mb-0.5">
              ATS
            </p>
            <p className={`text-lg font-black tabular-nums leading-none ${
              atsScore >= 70 ? 'text-green-600' :
              atsScore >= 40 ? 'text-amber-600' :
              'text-red-600'
            }`}>
              {atsScore}
              <span className="text-xs font-normal text-slate-300">/100</span>
            </p>
          </div>
        )}
      </div>

      {/* ── Expanded content ─────────────────────────────────────────────────── */}
      {/*
        overflow-y-auto + fixed height so content scrolls if keywords are many.
        AnimatePresence fades in/out to avoid flicker during height animation.
      */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            key="expanded"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { delay: 0.08 } }}
            exit={{ opacity: 0, transition: { duration: 0.1 } }}
            className="overflow-y-auto px-4 pb-4"
            style={{ height: expandedContentH }}
          >

            {/* Pending diff chip */}
            {diff && (
              <div className="mb-3 pt-2">
                <span className="inline-flex items-center gap-1.5 text-xs font-bold
                                 text-green-700 bg-green-50 border border-green-200
                                 px-3 py-1.5 rounded-full">
                  ✨ +{diff.scoreImpact} ATS pts ready — accept or reject the suggestion above ↑
                </span>
              </div>
            )}

            {/* Separator */}
            <div className="my-2 h-px bg-slate-100" />

            {/* Missing keywords */}
            {displayMissing.length > 0 ? (
              <div className="mb-4">
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">
                  Missing Keywords
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {displayMissing.map(kw => (
                    <span
                      key={kw}
                      className="text-xs font-semibold text-red-600 bg-red-50
                                 border border-red-200 px-2 py-0.5 rounded-full"
                    >
                      – {kw}
                    </span>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-xs text-slate-400 mb-3">
                No keyword gaps detected — great match!
              </p>
            )}

            {/* Matched keywords */}
            {matchedSkills.length > 0 && (
              <div>
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">
                  Matched
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {matchedSkills.slice(0, 10).map(kw => (
                    <span
                      key={kw}
                      className="text-xs font-semibold text-green-700 bg-green-50
                                 border border-green-200 px-2 py-0.5 rounded-full"
                    >
                      ✓ {kw}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Prompt to run analysis when no keywords at all */}
            {displayMissing.length === 0 && matchedSkills.length === 0 && !diff && (
              <p className="text-xs text-slate-400 text-center py-2">
                Run an ATS analysis from the Dashboard to unlock keyword gap coaching.
              </p>
            )}

          </motion.div>
        )}
      </AnimatePresence>

    </motion.div>
  );
}
