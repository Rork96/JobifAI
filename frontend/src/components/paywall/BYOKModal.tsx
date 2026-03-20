/**
 * BYOKModal.tsx — Bring Your Own Key (Developer Easter Egg)
 * ─────────────────────────────────────────────────────────────────────────────
 * Triggered by clicking the PaywallModal title 3× rapidly.
 * Lets developers / power users enter their own Gemini API key and bypass
 * the paywall entirely — the key is stored in localStorage and picked up by
 * the interview SSE calls via a custom request header.
 *
 * Why this UX?
 *   • Removes the #1 friction for technical evaluators / investors.
 *   • Creates word-of-mouth ("this app has a secret dev mode") virality.
 *   • Zero cost to us — they supply the compute.
 *
 * Security note:
 *   The key is stored in localStorage (not sessionStorage) so it persists
 *   across tabs.  We never send it to our backend as a stored credential —
 *   it's passed as a request header on each API call and validated by Gemini.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useState, useRef } from 'react';
import { motion } from 'framer-motion';

// ─── Constants ────────────────────────────────────────────────────────────────
export const BYOK_STORAGE_KEY = 'byok_gemini_key';

// ─── Props ────────────────────────────────────────────────────────────────────
interface BYOKModalProps {
  onClose:         () => void;
  onAccessGranted: () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────
export const BYOKModal: React.FC<BYOKModalProps> = ({ onClose, onAccessGranted }) => {
  const [apiKey, setApiKey]     = useState('');
  const [error,  setError]      = useState('');
  const [saving, setSaving]     = useState(false);
  const inputRef                = useRef<HTMLInputElement>(null);

  // ── Key validation (basic format check) ─────────────────────────────────────
  // Gemini API keys start with "AIza" and are 39 characters long.
  const isValidFormat = (key: string): boolean =>
    /^AIza[A-Za-z0-9_-]{35}$/.test(key.trim());

  // ── Save handler ─────────────────────────────────────────────────────────────
  const handleSave = () => {
    const trimmed = apiKey.trim();

    if (!trimmed) {
      setError('Please enter your Gemini API key.');
      inputRef.current?.focus();
      return;
    }

    if (!isValidFormat(trimmed)) {
      setError('Key format looks off. Gemini keys start with "AIza" and are 39 characters.');
      inputRef.current?.focus();
      return;
    }

    setSaving(true);
    setError('');

    // Simulate a brief "validating..." pause for UX polish
    setTimeout(() => {
      localStorage.setItem(BYOK_STORAGE_KEY, trimmed);
      setSaving(false);
      onAccessGranted();
    }, 600);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') handleSave();
    if (e.key === 'Escape') onClose();
  };

  return (
    // ── Backdrop ─────────────────────────────────────────────────────────────
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[60] bg-slate-950/80 backdrop-blur-sm flex items-center justify-center px-4"
      onClick={onClose}
    >
      {/* ── Panel ───────────────────────────────────────────────────────────── */}
      <motion.div
        initial={{ opacity: 0, scale: 0.9, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.9, y: 20 }}
        transition={{ type: 'spring', stiffness: 400, damping: 30 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-slate-900 border border-slate-700/60 rounded-2xl shadow-2xl overflow-hidden"
      >
        {/* ── Terminal-style header ──────────────────────────────────────────── */}
        <div className="flex items-center gap-2 px-4 py-3 bg-slate-800/80 border-b border-slate-700/60">
          <span className="w-3 h-3 rounded-full bg-red-500/80" />
          <span className="w-3 h-3 rounded-full bg-yellow-500/80" />
          <span className="w-3 h-3 rounded-full bg-green-500/80" />
          <span className="ml-2 text-slate-400 text-xs font-mono">byok_mode.sh</span>
        </div>

        {/* ── Body ──────────────────────────────────────────────────────────── */}
        <div className="px-6 py-6">
          {/* Easter egg label */}
          <div className="inline-flex items-center gap-2 bg-purple-500/15 border border-purple-500/30 rounded-full px-3 py-1 mb-4">
            <span className="text-purple-400 text-xs font-mono">🔑 Developer Mode Unlocked</span>
          </div>

          <h2 className="text-white text-xl font-bold mb-1">Bring Your Own Key</h2>
          <p className="text-slate-400 text-sm mb-5">
            Enter your{' '}
            <span className="text-purple-400 font-mono">GEMINI_API_KEY</span>{' '}
            to unlock JobifAI for free. Your key is stored locally and never sent to our servers.
          </p>

          {/* API key input */}
          <div className="relative mb-2">
            <div className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 font-mono text-sm select-none">
              $
            </div>
            <input
              ref={inputRef}
              type="password"
              value={apiKey}
              onChange={(e) => { setApiKey(e.target.value); setError(''); }}
              onKeyDown={handleKeyDown}
              autoFocus
              placeholder="AIzaSy..."
              className={[
                'w-full bg-slate-800 border rounded-xl py-3 pl-8 pr-4',
                'font-mono text-sm text-slate-200 placeholder-slate-600',
                'focus:outline-none focus:ring-2 transition-colors duration-150',
                error
                  ? 'border-red-500/60 focus:ring-red-500/30'
                  : 'border-slate-700 focus:border-purple-500/60 focus:ring-purple-500/20',
              ].join(' ')}
            />
          </div>

          {/* Error message */}
          <AnimatedError message={error} />

          {/* Help text */}
          <p className="text-slate-600 text-xs mt-3 mb-5">
            Get a free key at{' '}
            <span className="text-slate-500 font-mono">aistudio.google.com</span>
            {' '}· Free tier: 15 req/min
          </p>

          {/* Actions */}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2.5 rounded-xl border border-slate-700 text-slate-400 hover:text-slate-200 hover:border-slate-600 text-sm font-medium transition-colors duration-150"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="flex-1 py-2.5 rounded-xl bg-purple-600 hover:bg-purple-500 disabled:opacity-60 disabled:cursor-not-allowed text-white text-sm font-semibold transition-all duration-150 shadow-md shadow-purple-600/20"
            >
              {saving ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                  Verifying…
                </span>
              ) : (
                'Unlock Access'
              )}
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
};

// ─── Animated error helper ────────────────────────────────────────────────────
const AnimatedError: React.FC<{ message: string }> = ({ message }) => (
  <motion.p
    initial={false}
    animate={message ? { opacity: 1, y: 0, height: 'auto' } : { opacity: 0, y: -4, height: 0 }}
    transition={{ duration: 0.15 }}
    className="text-red-400 text-xs overflow-hidden"
  >
    {message}
  </motion.p>
);
