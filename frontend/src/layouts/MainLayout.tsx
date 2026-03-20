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

import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { LogOut, Mail, X } from 'lucide-react';
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

// ── Auth prop shape (from useAuth hook in App.tsx) ─────────────────────────────
interface AuthActions {
  signInWithEmail:  (email: string) => Promise<string | null>;
  signInWithGoogle: () => Promise<void>;
  signOut:          () => Promise<void>;
}

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
 *   Right:  Auth button / avatar (with sign-in modal + sign-out)
 */
const TopBar: React.FC<{ auth: AuthActions }> = ({ auth }) => {
  const user              = useAppStore((s) => s.user);
  const isPremium         = useAppStore((s) => s.isPremium);
  const isInterviewActive = useAppStore(selectIsInterviewActive);

  // ── Sign-in modal state ──────────────────────────────────────────────────
  const [showAuthModal,  setShowAuthModal]  = useState(false);
  const [showUserMenu,   setShowUserMenu]   = useState(false);
  const [emailInput,     setEmailInput]     = useState('');
  const [linkSent,       setLinkSent]       = useState(false);
  const [authError,      setAuthError]      = useState('');
  const [isSending,      setIsSending]      = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  // Auto-focus email input when modal opens
  useEffect(() => {
    if (showAuthModal) {
      setEmailInput('');
      setLinkSent(false);
      setAuthError('');
      setTimeout(() => emailRef.current?.focus(), 80);
    }
  }, [showAuthModal]);

  const handleMagicLink = async () => {
    if (!emailInput.trim()) return;
    setIsSending(true);
    setAuthError('');
    const err = await auth.signInWithEmail(emailInput.trim());
    if (err) {
      setAuthError(err);
    } else {
      setLinkSent(true);
    }
    setIsSending(false);
  };

  return (
    <>
      <header className="flex-shrink-0 h-14 flex items-center justify-between px-4 lg:px-6 border-b border-gray-100 dark:border-gray-800 glass z-20">

        {/* ── Logo ─────────────────────────────────────────────────────── */}
        <div className="flex items-center gap-2.5">
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

        {/* ── Step progress indicator ──────────────────────────────────── */}
        <AnimatePresence>
          {isInterviewActive && <StepProgressBar />}
        </AnimatePresence>

        {/* ── Auth area ────────────────────────────────────────────────── */}
        <div className="relative flex items-center gap-2">
          {user ? (
            /* ── Signed-in: avatar → dropdown menu ─────────────────── */
            <div className="relative">
              <motion.button
                className="w-8 h-8 rounded-full bg-gradient-to-br from-brand-100 to-brand-200 flex items-center justify-center cursor-pointer"
                whileTap={{ scale: 0.94 }}
                onClick={() => setShowUserMenu((v) => !v)}
                title={user.email ?? 'My Account'}
              >
                <span className="text-sm font-bold text-brand-700">
                  {user.email?.[0]?.toUpperCase() ?? '?'}
                </span>
              </motion.button>

              <AnimatePresence>
                {showUserMenu && (
                  <motion.div
                    initial={{ opacity: 0, y: -6, scale: 0.96 }}
                    animate={{ opacity: 1, y: 0,  scale: 1    }}
                    exit={{    opacity: 0, y: -6, scale: 0.96 }}
                    transition={{ type: 'spring', stiffness: 400, damping: 28 }}
                    className="absolute right-0 top-10 w-52 bg-slate-800 border border-slate-700/60 rounded-2xl shadow-xl shadow-black/30 overflow-hidden z-50"
                  >
                    <div className="px-4 py-3 border-b border-slate-700/50">
                      <p className="text-xs text-slate-400 truncate">{user.email}</p>
                      {isPremium && (
                        <span className="text-[10px] font-bold uppercase tracking-widest text-brand-400">
                          PRO
                        </span>
                      )}
                    </div>
                    <button
                      onClick={async () => {
                        setShowUserMenu(false);
                        await auth.signOut();
                      }}
                      className="w-full flex items-center gap-3 px-4 py-3 text-sm text-slate-300 hover:text-white hover:bg-slate-700/50 transition-colors"
                    >
                      <LogOut className="w-4 h-4 text-slate-400" />
                      Sign out
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          ) : (
            /* ── Signed-out: Sign in button ─────────────────────────── */
            <button
              onClick={() => setShowAuthModal(true)}
              className="text-sm font-semibold text-brand-600 hover:text-brand-700 dark:text-brand-400 transition-colors"
            >
              Sign in
            </button>
          )}
        </div>
      </header>

      {/* ── Auth Modal ───────────────────────────────────────────────────────
          Frosted-glass dialog with two sign-in options:
            1. Magic Link (email OTP) — no password required
            2. Continue with Google (OAuth)

          Design note: we use a frosted overlay + centered card rather than a
          BottomSheet because auth is a high-stakes action — a centered,
          full-focus dialog reduces error rate and looks more trustworthy.
      ─────────────────────────────────────────────────────────────────────── */}
      <AnimatePresence>
        {showAuthModal && (
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{    opacity: 0 }}
            onClick={(e) => { if (e.target === e.currentTarget) setShowAuthModal(false); }}
          >
            {/* Backdrop */}
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

            {/* Card */}
            <motion.div
              className="relative w-full max-w-sm bg-slate-900 border border-slate-700/60 rounded-3xl shadow-2xl shadow-black/40 overflow-hidden"
              initial={{ scale: 0.95, y: 16 }}
              animate={{ scale: 1,    y: 0  }}
              exit={{    scale: 0.95, y: 16 }}
              transition={{ type: 'spring', stiffness: 320, damping: 28 }}
            >
              {/* Gradient header */}
              <div className="bg-gradient-to-br from-brand-900/60 to-slate-900 px-6 pt-6 pb-5">
                <button
                  onClick={() => setShowAuthModal(false)}
                  className="absolute top-4 right-4 text-slate-500 hover:text-slate-300 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
                <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-brand-500 to-brand-700 flex items-center justify-center mb-3 shadow-brand">
                  <span className="text-white font-black text-sm">J</span>
                </div>
                <h2 className="text-lg font-bold text-white">Save your resume</h2>
                <p className="text-sm text-slate-400 mt-0.5">
                  Sign in to unlock PDF export and access your resume from anywhere.
                </p>
              </div>

              <div className="px-6 pb-6 pt-4 flex flex-col gap-3">
                {!linkSent ? (
                  <>
                    {/* Google OAuth button */}
                    <button
                      onClick={async () => {
                        setShowAuthModal(false);
                        await auth.signInWithGoogle();
                      }}
                      className="w-full flex items-center justify-center gap-2.5 bg-white hover:bg-gray-50 text-slate-800 font-semibold text-sm py-3 rounded-xl transition-colors shadow-sm"
                    >
                      {/* Google "G" icon */}
                      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                        <path d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615Z" fill="#4285F4"/>
                        <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18Z" fill="#34A853"/>
                        <path d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332Z" fill="#FBBC05"/>
                        <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58Z" fill="#EA4335"/>
                      </svg>
                      Continue with Google
                    </button>

                    {/* Divider */}
                    <div className="flex items-center gap-3">
                      <div className="flex-1 h-px bg-slate-700/60" />
                      <span className="text-xs text-slate-500">or email</span>
                      <div className="flex-1 h-px bg-slate-700/60" />
                    </div>

                    {/* Magic Link form */}
                    <div className="flex flex-col gap-2">
                      <div className="relative">
                        <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 pointer-events-none" />
                        <input
                          ref={emailRef}
                          type="email"
                          value={emailInput}
                          onChange={(e) => { setEmailInput(e.target.value); setAuthError(''); }}
                          onKeyDown={(e) => { if (e.key === 'Enter') handleMagicLink(); }}
                          placeholder="you@example.com"
                          className="w-full bg-slate-800 border border-slate-700 rounded-xl pl-9 pr-3 py-3 text-sm text-slate-100 placeholder:text-slate-500 outline-none focus:border-brand-500/60 transition-colors"
                        />
                      </div>

                      {authError && (
                        <p className="text-xs text-red-400 px-1">{authError}</p>
                      )}

                      <button
                        onClick={handleMagicLink}
                        disabled={isSending || !emailInput.trim()}
                        className="w-full bg-gradient-to-r from-brand-600 to-brand-700 hover:from-brand-500 hover:to-brand-600 disabled:from-slate-700 disabled:to-slate-700 disabled:text-slate-500 text-white font-semibold text-sm py-3 rounded-xl transition-all"
                      >
                        {isSending ? 'Sending…' : 'Send Magic Link →'}
                      </button>
                    </div>

                    <p className="text-center text-xs text-slate-500 mt-1">
                      No password needed. One-click sign in from your inbox.
                    </p>
                  </>
                ) : (
                  /* ── Link sent confirmation ────────────────────────────── */
                  <motion.div
                    initial={{ opacity: 0, scale: 0.96 }}
                    animate={{ opacity: 1, scale: 1    }}
                    className="text-center py-4 flex flex-col items-center gap-3"
                  >
                    <div className="w-14 h-14 rounded-full bg-emerald-500/15 flex items-center justify-center">
                      <Mail className="w-7 h-7 text-emerald-400" />
                    </div>
                    <div>
                      <p className="font-semibold text-white">Check your inbox!</p>
                      <p className="text-sm text-slate-400 mt-1">
                        We sent a magic link to <span className="text-slate-200 font-medium">{emailInput}</span>.
                        Click it to sign in — no password needed.
                      </p>
                    </div>
                    <button
                      onClick={() => setLinkSent(false)}
                      className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
                    >
                      Use a different email
                    </button>
                  </motion.div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
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

export const MainLayout: React.FC<{ auth: AuthActions }> = ({ auth }) => {
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

      <TopBar auth={auth} />

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
