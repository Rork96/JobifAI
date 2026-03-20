/**
 * App.tsx — Root Component & Screen State Machine
 * ─────────────────────────────────────────────────────────────────────────────
 * Manages the top-level "screen" the user is currently on:
 *
 *   onboarding  →  paywall  →  workspace
 *
 * Each transition is animated with Framer Motion.
 *
 * WHY local useState instead of the Zustand store?
 *   Screen-level navigation state is ephemeral and app-instance-specific.
 *   It doesn't need to be serialised, shared cross-component, or DevTools-
 *   inspectable.  A simple useState is the right tool for the job.
 *
 * WHY AnimatePresence here?
 *   We want the outgoing screen to animate OUT before the next one appears.
 *   AnimatePresence detects when a child is removed from the tree and plays
 *   its `exit` animation before unmounting.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { MainLayout }     from '@/layouts/MainLayout';
import { OnboardingFlow } from '@/components/onboarding/OnboardingFlow';
import { PaywallModal }   from '@/components/paywall/PaywallModal';
import { useAuth }        from '@/hooks/useAuth';

// ─── Screen type ──────────────────────────────────────────────────────────────
type Screen = 'onboarding' | 'paywall' | 'workspace';

// ─── Slide transition shared across all screens ───────────────────────────────
const screenVariants = {
  enter: (direction: number) => ({
    x:       direction > 0 ?  '100%' : '-100%',
    opacity: 0,
  }),
  center: {
    x:       0,
    opacity: 1,
  },
  exit: (direction: number) => ({
    x:       direction < 0 ?  '100%' : '-100%',
    opacity: 0,
  }),
};

const screenTransition = {
  type:      'tween' as const,
  ease:      'easeInOut',
  duration:  0.35,
};

// ─── App ──────────────────────────────────────────────────────────────────────
const App: React.FC = () => {
  // Detect Stripe return URL (?checkout=success) and jump straight to workspace.
  // The webhook fires asynchronously — we optimistically show workspace; the
  // is_premium flag will sync on next auth state change / page refresh.
  const checkoutParam = new URLSearchParams(window.location.search).get('checkout');
  const initialScreen: Screen = checkoutParam === 'success' ? 'workspace' : 'onboarding';

  const [screen,    setScreen]    = useState<Screen>(initialScreen);
  const [direction, setDirection] = useState(1); // +1 = forward, -1 = back

  // Clean up the ?checkout= param from the URL so a refresh doesn't re-trigger
  React.useEffect(() => {
    if (checkoutParam) {
      const url = new URL(window.location.href);
      url.searchParams.delete('checkout');
      window.history.replaceState({}, '', url.toString());
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Initialise Supabase auth listener once at the app root.
  // This restores any existing session and keeps the Zustand store in sync.
  const auth = useAuth();

  const goTo = (next: Screen) => {
    const order: Screen[] = ['onboarding', 'paywall', 'workspace'];
    const from = order.indexOf(screen);
    const to   = order.indexOf(next);
    setDirection(to > from ? 1 : -1);
    setScreen(next);
  };

  return (
    // Outer container: full viewport, clip overflow so slides don't show outside
    <div className="fixed inset-0 bg-slate-950 overflow-hidden">
      <AnimatePresence mode="wait" custom={direction}>
        {screen === 'onboarding' && (
          <motion.div
            key="onboarding"
            custom={direction}
            variants={screenVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={screenTransition}
            className="absolute inset-0"
          >
            <OnboardingFlow onComplete={() => goTo('paywall')} />
          </motion.div>
        )}

        {screen === 'paywall' && (
          <motion.div
            key="paywall"
            custom={direction}
            variants={screenVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={screenTransition}
            className="absolute inset-0"
          >
            {/*
             * The workspace renders underneath so the paywall modal floats
             * over a real (blurred) preview of the tool — adds desire.
             */}
            <MainLayout auth={auth} />
            <PaywallModal onAccessGranted={() => goTo('workspace')} />
          </motion.div>
        )}

        {screen === 'workspace' && (
          <motion.div
            key="workspace"
            custom={direction}
            variants={screenVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={screenTransition}
            className="absolute inset-0"
          >
            <MainLayout auth={auth} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default App;
