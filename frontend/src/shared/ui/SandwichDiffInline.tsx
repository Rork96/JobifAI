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
 * Phase 8: added `loading` prop — when true, renders a pulsing skeleton while
 * waiting for the POST /api/rewrite-section response. The parent mounts this
 * component as soon as the user clicks a bullet, so the UI reacts immediately.
 *
 * Usage:
 *   <AnimatePresence>
 *     {(isTargeted || isImproving) && (
 *       <SandwichDiffInline
 *         diff={isTargeted ? pendingDiff : null}
 *         loading={isImproving}
 *         onAccept={handleAccept}
 *         onReject={handleReject}
 *       />
 *     )}
 *   </AnimatePresence>
 */

import { motion } from 'framer-motion';
import type { PendingDiff } from '@/store/useDocumentStore';

interface SandwichDiffInlineProps {
  /** The AI suggestion to display. Null while loading. */
  diff:      PendingDiff | null;
  /** True while waiting for the API response — renders skeleton instead of diff */
  loading?:  boolean;
  onAccept:  () => void;
  onReject:  () => void;
}

export default function SandwichDiffInline({
  diff,
  loading = false,
  onAccept,
  onReject,
}: SandwichDiffInlineProps) {
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

          {/* Header row — shown in both loading and loaded states */}
          <div className="flex items-center justify-between gap-3 mb-2.5">
            <span className="text-xs font-bold text-green-700 uppercase tracking-wide">
              {loading ? '🤖 AI is thinking…' : '✨ AI Suggestion'}
            </span>
            {!loading && diff && (
              <span className="flex-shrink-0 text-xs font-bold text-green-700
                               bg-green-100 border border-green-200
                               px-2.5 py-0.5 rounded-full">
                +{diff.scoreImpact} ATS pts
              </span>
            )}
            {loading && (
              /* Skeleton chip */
              <div className="h-5 w-20 rounded-full bg-green-200/70 animate-pulse" />
            )}
          </div>

          {/* Content: skeleton while loading, real text when ready */}
          {loading ? (
            <div className="space-y-2">
              <div className="h-3.5 rounded bg-green-200/70 animate-pulse w-full" />
              <div className="h-3.5 rounded bg-green-200/70 animate-pulse w-5/6" />
              <div className="h-3.5 rounded bg-green-200/70 animate-pulse w-3/4" />
            </div>
          ) : (
            diff && (
              <p className="text-sm text-slate-800 leading-relaxed">
                {diff.proposedText}
              </p>
            )
          )}

          {/* Accept / Reject — disabled while loading */}
          <div className="flex items-center gap-2 mt-3">
            <button
              onClick={onAccept}
              disabled={loading || !diff}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg
                         bg-green-600 hover:bg-green-700 active:scale-[0.97]
                         text-white text-xs font-bold transition-colors
                         disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100"
            >
              ✓ Accept
            </button>
            <button
              onClick={onReject}
              disabled={loading && !diff}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg
                         bg-white hover:bg-slate-50 active:scale-[0.97]
                         text-slate-600 text-xs font-bold
                         border border-slate-200 transition-colors
                         disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100"
            >
              ✗ {loading ? 'Cancel' : 'Reject'}
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
