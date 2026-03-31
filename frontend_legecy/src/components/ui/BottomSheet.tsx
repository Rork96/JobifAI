/**
 * components/ui/BottomSheet.tsx — iOS-style Draggable Bottom Sheet (3-Snap)
 * ─────────────────────────────────────────────────────────────────────────────
 * Three snap points (driven by the proportion of viewport height visible):
 *
 *   Snap 0 — 20% visible  ("Peek" — only Mac mascot strip + handle)
 *   Snap 1 — 50% visible  ("Half"  — half the chat, comfortable scroll)
 *   Snap 2 — 80% visible  ("Full"  — full chat experience)
 *
 * SNAP SELECTION ALGORITHM:
 *   On drag release, we look at velocity AND current Y position:
 *   • Velocity > threshold → snap to the adjacent point in the drag direction
 *   • Otherwise           → snap to the nearest point by distance
 *
 * HANDLE BEHAVIOUR:
 *   Tapping the handle cycles upward through snap levels (0 → 1 → 2 → 0).
 *   This lets the user open the sheet without needing to drag.
 *
 * PARENT API (unchanged from the 2-snap version — backward compatible):
 *   `onOpenChange(isOpen: boolean)` is called whenever the snap level crosses
 *   the 50% threshold (snap 0 = closed, snap 1/2 = open).  The parent uses
 *   this to show/hide the Scrim overlay.
 *
 * Haptic: `navigator.vibrate([50])` fires when the sheet is fully opened
 * (snap 2) to signal "panel open" to mobile users.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion, useAnimation, type PanInfo } from 'framer-motion';

// ── Constants ─────────────────────────────────────────────────────────────────

const SPRING = {
  type:      'spring',
  stiffness: 380,
  damping:   36,
} as const;

const VELOCITY_THRESHOLD = 300; // px/s — a brisk flick snaps to adjacent point

// ── Props ─────────────────────────────────────────────────────────────────────
interface BottomSheetProps {
  /** Content rendered inside the sheet (typically ChatPanel). */
  children: React.ReactNode;
  /**
   * Called whenever the open state changes across the 50% threshold.
   * true  → snap 1 or 2 (50%+ visible)
   * false → snap 0 (20% visible / peek)
   */
  onOpenChange?: (isOpen: boolean) => void;
}

// ── Component ─────────────────────────────────────────────────────────────────
export const BottomSheet = React.forwardRef<{ snapTo: (level: 0 | 1 | 2) => void }, BottomSheetProps>(
  ({ children, onOpenChange }, ref) => {

  // ── Snap geometry ──────────────────────────────────────────────────────────
  // All snap positions are expressed as Y offsets from the fully-open position
  // (y=0 means the sheet shows its full `sheetHeight`).
  //
  // sheetHeight = 80% of viewport (the tallest the sheet can grow)
  // y0 = 0                           → shows 80% of viewport (Snap 2: Full)
  // y1 = sheetHeight − vh×0.50       → shows 50% of viewport (Snap 1: Half)
  // y2 = sheetHeight − vh×0.20       → shows 20% of viewport (Snap 0: Peek)

  const [vh, setVh] = useState(() => window.innerHeight);

  useEffect(() => {
    const handler = () => setVh(window.innerHeight);
    window.addEventListener('resize', handler, { passive: true });
    return () => window.removeEventListener('resize', handler);
  }, []);

  const sheetHeight = vh * 0.80;

  // Snap Y positions (distance to push sheet DOWN from its natural top edge)
  const snapY = {
    2: 0,                            // Full  — 80% visible
    1: sheetHeight - vh * 0.50,      // Half  — 50% visible
    0: sheetHeight - vh * 0.20,      // Peek  — 20% visible
  } as const;

  // ── State ─────────────────────────────────────────────────────────────────
  const [snapLevel, setSnapLevel] = useState<0 | 1 | 2>(0);
  const snapLevelRef = useRef<0 | 1 | 2>(0);
  const controls = useAnimation();

  // Keep ref in sync (event handlers need the current value without re-creating)
  snapLevelRef.current = snapLevel;

  // ── Animate to snap position ───────────────────────────────────────────────
  const animateTo = useCallback((level: 0 | 1 | 2) => {
    controls.start({ y: snapY[level], transition: SPRING });
    setSnapLevel(level);
    onOpenChange?.(level >= 1);

    if (level === 2) {
      // Haptic: "panel fully open"
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        navigator.vibrate([50]);
      }
    }
  }, [controls, snapY, onOpenChange]);

  // Re-animate when geometry changes (viewport resize)
  useEffect(() => {
    controls.start({ y: snapY[snapLevelRef.current], transition: SPRING });
  }, [vh]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Expose imperative API via forwardRef
  React.useImperativeHandle(ref, () => ({
    snapTo: (level: 0 | 1 | 2) => animateTo(level),
  }), [animateTo]);

  // ── Drag end — snap to nearest point with velocity bias ───────────────────
  const handleDragEnd = useCallback((_e: PointerEvent | MouseEvent | TouchEvent, info: PanInfo) => {
    const { velocity, offset } = info;
    const current = snapLevelRef.current;

    let target: 0 | 1 | 2;

    if (velocity.y < -VELOCITY_THRESHOLD) {
      // Fast upward flick → go one level higher
      target = Math.min(2, current + 1) as 0 | 1 | 2;
    } else if (velocity.y > VELOCITY_THRESHOLD) {
      // Fast downward flick → go one level lower
      target = Math.max(0, current - 1) as 0 | 1 | 2;
    } else {
      // No clear velocity — pick nearest snap by Y position
      // Current Y = snapY[current] + drag offset
      const currentY = snapY[current] + offset.y;
      const distances = ([0, 1, 2] as const).map((lvl) => ({
        level: lvl,
        dist:  Math.abs(snapY[lvl] - currentY),
      }));
      distances.sort((a, b) => a.dist - b.dist);
      target = distances[0].level;
    }

    animateTo(target);
  }, [animateTo, snapY]);

  // ── Handle tap — cycle upward (0→1→2→0) ──────────────────────────────────
  const handleHandleTap = useCallback(() => {
    const next = ((snapLevelRef.current + 1) % 3) as 0 | 1 | 2;
    animateTo(next);
  }, [animateTo]);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <motion.div
      drag="y"
      dragConstraints={{ top: 0, bottom: snapY[0] }}
      dragElastic={{ top: 0.04, bottom: 0.06 }}
      onDragEnd={handleDragEnd}
      animate={controls}
      initial={{ y: snapY[0] }}
      className={[
        'fixed bottom-0 left-0 right-0 z-30',
        'flex flex-col',
        'bg-white dark:bg-surface-dark',
        'rounded-t-4xl',
        'shadow-sheet',
        'select-none',
      ].join(' ')}
      style={{ height: sheetHeight }}
    >
      {/* ── Drag Handle ──────────────────────────────────────────────────── */}
      <button
        onClick={handleHandleTap}
        className="flex-shrink-0 flex flex-col items-center justify-center gap-1 pt-3 pb-2 cursor-grab active:cursor-grabbing"
        aria-label={
          snapLevel === 0 ? 'Expand chat panel'
          : snapLevel === 1 ? 'Expand to full chat'
          : 'Minimise chat panel'
        }
        aria-expanded={snapLevel > 0}
      >
        {/* Pill — gets slightly wider as the sheet opens */}
        <motion.div
          className="h-1 rounded-full bg-gray-300 dark:bg-gray-600 transition-colors"
          animate={{ width: snapLevel === 2 ? 48 : snapLevel === 1 ? 36 : 28 }}
          transition={SPRING}
        />

        {/* Label — only visible at peek (snap 0) */}
        <motion.span
          className="text-xs font-medium text-gray-400 dark:text-gray-500"
          animate={{ opacity: snapLevel === 0 ? 1 : 0, height: snapLevel === 0 ? 'auto' : 0 }}
          transition={{ duration: 0.15 }}
        >
          Chat with Mac
        </motion.span>
      </button>

      {/* ── Sheet Content ─────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {children}
      </div>
    </motion.div>
  );
});

BottomSheet.displayName = 'BottomSheet';
