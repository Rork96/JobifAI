/**
 * components/paywall/PremiumWrapper.tsx — ATS Keyword Carousel + Premium Blur Gate
 * ─────────────────────────────────────────────────────────────────────────────
 * RESPONSIBILITIES (this component only):
 *   • Render a horizontally scrollable chip carousel of ATS keywords.
 *   • Show the top FREE_TIER_LIMIT chips clearly for all users.
 *   • Blur chips beyond FREE_TIER_LIMIT when !isUnlocked.
 *   • Gate blurred chips behind onPaywallClick().
 *   • Append an "Unlock all X keywords" CTA chip at carousel end.
 *   • Show a right-edge gradient fade when more chips exist off-screen.
 *
 * NON-RESPONSIBILITIES (kept out deliberately):
 *   • Store access  — zero Zustand imports.  All data comes through props.
 *   • Business logic — does not compute keywords, scores, or categories.
 *   • Paywall UI    — only fires onPaywallClick(); the overlay is the
 *                     caller's concern (DocumentPreview manages the modal).
 *
 * This is the "V" in MVC for the keyword checklist.  DocumentPreview is
 * the controller that computes `keywords` and `impactMap` and passes them in.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React from 'react';
import { motion } from 'framer-motion';

// ── Free-Tier Constant ────────────────────────────────────────────────────────
/**
 * Number of keywords shown clearly to free users.
 * Everything beyond index FREE_TIER_LIMIT - 1 is blurred.
 * Exported so DocumentPreview can use it for the SkillGapChecklist header copy.
 */
export const FREE_TIER_LIMIT = 4;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Deterministic impact % badge value for chips that lack a backend score.
 * Range 3–7 — chosen to look credible without being misleading.
 * Uses a simple char-code sum so the same keyword always shows the same %.
 */
function getChipImpact(keyword: string): number {
  let hash = 0;
  for (let i = 0; i < keyword.length; i++) hash += keyword.charCodeAt(i);
  return (hash % 5) + 3;
}

// ── Props ─────────────────────────────────────────────────────────────────────
export interface PremiumWrapperProps {
  /**
   * The ordered keyword list to display.
   * Callers are responsible for ordering by importance (highest-impact first)
   * since the blur gate hides everything beyond FREE_TIER_LIMIT.
   */
  keywords: string[];

  /**
   * Impact score map: keyword.toLowerCase() → percentage point improvement.
   * Falls back to getChipImpact() for any keyword not in the map.
   * Optional — legacy callers that don't have impact data can omit it.
   */
  impactMap?: Map<string, number>;

  /**
   * True when the user has an active premium subscription or a BYOK key.
   * When true, ALL chips are visible and clickable — no blur gate.
   */
  isUnlocked: boolean;

  /**
   * Called when a visible (unlocked) keyword chip is clicked.
   * The caller (DocumentPreview) routes this to the ghost-keyword coaching flow.
   */
  onKeywordClick: (keyword: string) => void;

  /**
   * Called when a blurred (locked) chip or the "Unlock all X keywords" CTA
   * is clicked.  The caller shows its paywall overlay/modal in response.
   */
  onPaywallClick: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────
export const PremiumWrapper: React.FC<PremiumWrapperProps> = ({
  keywords,
  impactMap,
  isUnlocked,
  onKeywordClick,
  onPaywallClick,
}) => {
  if (keywords.length === 0) return null;

  // Locked CTA chip is shown when there are keywords beyond FREE_TIER_LIMIT
  // that the user cannot see clearly.
  const hasLockedContent = !isUnlocked && keywords.length > FREE_TIER_LIMIT;

  return (
    <div className="relative">

      {/* ── Scrollable chip row ─────────────────────────────────────────────── */}
      <div className="flex gap-1.5 overflow-x-auto scrollbar-hidden pb-1 pr-2">

        {keywords.map((keyword, idx) => {
          const isLocked = !isUnlocked && idx >= FREE_TIER_LIMIT;
          const impact   = impactMap?.get(keyword.toLowerCase()) ?? getChipImpact(keyword);

          return (
            <motion.button
              key={keyword}
              onClick={() => isLocked ? onPaywallClick() : onKeywordClick(keyword)}
              className={[
                // Base chip layout
                'flex-shrink-0 flex items-center gap-1.5',
                'text-[11px] font-medium rounded-full px-2.5 py-1',
                'transition-colors',
                // Locked vs unlocked visual treatment
                isLocked
                  ? [
                      'blur-sm select-none cursor-pointer',
                      'text-orange-700 bg-orange-50',
                      'border border-orange-300',
                    ].join(' ')
                  : [
                      'cursor-pointer',
                      'text-orange-700 bg-orange-50',
                      'border border-orange-300',
                      'hover:bg-orange-100 hover:border-orange-400',
                    ].join(' '),
              ].join(' ')}
              // No micro-interaction on locked chips — avoids tactile "it worked"
              whileHover={isLocked ? {} : { scale: 1.04 }}
              whileTap={isLocked  ? {} : { scale: 0.96 }}
              title={
                isLocked
                  ? 'Unlock Premium to coach this keyword'
                  : `Click to add "${keyword}" to your resume`
              }
              aria-label={isLocked ? `Locked keyword: ${keyword}` : `Coach ${keyword}`}
            >
              {/* Leading indicator: lock icon for gated chips, checkbox for visible */}
              {isLocked
                ? <span className="text-orange-400 text-[10px] leading-none">🔒</span>
                : <span className="w-3 h-3 rounded border border-orange-400 flex-shrink-0" />
              }

              {keyword}

              <span className="text-orange-500 font-semibold">
                +{impact}%
              </span>
            </motion.button>
          );
        })}

        {/* ── "Unlock all X keywords → 100% Match" CTA ────────────────────── */}
        {/*
          Appended at the end of the scrollable row so the user discovers it
          by scrolling — feels like a natural continuation, not an intrusion.
          Hidden when user is already unlocked (they see all chips).
        */}
        {hasLockedContent && (
          <motion.button
            onClick={onPaywallClick}
            className={[
              'flex-shrink-0 flex items-center gap-1.5',
              'text-[11px] font-semibold text-white whitespace-nowrap',
              'bg-gradient-to-r from-orange-500 to-amber-500',
              'hover:from-orange-600 hover:to-amber-600',
              'rounded-full px-3 py-1',
              'shadow-sm transition-all cursor-pointer',
            ].join(' ')}
            whileHover={{ scale: 1.04 }}
            whileTap={{ scale: 0.96 }}
            aria-label={`Unlock all ${keywords.length} keywords to reach 100% ATS match`}
          >
            🔓 Unlock all {keywords.length} keywords → 100% Match
          </motion.button>
        )}

      </div>

      {/* ── Right-edge gradient ──────────────────────────────────────────────── */}
      {/*
        A white → transparent gradient fade on the right edge signals to the user
        that there are more chips to scroll to.  Only shown when locked content
        exists — unlocked users see all chips and don't need the hint.
      */}
      {hasLockedContent && (
        <div
          className="absolute right-0 top-0 bottom-1 w-10 bg-gradient-to-l from-white to-transparent pointer-events-none"
          aria-hidden="true"
        />
      )}

    </div>
  );
};
