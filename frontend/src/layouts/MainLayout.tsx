/**
 * layouts/MainLayout.tsx — Root Application Layout
 * ─────────────────────────────────────────────────────────────────────────────
 * Implements the responsive split-screen / Bottom Sheet layout:
 *
 * DESKTOP  (viewport ≥ 1024px, Tailwind `lg` breakpoint):
 * ┌──────────────────────────────────────────────────────────┐
 * │  TopBar (logo · step progress · auth)                    │
 * ├──────────────────────────┬───────────────────────────────┤
 * │  ChatPanel (40%)         │  DocumentPreview (60%)        │
 * │  · MacMascot             │  · Live resume                │
 * │  · Message list          │  · Paywall overlay on done    │
 * │  · Input bar             │                               │
 * └──────────────────────────┴───────────────────────────────┘
 *
 * MOBILE  (viewport < 1024px):
 * ┌───────────────────────┐
 * │  TopBar               │
 * ├───────────────────────┤
 * │  DocumentPreview      │  ← Full-screen background
 * │  (scrollable)         │
 * └───────────────────────┘
 * ╔═══════════════════════╗
 * ║  [handle]             ║  ← BottomSheet (Framer Motion draggable)
 * ║  ChatPanel            ║  ← Peek by default; drag or tap to open
 * ╚═══════════════════════╝
 *
 * WHY render different trees (not just CSS hide/show)?
 *   On mobile, the BottomSheet is a fixed overlay — it lives in a portal-like
 *   position outside the document flow.  On desktop, ChatPanel is an inline
 *   flex child.  These are structurally different enough that rendering both
 *   and toggling visibility with CSS would be wasteful and harder to reason about.
 *   We use `useIsDesktop()` to conditionally render the right tree.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChatPanel }        from '@/components/chat/ChatPanel';
import { DocumentPreview }  from '@/components/document/DocumentPreview';
import { BottomSheet }      from '@/components/ui/BottomSheet';
import {
  useAppStore,
  selectIsInterviewActive,
  selectStepIndex,
} from '@/store/useAppStore';
import {
  INTERVIEW_STEP_ORDER,
  INTERVIEW_STEP_LABELS,
  type InterviewStep,
} from '@/types';

// ── Breakpoint Hook ───────────────────────────────────────────────────────────

/**
 * Returns true when the viewport is ≥ 1024px (Tailwind `lg`).
 *
 * We use JS rather than CSS because we need to CONDITIONALLY RENDER different
 * component trees — not just toggle visibility.  Rendering both trees and
 * showing/hiding with CSS would mean the BottomSheet is always mounted and
 * consuming event listeners even on desktop.
 *
 * SSR note: if you ever add server-side rendering, replace `window.innerWidth`
 * initialisation with a media query match or a safe default (e.g. `true`).
 */
const useIsDesktop = (): boolean => {
  const [isDesktop, setIsDesktop] = useState(() => window.innerWidth >= 1024);

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');

    // `matchMedia` with a change listener is more efficient than a resize handler
    // because it only fires when you cross the breakpoint, not on every px.
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  return isDesktop;
};

// ── TopBar ────────────────────────────────────────────────────────────────────

/**
 * Persistent header shown on all viewport sizes.
 *
 * Contains:
 *   Left:   Logo wordmark + PRO badge
 *   Center: Interview step progress dots
 *   Right:  Auth button / avatar
 */
const TopBar: React.FC = () => {
  const user              = useAppStore((s) => s.user);
  const isPremium         = useAppStore((s) => s.isPremium);
  const isInterviewActive = useAppStore(selectIsInterviewActive);

  return (
    <header className="flex-shrink-0 h-14 flex items-center justify-between px-4 lg:px-6 border-b border-gray-100 dark:border-gray-800 glass z-20">

      {/* ── Logo ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2.5">
        {/* Icon mark */}
        <div className="w-7 h-7 rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 flex items-center justify-center shadow-brand flex-shrink-0">
          <span className="text-white text-xs font-black tracking-tighter">J</span>
        </div>

        <span className="text-base font-bold text-gray-900 dark:text-gray-100 tracking-tight">
          JobifAI
        </span>

        {isPremium && (
          <motion.span
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            className="text-[10px] font-bold tracking-widest uppercase bg-gradient-to-r from-brand-500 to-brand-700 text-white rounded-full px-2 py-0.5"
          >
            PRO
          </motion.span>
        )}
      </div>

      {/* ── Step progress indicator ───────────────────────────────────────── */}
      <AnimatePresence>
        {isInterviewActive && <StepProgressBar />}
      </AnimatePresence>

      {/* ── Auth ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2">
        {user ? (
          /* Avatar circle with user's initial */
          <motion.div
            className="w-8 h-8 rounded-full bg-gradient-to-br from-brand-100 to-brand-200 flex items-center justify-center cursor-pointer"
            whileTap={{ scale: 0.94 }}
            title={user.email ?? 'My Account'}
          >
            <span className="text-sm font-bold text-brand-700">
              {user.email?.[0]?.toUpperCase() ?? '?'}
            </span>
          </motion.div>
        ) : (
          /* Sign in CTA */
          <button className="text-sm font-semibold text-brand-600 hover:text-brand-700 dark:text-brand-400 transition-colors">
            Sign in
            {/* TODO (Task 3): open Supabase auth modal */}
          </button>
        )}
      </div>
    </header>
  );
};

// ── Step Progress Bar ─────────────────────────────────────────────────────────

/**
 * Horizontal row of animated pills — one per interview step (excluding 'idle').
 *
 * Active steps: wide pill (w-6) in brand colour
 * Future steps: narrow dot (w-2) in gray
 *
 * The spring animation on width change gives it a satisfying "expand" feel
 * as the user progresses through the interview.
 */
const StepProgressBar: React.FC = () => {
  const currentStep = useAppStore((s) => s.currentStep);
  const stepIndex   = useAppStore(selectStepIndex);

  // Exclude 'idle' from the visual indicator
  const visibleSteps = INTERVIEW_STEP_ORDER.filter(
    (s): s is Exclude<InterviewStep, 'idle'> => s !== 'idle',
  );

  // currentIndex relative to visibleSteps (0-based, -1 when idle)
  const activeIdx = visibleSteps.indexOf(currentStep as typeof visibleSteps[number]);

  return (
    <motion.div
      className="flex items-center gap-1.5"
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      title={`Step ${stepIndex} of ${visibleSteps.length}: ${INTERVIEW_STEP_LABELS[currentStep]}`}
      aria-label={`Interview progress: ${INTERVIEW_STEP_LABELS[currentStep]}`}
    >
      {visibleSteps.map((step, i) => {
        const isActive  = i <= activeIdx;
        const isCurrent = i === activeIdx;

        return (
          <motion.div
            key={step}
            className={`h-1.5 rounded-full transition-colors ${
              isActive
                ? 'bg-brand-500'
                : 'bg-gray-200 dark:bg-gray-700'
            }`}
            // Animate between wide (active) and narrow (future) widths
            animate={{ width: isCurrent ? 24 : isActive ? 16 : 6 }}
            transition={{ type: 'spring', stiffness: 320, damping: 28 }}
          />
        );
      })}
    </motion.div>
  );
};

// ── Scrim ─────────────────────────────────────────────────────────────────────

/**
 * Semi-transparent overlay shown behind the open BottomSheet on mobile.
 * Tapping it closes the sheet.
 */
const Scrim: React.FC<{ onDismiss: () => void }> = ({ onDismiss }) => (
  <motion.div
    className="absolute inset-0 bg-black/30 z-20"
    initial={{ opacity: 0 }}
    animate={{ opacity: 1 }}
    exit={{ opacity: 0 }}
    transition={{ duration: 0.2 }}
    onClick={onDismiss}
    aria-hidden="true"
  />
);

// ── Main Layout ───────────────────────────────────────────────────────────────

export const MainLayout: React.FC = () => {
  const isDesktop = useIsDesktop();

  // Bottom Sheet open/close state — only relevant on mobile
  const [isSheetOpen, setIsSheetOpen] = useState(false);

  // Close the sheet when switching to desktop to avoid stale state
  useEffect(() => {
    if (isDesktop) setIsSheetOpen(false);
  }, [isDesktop]);

  return (
    /*
     * h-screen / h-dvh: occupy the full viewport.
     * `overflow-hidden`: prevents the body from scrolling — each panel
     * manages its own internal scroll independently.
     */
    <div className="h-dvh flex flex-col bg-bg dark:bg-bg-dark overflow-hidden">

      <TopBar />

      {isDesktop ? (
        // ── Desktop: Side-by-side split ──────────────────────────────────────
        <div className="flex-1 flex min-h-0 overflow-hidden">

          {/* Left panel: Chat (40% width) */}
          <div
            className="w-2/5 flex-shrink-0 flex flex-col min-h-0 overflow-hidden border-r border-gray-100 dark:border-gray-800"
            aria-label="Chat with Mac"
          >
            <ChatPanel />
          </div>

          {/* Right panel: Document Preview (remaining 60%) */}
          <div
            className="flex-1 flex flex-col min-h-0 overflow-hidden"
            aria-label="Resume preview"
          >
            <DocumentPreview />
          </div>
        </div>

      ) : (
        // ── Mobile: Document behind a draggable Bottom Sheet ────────────────
        <div className="flex-1 relative min-h-0 overflow-hidden">

          {/* Document takes the full background area */}
          <div
            className="absolute inset-0 overflow-y-auto scrollbar-hidden"
            aria-label="Resume preview"
          >
            {/*
              Add bottom padding equal to the Bottom Sheet's peek height so
              the document content doesn't get hidden behind the peeking sheet.
            */}
            <div className="pb-20">
              <DocumentPreview />
            </div>
          </div>

          {/* Scrim — only visible when the sheet is fully open */}
          <AnimatePresence>
            {isSheetOpen && (
              <Scrim onDismiss={() => setIsSheetOpen(false)} />
            )}
          </AnimatePresence>

          {/* Bottom Sheet with ChatPanel inside */}
          <BottomSheet
            isOpen={isSheetOpen}
            onToggle={() => setIsSheetOpen((prev) => !prev)}
          >
            <ChatPanel />
          </BottomSheet>
        </div>
      )}
    </div>
  );
};
