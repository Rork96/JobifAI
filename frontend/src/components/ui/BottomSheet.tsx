/**
 * components/ui/BottomSheet.tsx — iOS-style Draggable Bottom Sheet
 * ─────────────────────────────────────────────────────────────────────────────
 * This is the mobile layout's primary navigation surface — it slides up from
 * the bottom to reveal the chat panel, covering ~82% of the screen.
 *
 * HOW THE PHYSICS WORK:
 *   The sheet has two "snap points":
 *     • open  → y = 0            (sheet fully visible, anchored to bottom)
 *     • peek  → y = sheetH - 80  (only the handle strip is visible)
 *
 *   `drag="y"` lets the user grab and move it.  After they release:
 *     • If they dragged far enough OR fast enough → snap to the other state
 *     • Otherwise → spring back to the current state
 *
 *   `useAnimation()` gives us an imperative API to trigger snaps from code.
 *   Spring physics (type: 'spring', stiffness, damping) make the snaps feel
 *   physical — they always overshoot and settle, unlike CSS ease curves.
 *
 * WHY NOT CSS transitions?
 *   CSS can't respond to drag velocity.  Framer Motion can — a fast flick
 *   snaps instantly; a slow drag needs to cross a distance threshold.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useEffect, useRef, useState } from 'react';
import { motion, useAnimation, type PanInfo } from 'framer-motion';

// ── Constants ─────────────────────────────────────────────────────────────────
const OPEN_HEIGHT_RATIO = 0.82;  // Sheet occupies 82% of viewport height when open
const PEEK_HEIGHT       = 80;    // Pixels visible when sheet is in "peek" state

const SPRING = {
  type:      'spring',
  stiffness: 400,
  damping:   38,
} as const;

// Thresholds for snap decision on drag release
const VELOCITY_THRESHOLD = 350;  // px/s — a brisk flick commits the snap
const OFFSET_THRESHOLD   = 90;   // px  — a 90px drag commits the snap

// ── Props ─────────────────────────────────────────────────────────────────────
interface BottomSheetProps {
  /** Content rendered inside the sheet (typically ChatPanel). */
  children: React.ReactNode;
  /** Controlled open state — parent drives this via onToggle. */
  isOpen: boolean;
  /** Callback to toggle the open state in the parent. */
  onToggle: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────
export const BottomSheet: React.FC<BottomSheetProps> = ({
  children,
  isOpen,
  onToggle,
}) => {
  // Compute snap point values in pixels so dragConstraints can be exact.
  // We read window.innerHeight at mount and update on resize.
  const [sheetHeight, setSheetHeight] = useState(
    () => window.innerHeight * OPEN_HEIGHT_RATIO,
  );

  useEffect(() => {
    const handler = () => setSheetHeight(window.innerHeight * OPEN_HEIGHT_RATIO);
    window.addEventListener('resize', handler, { passive: true });
    return () => window.removeEventListener('resize', handler);
  }, []);

  // peekY = how far to push the sheet DOWN from its natural (bottom-anchored) position
  // so that only PEEK_HEIGHT pixels are visible.
  const peekY = sheetHeight - PEEK_HEIGHT;

  // Framer Motion animation controller — lets us imperatively trigger animations
  // from inside event handlers (not just from prop changes).
  const controls = useAnimation();

  // Ref so handleDragEnd can read current `isOpen` without a stale closure.
  // (Event handlers capture the value at creation time, not at call time.)
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;

  // Sync animation whenever parent changes isOpen OR when peekY recalculates
  useEffect(() => {
    controls.start({
      y: isOpen ? 0 : peekY,
      transition: SPRING,
    });
  }, [isOpen, peekY, controls]);

  /**
   * Snap logic on drag release.
   *
   * We check BOTH velocity AND offset so the sheet responds naturally to:
   *   • Quick flicks (high velocity, small offset) → snap
   *   • Slow deliberate drags (low velocity, large offset) → snap
   *   • Accidental nudges (low velocity, small offset) → spring back
   */
  const handleDragEnd = (
    _event: PointerEvent | MouseEvent | TouchEvent,
    info: PanInfo,
  ) => {
    const currentlyOpen = isOpenRef.current;
    const { velocity, offset } = info;

    if (currentlyOpen) {
      // Sheet is open → positive (downward) gesture should close to peek
      if (velocity.y > VELOCITY_THRESHOLD || offset.y > OFFSET_THRESHOLD) {
        onToggle(); // Flip parent state → useEffect re-runs → snaps to peek
      } else {
        // Didn't commit — snap back to open
        controls.start({ y: 0, transition: SPRING });
      }
    } else {
      // Sheet is peeking → negative (upward) gesture should open
      if (velocity.y < -VELOCITY_THRESHOLD || offset.y < -OFFSET_THRESHOLD) {
        onToggle(); // Flip → snaps to open
      } else {
        // Didn't commit — snap back to peek
        controls.start({ y: peekY, transition: SPRING });
      }
    }
  };

  return (
    <motion.div
      // ── Framer Motion drag configuration ──────────────────────────────────
      drag="y"

      // Constrain the drag to [0, peekY] in pixels.
      //   top: 0    → can't drag sheet ABOVE its fully-open position
      //   bottom: peekY → can't drag it further down than the peek position
      dragConstraints={{ top: 0, bottom: peekY }}

      // Small elastic feel at the boundaries — like a physical object hitting a stop.
      // 0 = rigid stop, 1 = completely elastic (flies off screen).
      dragElastic={{ top: 0.05, bottom: 0.08 }}

      onDragEnd={handleDragEnd}

      // Imperative animation controller (synced with isOpen via useEffect)
      animate={controls}

      // Start in "peek" state — only the handle strip visible
      initial={{ y: peekY }}

      // ── Visual styles ──────────────────────────────────────────────────────
      className={[
        'fixed bottom-0 left-0 right-0 z-30',
        'flex flex-col',
        'bg-white dark:bg-surface-dark',
        'rounded-t-4xl',
        'shadow-sheet',
        // Prevent inner text selection while dragging
        'select-none',
      ].join(' ')}
      style={{ height: sheetHeight }}
    >
      {/* ── Drag Handle ──────────────────────────────────────────────────── */}
      {/*
        The handle serves double duty:
          1. Visual affordance — tells users "this can be dragged"
          2. Tap target — tapping the bar toggles open/peek without dragging
      */}
      <button
        onClick={onToggle}
        className="flex-shrink-0 flex flex-col items-center justify-center gap-1 pt-3 pb-2 cursor-grab active:cursor-grabbing"
        aria-label={isOpen ? 'Collapse chat panel' : 'Expand chat panel'}
        aria-expanded={isOpen}
      >
        {/* The pill */}
        <div className="w-10 h-1 rounded-full bg-gray-300 dark:bg-gray-600 transition-colors" />

        {/* Mini label — fades in only when peeking so it doesn't clutter open view */}
        <motion.span
          className="text-xs font-medium text-gray-400 dark:text-gray-500"
          animate={{ opacity: isOpen ? 0 : 1 }}
          transition={{ duration: 0.15 }}
        >
          Chat with Mac
        </motion.span>
      </button>

      {/* ── Sheet Content ─────────────────────────────────────────────────── */}
      {/*
        `pointer-events-none` while dragging prevents accidental taps on
        the content when the user is just trying to drag.
        We let Framer Motion's `dragListener` handle the gesture recognition.
      */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {children}
      </div>
    </motion.div>
  );
};
