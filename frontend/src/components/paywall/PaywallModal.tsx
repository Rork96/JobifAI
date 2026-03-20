/**
 * PaywallModal.tsx — The Anchored Price Gate
 * ─────────────────────────────────────────────────────────────────────────────
 * Renders after onboarding Step 3 (the ATS score shock), before the user
 * enters the workspace.  Price anchoring strategy:
 *
 *   1. Show "Pro ($14.99/month)" first — the anchor sets perceived value high.
 *   2. "24-Hour Pass ($4.99)" appears cheaper by comparison.
 *   3. "Start my 1 Free Trial" is the safety-net CTA for the hesitant.
 *
 * BYOK Easter Egg:
 *   Clicking the modal title 3× within 1.5 seconds opens BYOKModal.
 *   Target audience: developers / power users who already have a Gemini key.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useCallback, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { BYOKModal } from './BYOKModal';

// ─── Props ────────────────────────────────────────────────────────────────────
interface PaywallModalProps {
  /** Called when the user gains access (trial, purchase, or BYOK). */
  onAccessGranted: () => void;
}

// ─── Plan Card ────────────────────────────────────────────────────────────────
interface PlanCardProps {
  badge?:       string;
  title:        string;
  price:        string;
  period:       string;
  features:     string[];
  cta:          string;
  isPrimary:    boolean;
  onSelect:     () => void;
}

const PlanCard: React.FC<PlanCardProps> = ({
  badge, title, price, period, features, cta, isPrimary, onSelect,
}) => (
  <motion.div
    whileHover={{ scale: 1.02, y: -2 }}
    whileTap={{ scale: 0.98 }}
    onClick={onSelect}
    className={[
      'relative cursor-pointer rounded-2xl p-6 border transition-all duration-200',
      isPrimary
        ? 'bg-gradient-to-b from-orange-500/20 to-orange-600/10 border-orange-500/50 shadow-lg shadow-orange-500/10'
        : 'bg-slate-800/70 border-slate-700/60 hover:border-slate-600',
    ].join(' ')}
  >
    {badge && (
      <span className="absolute -top-3 left-1/2 -translate-x-1/2 bg-orange-500 text-white text-xs font-semibold px-3 py-1 rounded-full shadow-md">
        {badge}
      </span>
    )}

    <div className="mb-4">
      <p className="text-slate-400 text-sm font-medium mb-1">{title}</p>
      <div className="flex items-baseline gap-1">
        <span className={`text-4xl font-bold ${isPrimary ? 'text-orange-400' : 'text-white'}`}>
          {price}
        </span>
        <span className="text-slate-400 text-sm">{period}</span>
      </div>
    </div>

    <ul className="space-y-2 mb-6">
      {features.map((f) => (
        <li key={f} className="flex items-start gap-2 text-sm text-slate-300">
          <svg className="w-4 h-4 text-orange-400 mt-0.5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
          </svg>
          {f}
        </li>
      ))}
    </ul>

    <button
      type="button"
      className={[
        'w-full py-3 rounded-xl font-semibold text-sm transition-all duration-150',
        isPrimary
          ? 'bg-orange-500 hover:bg-orange-400 text-white shadow-md shadow-orange-500/30'
          : 'bg-slate-700 hover:bg-slate-600 text-white',
      ].join(' ')}
    >
      {cta}
    </button>
  </motion.div>
);

// ─── Component ────────────────────────────────────────────────────────────────
export const PaywallModal: React.FC<PaywallModalProps> = ({ onAccessGranted }) => {
  const [showBYOK, setShowBYOK] = useState(false);

  // ── Triple-click easter egg ──────────────────────────────────────────────────
  const clickCountRef  = useRef(0);
  const clickTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleTitleClick = useCallback(() => {
    clickCountRef.current += 1;

    // Reset counter after 1.5 seconds of inactivity
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
    clickTimerRef.current = setTimeout(() => {
      clickCountRef.current = 0;
    }, 1500);

    if (clickCountRef.current >= 3) {
      clickCountRef.current = 0;
      if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
      setShowBYOK(true);
    }
  }, []);

  // ── Plan data ────────────────────────────────────────────────────────────────
  const plans = [
    {
      badge:    'Most Popular',
      title:    'Pro Plan',
      price:    '$14.99',
      period:   '/ month',
      isPrimary: true,
      features: [
        'Unlimited ATS-optimised resumes',
        'Gemini AI interview (all sections)',
        'PDF export + cover letter',
        'Real-time ATS score tracker',
        'Priority support',
      ],
      cta: 'Go Pro — $14.99/month',
    },
    {
      badge:    undefined,
      title:    '24-Hour Pass',
      price:    '$4.99',
      period:   '/ 24 h',
      isPrimary: false,
      features: [
        '1 ATS-optimised resume',
        'Full AI interview session',
        'PDF export',
        'ATS score snapshot',
      ],
      cta: 'Get 24-Hour Access',
    },
  ];

  return (
    <>
      {/* ── Backdrop ──────────────────────────────────────────────────────────── */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="fixed inset-0 z-50 bg-slate-950/90 backdrop-blur-sm flex items-center justify-center px-4"
      >
        {/* ── Panel ───────────────────────────────────────────────────────────── */}
        <motion.div
          initial={{ opacity: 0, y: 32, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ type: 'spring', stiffness: 300, damping: 28, delay: 0.1 }}
          className="w-full max-w-2xl bg-slate-900 rounded-3xl border border-slate-700/60 shadow-2xl overflow-hidden"
        >
          {/* ── Header ────────────────────────────────────────────────────────── */}
          <div className="px-8 pt-8 pb-6 text-center border-b border-slate-800">
            {/* ATS score pill */}
            <div className="inline-flex items-center gap-2 bg-red-500/15 border border-red-500/30 rounded-full px-4 py-1.5 mb-5">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              <span className="text-red-400 text-xs font-semibold tracking-wide uppercase">
                ATS Score: 34 / 100 — Below hiring threshold
              </span>
            </div>

            {/* Clickable title — easter egg trigger */}
            <button
              type="button"
              onClick={handleTitleClick}
              className="block w-full text-3xl font-bold text-white mb-2 select-none cursor-default focus:outline-none"
              tabIndex={-1}
              aria-label="JobifAI — upgrade"
            >
              Beat the ATS. Land the interview.
            </button>

            <p className="text-slate-400 text-sm max-w-sm mx-auto">
              Your resume needs work. Let JobifAI's AI co-pilot rebuild it to pass ATS filters
              and reach real hiring managers.
            </p>
          </div>

          {/* ── Pricing cards ────────────────────────────────────────────────── */}
          <div className="px-8 py-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
            {plans.map((plan) => (
              <PlanCard
                key={plan.title}
                {...plan}
                onSelect={onAccessGranted}
              />
            ))}
          </div>

          {/* ── Free trial safety net ─────────────────────────────────────────── */}
          <div className="px-8 pb-8 text-center">
            <div className="h-px bg-slate-800 mb-6" />
            <button
              type="button"
              onClick={onAccessGranted}
              className="text-slate-400 hover:text-orange-400 text-sm font-medium transition-colors duration-150 underline underline-offset-4 decoration-dotted"
            >
              Start my 1 Free Trial — no credit card required
            </button>
            <p className="text-slate-600 text-xs mt-2">
              1 resume · ATS score only · No PDF export
            </p>
          </div>
        </motion.div>
      </motion.div>

      {/* ── BYOK Easter Egg Modal ─────────────────────────────────────────────── */}
      <AnimatePresence>
        {showBYOK && (
          <BYOKModal
            onClose={() => setShowBYOK(false)}
            onAccessGranted={onAccessGranted}
          />
        )}
      </AnimatePresence>
    </>
  );
};
