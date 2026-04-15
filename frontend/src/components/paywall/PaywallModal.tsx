/**
 * PaywallModal.tsx — Premium Price Gate (Phase 13 — warm parchment/terracotta palette)
 * ─────────────────────────────────────────────────────────────────────────────
 * Renders after the ATS score shock.  Price anchoring strategy:
 *   1. Pro ($14.99/mo) — anchor sets perceived value high.
 *   2. 24-Hour Pass ($4.99) — appears cheaper by comparison.
 *   3. "1 Free Trial" — safety net for the hesitant.
 *
 * BYOK Easter Egg: triple-click the title within 1.5 s → BYOKModal.
 *
 * Design: dark warm surfaces (#141210 base) + terracotta CTA (#c96442).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { BYOKModal } from './BYOKModal';
import { useAppStore } from '@/store/useAppStore';
import { useBillingStore } from '@/store/useBillingStore';
import { useState } from 'react';

// ─── Props ────────────────────────────────────────────────────────────────────
interface PaywallModalProps {
  onAccessGranted: () => void;
}

// ─── Plan Card ────────────────────────────────────────────────────────────────
interface PlanCardProps {
  badge?:        string;
  title:         string;
  price:         string;
  period:        string;
  features:      string[];
  cta:           string;
  isPrimary:     boolean;
  isCheckingOut: boolean;
  onSelect:      () => void;
}

const PlanCard: React.FC<PlanCardProps> = ({
  badge, title, price, period, features, cta, isPrimary, isCheckingOut, onSelect,
}) => (
  <motion.div
    whileHover={{ scale: 1.02, y: -5 }}
    whileTap={{ scale: 0.98 }}
    onClick={onSelect}
    className={[
      'relative cursor-pointer rounded-2xl p-6 border transition-all duration-300',
      isPrimary
        ? 'bg-[#1e1a17] border-[#c96442]/35'
        : 'bg-[#181512]/80 border-white/[0.07] hover:border-white/[0.12]',
    ].join(' ')}
    style={isPrimary ? {
      boxShadow: '0 0 50px rgba(201,100,66,0.12), inset 0 1px 0 rgba(255,255,255,0.06)',
    } : {
      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
    }}
  >
    {/* Popular badge */}
    {badge && (
      <span
        className="absolute -top-3.5 left-1/2 -translate-x-1/2 text-white text-[10px] font-black px-4 py-1 rounded-full tracking-widest uppercase"
        style={{
          background: 'linear-gradient(135deg, #c96442 0%, #e07a52 100%)',
          boxShadow: '0 2px 12px rgba(201,100,66,0.40)',
        }}
      >
        {badge}
      </span>
    )}

    {/* Plan name */}
    <p className={`text-[10px] font-black uppercase tracking-[0.15em] mb-3 ${
      isPrimary ? 'text-[#c96442]/80' : 'text-[#87867f]/70'
    }`}>
      {title}
    </p>

    {/* Price */}
    <div className="flex items-baseline gap-1.5 mb-5">
      <span className="text-5xl font-black text-white tracking-tighter leading-none">
        {price}
      </span>
      <span className="text-[#87867f] text-sm font-medium">{period}</span>
    </div>

    {/* Features */}
    <ul className="space-y-2.5 mb-7">
      {features.map((f) => (
        <li key={f} className="flex items-start gap-2.5 text-sm">
          <span className={[
            'mt-0.5 flex-shrink-0 w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-black',
            isPrimary
              ? 'bg-[#c96442]/20 text-[#c96442]'
              : 'bg-white/[0.08] text-[#87867f]',
          ].join(' ')}>
            ✓
          </span>
          <span className={isPrimary ? 'text-[#d4cfc9] leading-snug' : 'text-[#87867f] leading-snug'}>
            {f}
          </span>
        </li>
      ))}
    </ul>

    {/* CTA button */}
    <button
      type="button"
      disabled={isCheckingOut}
      className={[
        'w-full py-3.5 rounded-xl font-bold text-sm',
        'flex items-center justify-center gap-2',
        'transition-all duration-200',
        isPrimary
          ? 'text-white hover:-translate-y-0.5'
          : 'bg-white/[0.08] hover:bg-white/[0.13] text-[#d4cfc9] hover:-translate-y-0.5',
        isCheckingOut ? 'opacity-70 cursor-not-allowed !translate-y-0' : 'cursor-pointer',
      ].join(' ')}
      style={isPrimary ? {
        background: 'linear-gradient(135deg, #c96442 0%, #e07a52 100%)',
        boxShadow: isCheckingOut ? 'none' : '0 4px 20px rgba(201,100,66,0.40)',
      } : undefined}
    >
      {isCheckingOut ? (
        <>
          <svg className="animate-spin h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10"
              stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor"
              d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
          Redirecting to Stripe…
        </>
      ) : cta}
    </button>
  </motion.div>
);

// ─── Price IDs ────────────────────────────────────────────────────────────────
const PRICE_IDS = {
  pro:  import.meta.env.VITE_STRIPE_PRO_PRICE_ID  || 'price_dummy_pro_monthly',
  '24h': import.meta.env.VITE_STRIPE_24H_PRICE_ID || 'price_dummy_24h_pass',
} as const;

// ─── Component ────────────────────────────────────────────────────────────────
export const PaywallModal: React.FC<PaywallModalProps> = ({ onAccessGranted }) => {
  const [showBYOK, setShowBYOK] = useState(false);

  const currentAtsScore = useAppStore((s) => s.currentAtsScore);

  const startCheckout = useBillingStore(s => s.startCheckout);
  const isCheckingOut = useBillingStore(s => s.isCheckingOut);

  // ── Triple-click easter egg ────────────────────────────────────────────────
  const clickCountRef = useRef(0);
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleTitleClick = useCallback(() => {
    clickCountRef.current += 1;
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
    clickTimerRef.current = setTimeout(() => { clickCountRef.current = 0; }, 1500);
    if (clickCountRef.current >= 3) {
      clickCountRef.current = 0;
      if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
      setShowBYOK(true);
    }
  }, []);

  // ── Checkout handler ───────────────────────────────────────────────────────
  const handleCheckout = useCallback((planKey: string) => {
    const priceId = PRICE_IDS[planKey as keyof typeof PRICE_IDS] ?? planKey;
    const mode: 'subscription' | 'payment' = planKey === '24h' ? 'payment' : 'subscription';
    startCheckout(priceId, mode);
  }, [startCheckout]);

  // ── Plan data ─────────────────────────────────────────────────────────────
  const plans = [
    {
      badge:     'Most Popular',
      title:     'Pro Plan',
      price:     '$14.99',
      period:    '/ month',
      isPrimary: true,
      planKey:   'pro',
      features:  [
        'Unlimited ATS-optimised resumes',
        'Full AI interview simulation',
        'PDF export + cover letter',
        'Real-time ATS score tracker',
        'Priority support',
      ],
      cta: 'Start Pro — $14.99/month',
    },
    {
      badge:     undefined,
      title:     '24-Hour Pass',
      price:     '$4.99',
      period:    '/ 24 h',
      isPrimary: false,
      planKey:   '24h',
      features:  [
        '1 ATS-optimised resume',
        'Full AI interview session',
        'PDF export included',
        'ATS score snapshot',
      ],
      cta: 'Get 24-Hour Access',
    },
  ];

  return (
    <>
      {/* ── Backdrop ────────────────────────────────────────────────────────── */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="fixed inset-0 z-50 flex items-center justify-center px-4"
        style={{ background: 'rgba(10, 9, 8, 0.96)', backdropFilter: 'blur(12px)' }}
      >
        {/* Warm ambient glow — terracotta */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
          <div
            className="absolute -top-32 left-1/2 -translate-x-1/2 w-[700px] h-[420px] rounded-full blur-[140px]"
            style={{ background: 'rgba(201,100,66,0.08)' }}
          />
          <div
            className="absolute bottom-0 right-0 w-[320px] h-[320px] rounded-full blur-[100px]"
            style={{ background: 'rgba(224,122,82,0.05)' }}
          />
        </div>

        {/* ── Panel ─────────────────────────────────────────────────────────── */}
        <motion.div
          initial={{ opacity: 0, y: 44, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ type: 'spring', stiffness: 270, damping: 26, delay: 0.06 }}
          className="relative w-full max-w-xl overflow-y-auto max-h-[92vh] rounded-3xl"
          style={{
            background: '#141210',
            border: '1px solid rgba(255,255,255,0.07)',
            boxShadow: '0 30px 90px rgba(0,0,0,0.75)',
          }}
        >
          {/* Top-edge highlight line — terracotta warmth */}
          <div
            className="absolute inset-x-0 top-0 h-px pointer-events-none"
            style={{ background: 'linear-gradient(90deg, transparent, rgba(201,100,66,0.30), transparent)' }}
          />

          {/* ── Header ──────────────────────────────────────────────────────── */}
          <div className="relative px-8 pt-9 pb-7 text-center">
            {/* ATS score pill — conditional severity colours stay as-is */}
            <div className={[
              'inline-flex items-center gap-2 rounded-full px-4 py-1.5 mb-6 border',
              currentAtsScore >= 70
                ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-400'
                : currentAtsScore >= 40
                  ? 'bg-amber-500/10 border-amber-500/25 text-amber-400'
                  : 'bg-red-500/10 border-red-500/25 text-red-400',
            ].join(' ')}>
              <span className={[
                'w-1.5 h-1.5 rounded-full animate-pulse',
                currentAtsScore >= 70 ? 'bg-emerald-400'
                  : currentAtsScore >= 40 ? 'bg-amber-400'
                  : 'bg-red-400',
              ].join(' ')} />
              <span className="text-[11px] font-bold tracking-widest uppercase">
                ATS Score: {currentAtsScore}/100 —{' '}
                {currentAtsScore < 40
                  ? 'Invisible to recruiters'
                  : currentAtsScore < 70
                    ? 'Below the cutoff'
                    : 'Strong match'}
              </span>
            </div>

            {/* Title — easter-egg trigger */}
            <button
              type="button"
              onClick={handleTitleClick}
              className="block w-full mb-3 select-none cursor-default focus:outline-none"
              tabIndex={-1}
              aria-label="JobifAI — upgrade"
            >
              <span
                className="text-[1.75rem] sm:text-3xl font-black text-white tracking-tight leading-tight"
                style={{ fontFamily: 'Georgia, serif' }}
              >
                Beat the bot.{' '}
                <span style={{ color: '#c96442' }}>Land the interview.</span>
              </span>
            </button>

            <p className="text-[13px] leading-relaxed max-w-[280px] mx-auto" style={{ color: '#87867f' }}>
              Let JobifAI rebuild your resume to pass ATS filters
              and reach the humans who actually hire.
            </p>
          </div>

          {/* Divider */}
          <div
            className="h-px mx-8"
            style={{ background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.06), transparent)' }}
          />

          {/* ── Pricing cards ────────────────────────────────────────────────── */}
          <div className="px-8 py-7 grid grid-cols-1 sm:grid-cols-2 gap-4">
            {plans.map((plan) => (
              <PlanCard
                key={plan.title}
                {...plan}
                isCheckingOut={isCheckingOut}
                onSelect={() => !isCheckingOut && handleCheckout(plan.planKey)}
              />
            ))}
          </div>

          {/* ── Locked feature teasers ────────────────────────────────────────── */}
          <div className="px-8 pb-3">
            <p
              className="text-[9px] font-black uppercase tracking-[0.2em] mb-3 text-center"
              style={{ color: '#4a4540' }}
            >
              Also included with Pro
            </p>
            <div className="grid grid-cols-2 gap-2">
              {[
                { icon: '🪄', label: 'Cover Letter' },
                { icon: '🎯', label: 'Interview Prep' },
              ].map(({ icon, label }) => (
                <div
                  key={label}
                  className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-medium cursor-not-allowed"
                  style={{
                    background: 'rgba(255,255,255,0.02)',
                    border: '1px solid rgba(255,255,255,0.05)',
                    color: '#4a4540',
                  }}
                >
                  <span>{icon}</span>
                  <span>{label}</span>
                  <span
                    className="ml-auto text-[9px] font-black uppercase tracking-wide"
                    style={{ color: 'rgba(201,100,66,0.55)' }}
                  >
                    Pro
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* ── Free trial footer ─────────────────────────────────────────────── */}
          <div className="px-8 pb-9 pt-5 text-center">
            <div
              className="h-px mb-6"
              style={{ background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.05), transparent)' }}
            />

            <button
              type="button"
              onClick={onAccessGranted}
              className="group transition-colors duration-200"
            >
              <span className="block text-sm font-medium" style={{ color: '#6b6560' }}>
                Start my 1 Free Trial
              </span>
              <span
                className="block text-[11px] mt-0.5 transition-colors"
                style={{ color: '#3d3a37' }}
              >
                1 resume · ATS score only · No card required
              </span>
            </button>

          </div>
        </motion.div>
      </motion.div>

      {/* ── BYOK Easter Egg Modal ──────────────────────────────────────────────── */}
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
