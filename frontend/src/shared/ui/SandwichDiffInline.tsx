/**
 * SandwichDiffInline — PRD §4.1 Core Pattern
 * FSD location: shared/ui/SandwichDiffInline.tsx
 *
 * Renders INLINE directly below a targeted bullet point. Three visual layers:
 *   Top    — proposed AI text + score impact chip + Accept/Reject buttons
 *   Middle — the original targeted bullet is highlighted amber (rendered by parent)
 *   Bottom — all other resume content dimmed by parent (opacity-40)
 *
 * PRD §4.1 mandate: "No sidebars. No modals. No separate tabs. Reject at code review."
 *
 * Usage:
 *   <AnimatePresence>
 *     {isTargeted && pendingDiff && (
 *       <SandwichDiffInline
 *         diff={pendingDiff}
 *         onAccept={handleAccept}
 *         onReject={handleReject}
 *       />
 *     )}
 *   </AnimatePresence>
 */

import { motion } from 'framer-motion';
import type { PendingDiff } from '@/store/useDocumentStore';

interface SandwichDiffInlineProps {
  diff: PendingDiff;
  onAccept: () => void;
  onReject: () => void;
}

export default function SandwichDiffInline({ diff, onAccept, onReject }: SandwichDiffInlineProps) {
  return (
    <motion.div
      initial={{ opacity: 0, height: 0, marginTop: 0 }}
      animate={{ opacity: 1, height: 'auto', marginTop: 6 }}
      exit={{ opacity: 0, height: 0, marginTop: 0 }}
      transition={{ duration: 0.22, ease: 'easeOut' }}
      className="overflow-hidden"
    >
      <div className="ml-5 rounded-xl border border-green-200 bg-green-50 shadow-sm overflow-hidden">
        <div className="p-3 sm:p-4">

          {/* Header: label + score impact chip */}
          <div className="flex items-center justify-between gap-3 mb-2.5">
            <span className="text-xs font-bold text-green-700 uppercase tracking-wide">
              ✨ AI Suggestion
            </span>
            <span className="flex-shrink-0 text-xs font-bold text-green-700
                             bg-green-100 border border-green-200
                             px-2.5 py-0.5 rounded-full">
              +{diff.scoreImpact} ATS pts
            </span>
          </div>

          {/* Proposed text */}
          <p className="text-sm text-slate-800 leading-relaxed">
            {diff.proposedText}
          </p>

          {/* Accept / Reject */}
          <div className="flex items-center gap-2 mt-3">
            <button
              onClick={onAccept}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg
                         bg-green-600 hover:bg-green-700 active:scale-[0.97]
                         text-white text-xs font-bold transition-colors"
            >
              ✓ Accept
            </button>
            <button
              onClick={onReject}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg
                         bg-white hover:bg-slate-50 active:scale-[0.97]
                         text-slate-600 text-xs font-bold
                         border border-slate-200 transition-colors"
            >
              ✗ Reject
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
