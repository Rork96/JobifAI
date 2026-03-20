/**
 * components/mascot/MacMascot.tsx — Mac the AI Co-pilot (Animated)
 * ─────────────────────────────────────────────────────────────────────────────
 * Mac is the emotional heart of the product — a Framer Motion character that
 * reacts in real-time to every phase of the interview conversation.
 *
 * FIVE EMOTIONAL STATES (driven by `MascotState` prop from ChatPanel):
 *
 *   idle       — Default resting state.
 *                Slow sinusoidal float (4s), soft purple glow.
 *                Emoji rotates per interview step to keep things fresh.
 *
 *   listening  — Microphone is active, user is speaking.
 *                Sound-wave rings radiate outward like a sonar ping.
 *                Scale pulses slightly (1→1.05→1) — an "attentive" posture.
 *                Gradient shifts toward blue to signal audio capture.
 *
 *   processing — API call fired, waiting for the first SSE token.
 *                Floating thought-bubble appears above Mac's head.
 *                Scale pulse is tighter/faster (1.04, 1.2s) than listening.
 *
 *   talking    — SSE tokens are actively streaming into the chat.
 *                Fast bouncy vertical motion (0.5s) mimics mouth movement.
 *                Sound-bar equaliser badge at the bottom-right.
 *                Gradient shifts toward emerald to signal "output" energy.
 *
 *   warning    — Backend scrubbed a Canadian HR-forbidden field.
 *                One-shot horizontal head-shake (x: ±12px spring).
 *                Gradient shifts to amber/orange — signals a gentle "no".
 *                Auto-resets to previous state after 2 s (managed in ChatPanel).
 *
 * ANIMATION PHILOSOPHY:
 *   • All transitions use `spring` physics so they feel physical, not robotic.
 *   • Keyframe arrays in `animate` + `repeat: Infinity` in `transition` give
 *     continuous looping without re-mounting the component.
 *   • Overlapping layers (glow, shake, float) are separate motion elements so
 *     they compose without interfering with each other.
 *
 * FUTURE UPGRADE PATH:
 *   Replace the gradient circle + emoji with a Spline 3D WebGL scene.
 *   The props API (`currentStep`, `state`, `onClick`) stays identical —
 *   only the internals of this file change.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useEffect } from 'react';
import { motion, AnimatePresence, useAnimation } from 'framer-motion';
import type { InterviewStep, MascotState } from '@/types';

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Per-step emoji expressions — shown inside the mascot circle.
 * When the 3D model ships, these map to animation clip names instead.
 */
const STEP_EXPRESSIONS: Record<InterviewStep, string> = {
  idle:             '😺',  // Relaxed, inviting
  target_title:     '🎯',  // Focused, purposeful
  summary:          '✍️',  // Thoughtful, creative
  experience:       '💼',  // Professional mode on
  skills_education: '🎓',  // In scholar mode
  complete:         '🎉',  // Celebrating their achievement
};

/**
 * Per-state emoji overlays — override the step expression when Mac is reacting.
 * These communicate what Mac is "doing" at the system level, not the step content.
 */
const STATE_EMOJIS: Partial<Record<MascotState, string>> = {
  listening:  '👂',  // Ear cupped — actively receiving audio
  processing: '🤔',  // Thinking face — mid-computation
  warning:    '⚖️',  // Scales of justice — HR compliance
};

/**
 * Tailwind gradient classes per state.
 * ⚠️ Must be full class strings (not interpolated) for Tailwind JIT to include them.
 */
const STATE_GRADIENTS: Record<MascotState, string> = {
  idle:       'from-brand-400 via-brand-500 to-brand-700',
  listening:  'from-brand-400 via-violet-500 to-blue-500',
  processing: 'from-brand-400 via-brand-500 to-brand-700',
  talking:    'from-brand-500 via-emerald-400 to-brand-600',
  warning:    'from-amber-400 via-orange-400 to-orange-500',
};

/**
 * Tailwind glow colours per state (used for the blur ring behind the mascot).
 */
const STATE_GLOW_CLASSES: Record<MascotState, string> = {
  idle:       'bg-brand-500',
  listening:  'bg-blue-500',
  processing: 'bg-brand-500',
  talking:    'bg-emerald-400',
  warning:    'bg-amber-400',
};

// ── Spring presets (stiffness/damping pairs) ──────────────────────────────────
// Consistent physics make the product feel unified.

/** Snappy — used for appear/disappear transitions on badges and overlays. */
const SPRING_SNAPPY = { type: 'spring', stiffness: 400, damping: 28 } as const;

/** Soft — used for state transitions on the main body so they don't jar. */
const SPRING_SOFT   = { type: 'spring', stiffness: 300, damping: 22 } as const;

// ── Props ─────────────────────────────────────────────────────────────────────
interface MacMascotProps {
  /** Current interview step — drives the default emoji expression. */
  currentStep: InterviewStep;
  /**
   * Emotional state — computed in ChatPanel from mic/stream/warning status.
   * This is the primary driver of animation behaviour.
   */
  state: MascotState;
  /** Optional click handler — future: opens help modal or Spline scene. */
  onClick?: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────
export const MacMascot: React.FC<MacMascotProps> = ({ currentStep, state, onClick }) => {

  // The displayed emoji: state-specific override wins, otherwise step-based
  const expression = STATE_EMOJIS[state] ?? STEP_EXPRESSIONS[currentStep];
  const gradient   = STATE_GRADIENTS[state];
  const glowClass  = STATE_GLOW_CLASSES[state];

  // `shakeControls` drives the one-shot horizontal head-shake for `warning`.
  // We use `useAnimation()` so we can imperatively trigger it without
  // changing the `animate` prop (which would interrupt the float layer).
  const shakeControls = useAnimation();

  useEffect(() => {
    if (state === 'warning') {
      // Head-shake: fast alternating x offset, springs back to 0
      shakeControls.start({
        x: [0, -12, 12, -9, 9, -5, 5, 0],
        transition: { duration: 0.55, ease: 'easeInOut' },
      });
    } else {
      // Reset to centre on any other state
      shakeControls.start({ x: 0, transition: SPRING_SOFT });
    }
  }, [state, shakeControls]);

  // ── Body animation variants ────────────────────────────────────────────────
  // Each state gets its own `animate` keyframes + `transition` config.
  // Framer Motion interpolates smoothly between states when they change.
  //
  // ⚠️ No explicit Record<…, object> annotation here — TypeScript infers
  // the precise union of object literal types from the values, which is
  // assignable to Framer Motion's `animate` prop.  Adding `: object` would
  // widen to the base `object` type which is NOT assignable to TargetAndTransition.

  const bodyAnimate = {
    idle:       { y: [0, -8, 0],           scale: 1 },
    listening:  { y: [0, -4, 0],           scale: [1, 1.05, 1] },
    processing: { y: 0,                    scale: [1, 1.04, 1] },
    // Faster bob on both up AND slightly down to mimic speech cadence
    talking:    { y: [0, -6, 0, -3, 0],    scale: 1 },
    warning:    { y: 0,                     scale: 1 },
  };

  const bodyTransition = {
    idle: {
      y:     { repeat: Infinity, duration: 4,   ease: 'easeInOut' },
    },
    listening: {
      // Both y and scale loop independently — scale is the "attentive pulse"
      y:     { repeat: Infinity, duration: 2,   ease: 'easeInOut' },
      scale: { repeat: Infinity, duration: 1.5, ease: 'easeInOut' },
    },
    processing: {
      scale: { repeat: Infinity, duration: 1.2, ease: 'easeInOut' },
    },
    talking: {
      // Short period = rapid speech-like bounce
      y:     { repeat: Infinity, duration: 0.5, ease: 'easeInOut' },
    },
    warning: {},
  };

  // ── Glow animation ────────────────────────────────────────────────────────
  // Glow intensity and speed vary by state to reinforce what's happening.

  const glowAnimate = {
    idle:       { scale: 1,            opacity: [0.20, 0.28, 0.20] },
    listening:  { scale: [1, 1.3, 1],  opacity: [0.30, 0.50, 0.30] },
    processing: { scale: [1, 1.3, 1],  opacity: [0.25, 0.45, 0.25] },
    talking:    { scale: [1, 1.2, 1],  opacity: [0.25, 0.40, 0.25] },
    warning:    { scale: 1,            opacity: 0.40 },
  };

  const glowTransition = {
    idle:       { repeat: Infinity, duration: 3,   ease: 'easeInOut' },
    listening:  { repeat: Infinity, duration: 1.4, ease: 'easeInOut' },
    processing: { repeat: Infinity, duration: 1.2, ease: 'easeInOut' },
    talking:    { repeat: Infinity, duration: 0.6, ease: 'easeInOut' },
    warning:    {},
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col items-center gap-2.5 select-none">

      {/* ── Main body ──────────────────────────────────────────────────── */}
      {/*
        Three-layer composition:
          Layer 1: Glow ring (blur blob behind the circle)
          Layer 2: State-specific decorations (rings, bubbles, bars)
          Layer 3: Mascot circle (float + scale animations)
          Layer 4: Badge overlays (bottom-right corner)
        The shake is applied to the outermost wrapper so it shakes everything.
      */}
      <motion.div
        // ── Shake layer (applied to whole mascot, one-shot on warning) ──
        animate={shakeControls}
        className="relative"
      >

        {/* ── LAYER 1: Ambient glow ────────────────────────────────────── */}
        {/*
          This blur-XL blob sits behind the circle and shifts colour with
          the gradient.  Opacity + scale animate per state to reinforce
          the current activity level.
        */}
        <motion.div
          className={`absolute inset-0 rounded-full blur-xl ${glowClass}`}
          animate={glowAnimate[state]}
          transition={glowTransition[state]}
        />

        {/* ── LAYER 2a: LISTENING — Sound-wave rings ───────────────────── */}
        {/*
          Three concentric rings expand and fade outward like a sonar ping.
          Staggered delays give the impression of continuous audio waves.
        */}
        <AnimatePresence>
          {state === 'listening' && [0, 1, 2].map((i) => (
            <motion.div
              key={`wave-${i}`}
              className="absolute inset-0 rounded-full border-2 border-blue-400/50"
              initial={{ scale: 1, opacity: 0.7 }}
              animate={{ scale: 1 + (i + 1) * 0.35, opacity: 0 }}
              exit={{ opacity: 0 }}
              transition={{
                repeat: Infinity,
                duration: 1.6,
                delay: i * 0.45,
                ease: 'easeOut',
              }}
            />
          ))}
        </AnimatePresence>

        {/* ── LAYER 2b: PROCESSING — Spin ring ────────────────────────── */}
        {/*
          A single slowly-rotating dashed ring signals "computing".
          Combined with the scale pulse on the body it feels like the
          system is actively working.
        */}
        <AnimatePresence>
          {state === 'processing' && (
            <motion.div
              key="spin-ring"
              className="absolute inset-0 rounded-full border-2 border-dashed border-brand-400/60"
              initial={{ opacity: 0, rotate: 0 }}
              animate={{ opacity: 1, rotate: 360 }}
              exit={{ opacity: 0 }}
              transition={{
                opacity:  { duration: 0.3 },
                rotate:   { repeat: Infinity, duration: 2.5, ease: 'linear' },
              }}
            />
          )}
        </AnimatePresence>

        {/* ── LAYER 3: Mascot circle ───────────────────────────────────── */}
        <motion.button
          onClick={onClick}
          // Float + scale driven by current state
          animate={bodyAnimate[state]}
          transition={bodyTransition[state]}
          // Micro-interactions — spring physics blend with the ongoing animation
          whileHover={{ scale: 1.08, transition: SPRING_SNAPPY }}
          whileTap={{ scale: 0.93, transition: SPRING_SNAPPY }}
          className={[
            'relative w-24 h-24 rounded-full',
            // Gradient is swapped per state via a full class string
            `bg-gradient-to-br ${gradient}`,
            'flex items-center justify-center',
            'shadow-brand cursor-pointer',
            'outline-none focus-visible:ring-4 focus-visible:ring-brand-400/50',
            // Smooth gradient colour transitions
            'transition-[background] duration-700',
          ].join(' ')}
          aria-label={`Mac the AI co-pilot — ${state}`}
        >

          {/* Expression emoji — springs in/out on change */}
          <AnimatePresence mode="wait">
            <motion.span
              // Changing key triggers exit → enter spring animation.
              // Key includes both state + expression so warning swaps the emoji
              // AND so the step expression swaps when the step advances.
              key={`${state}-${expression}`}
              className="text-4xl"
              role="img"
              aria-label={`Mac is ${state}`}
              initial={{ scale: 0.4, opacity: 0 }}
              animate={{ scale: 1,   opacity: 1 }}
              exit={{   scale: 0.4, opacity: 0 }}
              transition={SPRING_SNAPPY}
            >
              {expression}
            </motion.span>
          </AnimatePresence>

        </motion.button>

        {/* ── LAYER 4a: PROCESSING — Thought bubble ───────────────────── */}
        {/*
          Floats above Mac's head to reinforce "thinking".
          Small scale-spring on appear so it feels like it "pops" into view.
        */}
        <AnimatePresence>
          {state === 'processing' && (
            <motion.div
              key="thought-bubble"
              className="absolute -top-9 right-0 bg-white dark:bg-gray-800 rounded-2xl px-2.5 py-1.5 shadow-lg flex items-center gap-1"
              initial={{ opacity: 0, scale: 0.6, y: 6 }}
              animate={{ opacity: 1, scale: 1,   y: 0 }}
              exit={{   opacity: 0, scale: 0.6, y: 6 }}
              transition={SPRING_SNAPPY}
            >
              {[0, 1, 2].map((i) => (
                <motion.span
                  key={i}
                  className="w-1.5 h-1.5 rounded-full bg-brand-400 inline-block"
                  animate={{ opacity: [0.3, 1, 0.3], y: [0, -2, 0] }}
                  transition={{ repeat: Infinity, duration: 0.8, delay: i * 0.2 }}
                />
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── LAYER 4b: TALKING — Sound bar equaliser ─────────────────── */}
        {/*
          Five vertical bars of different heights animate up/down
          like an audio level display — unmistakably "speaking".
        */}
        <AnimatePresence>
          {state === 'talking' && (
            <motion.div
              key="eq-badge"
              className="absolute -bottom-1.5 -right-1.5 bg-white dark:bg-gray-800 rounded-full px-2 py-1.5 shadow-md flex items-end gap-[3px]"
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{   opacity: 0, scale: 0.6 }}
              transition={SPRING_SNAPPY}
            >
              {/* Heights represent a static "default" level; scaleY animates them */}
              {[0.55, 1, 0.7, 0.9, 0.5].map((h, i) => (
                <motion.div
                  key={i}
                  className="w-[3px] bg-emerald-500 rounded-full"
                  // scaleY from 0.4 to 1 creates the bouncing equaliser bars
                  animate={{ scaleY: [h, 1, h * 0.65, h] }}
                  transition={{
                    repeat:   Infinity,
                    duration: 0.55,
                    delay:    i * 0.09,
                    ease:     'easeInOut',
                  }}
                  style={{ height: 12, transformOrigin: 'bottom' }}
                />
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── LAYER 4c: LISTENING — Mic badge ──────────────────────────── */}
        {/*
          A red pulsing dot on the top-right corner — the universal "recording" signal.
        */}
        <AnimatePresence>
          {state === 'listening' && (
            <motion.div
              key="mic-badge"
              className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 rounded-full shadow-md flex items-center justify-center"
              initial={{ opacity: 0, scale: 0 }}
              animate={{ opacity: 1, scale: [1, 1.3, 1] }}
              exit={{   opacity: 0, scale: 0 }}
              transition={{
                opacity:  { duration: 0.2 },
                scale:    { repeat: Infinity, duration: 1, ease: 'easeInOut' },
              }}
              aria-label="Recording"
            />
          )}
        </AnimatePresence>

        {/* ── LAYER 4d: WARNING — HR label ────────────────────────────── */}
        <AnimatePresence>
          {state === 'warning' && (
            <motion.div
              key="hr-badge"
              className="absolute -bottom-1 -right-2 bg-amber-50 dark:bg-amber-900/50 border border-amber-200 dark:border-amber-700 rounded-full px-2 py-0.5 shadow-sm flex items-center gap-1"
              initial={{ opacity: 0, scale: 0.7, y: 4 }}
              animate={{ opacity: 1, scale: 1,   y: 0 }}
              exit={{   opacity: 0, scale: 0.7, y: 4 }}
              transition={SPRING_SNAPPY}
            >
              <span className="text-[9px] font-bold text-amber-700 dark:text-amber-400 uppercase tracking-wide whitespace-nowrap">
                HR ✓
              </span>
            </motion.div>
          )}
        </AnimatePresence>

      </motion.div>{/* end shake wrapper */}

      {/* ── Name badge ──────────────────────────────────────────────────── */}
      <motion.div
        className="flex items-center gap-1.5"
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
      >
        <span className="text-sm font-semibold text-gray-700 dark:text-gray-300">Mac</span>
        <span className="text-xs text-gray-400 dark:text-gray-500">· AI Co-pilot</span>

        {/* Live status dot — colour shifts per state */}
        <motion.span
          className={[
            'w-1.5 h-1.5 rounded-full inline-block',
            state === 'listening'  ? 'bg-blue-400' :
            state === 'warning'    ? 'bg-amber-400' :
            state === 'talking'    ? 'bg-emerald-400' :
                                     'bg-green-400',
          ].join(' ')}
          // Blink rate speeds up when active
          animate={{ opacity: [1, 0.4, 1] }}
          transition={{
            repeat:   Infinity,
            duration: state === 'idle' ? 2 : 0.8,
          }}
        />

        {/* State label — appears/disappears based on active state */}
        <AnimatePresence mode="wait">
          {state !== 'idle' && (
            <motion.span
              key={state}
              className={[
                'text-[10px] font-medium',
                state === 'listening'  ? 'text-blue-500' :
                state === 'processing' ? 'text-brand-500' :
                state === 'talking'    ? 'text-emerald-600' :
                state === 'warning'    ? 'text-amber-600' :
                                         'text-gray-400',
              ].join(' ')}
              initial={{ opacity: 0, x: -4 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{   opacity: 0, x: -4 }}
              transition={{ duration: 0.15 }}
            >
              {state === 'listening'  && 'Listening…'}
              {state === 'processing' && 'Thinking…'}
              {state === 'talking'    && 'Speaking…'}
              {state === 'warning'    && 'HR check'}
            </motion.span>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
};
