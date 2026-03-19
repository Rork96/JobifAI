/**
 * components/mascot/MacMascot.tsx — Mac the AI Cat (Placeholder)
 * ─────────────────────────────────────────────────────────────────────────────
 * This is the placeholder implementation.  In Task 4, this gets replaced with
 * a 3D animated cat (Spline or Three.js) that reacts in real-time to the
 * interview state.  The API surface (props) stays the same — just the
 * internals change.
 *
 * CURRENT IMPLEMENTATION:
 *   A gradient circle with spring-physics animations via Framer Motion.
 *   The expression emoji changes per interview step so the UI still feels alive.
 *
 * ANIMATION NOTES:
 *   • Float: sinusoidal vertical bob (easeInOut, 4s period) — calm, breathing
 *   • Thinking: gentle pulse scale (1→1.04→1) — suggests active processing
 *   • Step transition: the emoji swaps with a quick spring scale pop
 *   • Hover: subtle scale-up (1.08) — makes the mascot feel interactive
 *
 * WHY Framer Motion's `spring` instead of CSS keyframes?
 *   Spring physics adapt to interruption — if you hover while the float
 *   animation is mid-cycle, the hover scale blends in seamlessly rather than
 *   jumping.  CSS keyframes can't do this.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { InterviewStep } from '@/types';

// ── Step → Expression mapping ─────────────────────────────────────────────────
/**
 * Each emoji is chosen to match the emotional tone of the interview step.
 * When the 3D model arrives, these states will map to animation clips instead.
 */
const STEP_EXPRESSIONS: Record<InterviewStep, string> = {
  idle:             '😺',   // Relaxed, welcoming
  target_title:     '🎯',   // Focused, purposeful
  summary:          '✍️',   // Thoughtful, creative
  experience:       '💼',   // Professional
  skills_education: '🎓',   // Knowledgeable
  complete:         '🎉',   // Celebratory
};

// ── Props ─────────────────────────────────────────────────────────────────────
interface MacMascotProps {
  currentStep: InterviewStep;
  /** True while the AI is generating — triggers the "thinking" pulse. */
  isThinking: boolean;
  /** Optional click handler (e.g. open help modal). */
  onClick?: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────
export const MacMascot: React.FC<MacMascotProps> = ({
  currentStep,
  isThinking,
  onClick,
}) => {
  const expression = STEP_EXPRESSIONS[currentStep];

  return (
    <div className="flex flex-col items-center gap-2.5 select-none">

      {/* ── Main body ──────────────────────────────────────────────────────── */}
      <div className="relative">

        {/* Ambient glow ring — pulses when Mac is thinking */}
        <motion.div
          className="absolute inset-0 rounded-full bg-brand-500 blur-xl opacity-30"
          animate={isThinking
            ? { scale: [1, 1.4, 1], opacity: [0.3, 0.5, 0.3] }
            : { scale: 1,   opacity: 0.25 }
          }
          transition={{ repeat: Infinity, duration: 1.6, ease: 'easeInOut' }}
        />

        {/* Thinking pulse ring — concentric circle that expands outward */}
        {isThinking && (
          <motion.div
            className="absolute inset-0 rounded-full border-2 border-brand-400"
            initial={{ scale: 1, opacity: 0.8 }}
            animate={{ scale: 1.8, opacity: 0 }}
            transition={{ repeat: Infinity, duration: 1.2, ease: 'easeOut' }}
          />
        )}

        {/* The mascot circle — floats vertically when idle */}
        <motion.button
          onClick={onClick}
          className={[
            'relative w-24 h-24 rounded-full',
            'bg-gradient-to-br from-brand-400 via-brand-500 to-brand-700',
            'flex items-center justify-center',
            'shadow-brand cursor-pointer',
            'outline-none focus-visible:ring-4 focus-visible:ring-brand-400/50',
          ].join(' ')}
          // Continuous floating — independent of the thinking state
          animate={{ y: [0, -10, 0] }}
          transition={{
            y: { repeat: Infinity, duration: 4, ease: 'easeInOut' },
          }}
          // Micro-interactions
          whileHover={{ scale: 1.08, transition: { type: 'spring', stiffness: 400, damping: 20 } }}
          whileTap={{ scale: 0.94 }}
          aria-label={`Mac the AI co-pilot — step: ${currentStep}`}
        >
          {/* Expression emoji — animates on step change */}
          <AnimatePresence mode="wait">
            <motion.span
              key={expression}  // Changing key triggers exit → enter animation
              className="text-4xl"
              role="img"
              aria-label="Mac expression"
              initial={{ scale: 0.5, opacity: 0 }}
              animate={{ scale: 1,   opacity: 1 }}
              exit={{   scale: 0.5, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 500, damping: 25 }}
            >
              {expression}
            </motion.span>
          </AnimatePresence>
        </motion.button>

        {/* Thinking indicator dots — appear bottom-right when generating */}
        <AnimatePresence>
          {isThinking && (
            <motion.div
              className="absolute -bottom-1 -right-1 bg-white dark:bg-gray-800 rounded-full px-2 py-1 shadow-md flex gap-1 items-center"
              initial={{ opacity: 0, scale: 0.7, y: 4 }}
              animate={{ opacity: 1, scale: 1,   y: 0 }}
              exit={{   opacity: 0, scale: 0.7, y: 4 }}
              transition={{ type: 'spring', stiffness: 400, damping: 25 }}
            >
              {/* Three dots with staggered pulse */}
              {[0, 1, 2].map((i) => (
                <motion.span
                  key={i}
                  className="w-1.5 h-1.5 rounded-full bg-brand-500 inline-block"
                  animate={{ opacity: [0.25, 1, 0.25], y: [0, -2, 0] }}
                  transition={{
                    repeat:   Infinity,
                    duration: 0.9,
                    delay:    i * 0.18,
                    ease:     'easeInOut',
                  }}
                />
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Name badge */}
      <motion.div
        className="flex items-center gap-1.5"
        // Subtle fade in on mount
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
      >
        <span className="text-sm font-semibold text-gray-700 dark:text-gray-300">Mac</span>
        <span className="text-xs text-gray-400 dark:text-gray-500">· AI Co-pilot</span>

        {/* Live indicator dot */}
        <motion.span
          className="w-1.5 h-1.5 rounded-full bg-green-400 inline-block"
          animate={{ opacity: [1, 0.4, 1] }}
          transition={{ repeat: Infinity, duration: 2 }}
        />
      </motion.div>
    </div>
  );
};
