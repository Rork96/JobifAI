/**
 * BYOKModal.tsx — Bring Your Own Key (Developer Easter Egg)
 * ─────────────────────────────────────────────────────────────────────────────
 * Triggered by clicking the PaywallModal title 3× rapidly.
 * Lets developers / power users enter their own Gemini API key and bypass
 * the paywall entirely — the key is stored in localStorage AND synced into
 * useChatStore so all API calls pick it up immediately without a page reload.
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
 *
 * Store contract (PRD §1.4):
 *   useChatStore.byokApiKey is the runtime source-of-truth.
 *   localStorage is the persistence layer, seeded into the store on init.
 *   Both are always updated together here.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useChatStore }  from '@/store/useChatStore';
import { useToastStore } from '@/store/useToastStore';

// ─── Constants ────────────────────────────────────────────────────────────────
/** Must match the key used in useChatStore initial state. */
export const BYOK_STORAGE_KEY = 'byok_gemini_key';

// ─── Types ────────────────────────────────────────────────────────────────────
type SaveState = 'idle' | 'saving' | 'saved';

// ─── Props ────────────────────────────────────────────────────────────────────
interface BYOKModalProps {
  onClose:         () => void;
  onAccessGranted: () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────
export const BYOKModal: React.FC<BYOKModalProps> = ({ onClose, onAccessGranted }) => {
  const setByokApiKey = useChatStore(s => s.setByokApiKey);
  // Read the current stored key to pre-fill and show KEY ACTIVE state
  const storedKey     = useChatStore(s => s.byokApiKey);
  const hasActiveKey  = Boolean(storedKey);

  const [apiKey,    setApiKey]    = useState(storedKey ?? '');
  const [error,     setError]     = useState('');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const inputRef                  = useRef<HTMLInputElement>(null);

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

    setSaveState('saving');
    setError('');

    // Brief "verifying…" pause for UX polish, then commit
    setTimeout(() => {
      // 1. Persist to localStorage (survives page refresh)
      localStorage.setItem(BYOK_STORAGE_KEY, trimmed);
      // 2. Sync into runtime store (takes effect immediately, no reload needed)
      setByokApiKey(trimmed);

      setSaveState('saved');
      useToastStore.getState().show(
        '🔑 Gemini key saved — unlimited access active!',
        'success',
        3500,
      );

      // Return to saved state briefly, then hand off
      setTimeout(() => {
        onAccessGranted();
      }, 900);
    }, 700);
  };

  // ── Clear handler ─────────────────────────────────────────────────────────────
  const handleClear = () => {
    // 1. Remove from localStorage
    localStorage.removeItem(BYOK_STORAGE_KEY);
    // 2. Nullify runtime store
    setByokApiKey(null);
    // 3. Reset local input
    setApiKey('');
    setError('');
    setSaveState('idle');

    useToastStore.getState().show(
      'Gemini key cleared — free tier limits restored.',
      'info',
      3000,
    );
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter')  handleSave();
    if (e.key === 'Escape') onClose();
  };

  // ── Derived display values ─────────────────────────────────────────────────
  const saveLabel =
    saveState === 'saving' ? null            // shows spinner below
    : saveState === 'saved' ? 'Saved ✓ — Unlocked!'
    : hasActiveKey          ? 'Update Key'
    :                         'Unlock Access';

  return (
    // ── Backdrop ───────────────────────────────────────────────────────────────
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[60] flex items-center justify-center px-4"
      style={{ background: 'rgba(10, 9, 8, 0.92)', backdropFilter: 'blur(14px)' }}
      onClick={onClose}
    >
      {/* ── Ambient terracotta glow ──────────────────────────────────────────── */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 480px 320px at 50% 50%, rgba(201,100,66,0.07) 0%, transparent 70%)',
        }}
      />

      {/* ── Panel ─────────────────────────────────────────────────────────────── */}
      <motion.div
        initial={{ opacity: 0, scale: 0.92, y: 16 }}
        animate={{ opacity: 1, scale: 1,    y: 0  }}
        exit={{ opacity: 0, scale: 0.92,    y: 16 }}
        transition={{ type: 'spring', stiffness: 420, damping: 32 }}
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-md rounded-2xl overflow-hidden"
        style={{
          background: '#141210',
          border: '1px solid rgba(255,255,255,0.07)',
          boxShadow: '0 24px 60px rgba(0,0,0,0.55), 0 0 0 1px rgba(201,100,66,0.08)',
        }}
      >
        {/* ── Terminal-style title bar ─────────────────────────────────────────── */}
        <div
          className="flex items-center gap-2 px-4 py-3 border-b"
          style={{ background: '#1e1a17', borderColor: 'rgba(255,255,255,0.07)' }}
        >
          {/* macOS traffic-light dots */}
          <span className="w-3 h-3 rounded-full bg-red-500/80" />
          <span className="w-3 h-3 rounded-full bg-yellow-500/80" />
          <span className="w-3 h-3 rounded-full bg-green-500/80" />

          <span
            className="ml-2 text-xs font-mono"
            style={{ color: 'rgba(255,255,255,0.35)' }}
          >
            byok_mode.sh
          </span>

          {/* KEY ACTIVE indicator — shown when a key is already stored */}
          <AnimatePresence>
            {hasActiveKey && (
              <motion.span
                key="key-active"
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                className="ml-auto text-[10px] font-bold font-mono px-2 py-0.5 rounded-full"
                style={{
                  background: 'rgba(16,185,129,0.15)',
                  border: '1px solid rgba(16,185,129,0.35)',
                  color: '#10b981',
                }}
              >
                ● KEY ACTIVE
              </motion.span>
            )}
          </AnimatePresence>
        </div>

        {/* ── Body ──────────────────────────────────────────────────────────────── */}
        <div className="px-6 py-6">
          {/* Easter egg badge */}
          <div
            className="inline-flex items-center gap-2 rounded-full px-3 py-1 mb-4"
            style={{
              background: 'rgba(201,100,66,0.10)',
              border: '1px solid rgba(201,100,66,0.28)',
            }}
          >
            <span className="text-xs font-mono" style={{ color: '#e07a52' }}>
              🔑 Developer Mode Unlocked
            </span>
          </div>

          <h2 className="text-white text-xl font-bold mb-1">
            Bring Your Own Key
          </h2>
          <p className="text-sm mb-5" style={{ color: 'rgba(255,255,255,0.45)' }}>
            Enter your{' '}
            <span className="font-mono" style={{ color: '#e07a52' }}>
              GEMINI_API_KEY
            </span>{' '}
            to unlock JobifAI for free. Your key is stored locally and{' '}
            <span style={{ color: 'rgba(255,255,255,0.60)' }}>
              never sent to our servers.
            </span>
          </p>

          {/* ── API key input ────────────────────────────────────────────────── */}
          <div className="relative mb-2">
            <div
              className="absolute left-3 top-1/2 -translate-y-1/2 font-mono text-sm select-none"
              style={{ color: 'rgba(255,255,255,0.25)' }}
            >
              $
            </div>
            <input
              ref={inputRef}
              type="password"
              value={apiKey}
              onChange={(e) => { setApiKey(e.target.value); setError(''); }}
              onKeyDown={handleKeyDown}
              autoFocus
              placeholder="AIzaSy…"
              className="w-full rounded-xl py-3 pl-8 pr-4 font-mono text-sm focus:outline-none transition-all duration-150"
              style={{
                background: '#0e0c0a',
                border: error
                  ? '1px solid rgba(239,68,68,0.50)'
                  : '1px solid rgba(255,255,255,0.10)',
                color: 'rgba(255,255,255,0.85)',
                boxShadow: error
                  ? '0 0 0 3px rgba(239,68,68,0.10)'
                  : apiKey
                    ? '0 0 0 3px rgba(201,100,66,0.10)'
                    : 'none',
                // Override autofill bg on Chrome
              } as React.CSSProperties}
            />
          </div>

          {/* Animated error */}
          <AnimatedError message={error} />

          {/* Help text */}
          <p className="text-xs mt-3 mb-5" style={{ color: 'rgba(255,255,255,0.25)' }}>
            Get a free key at{' '}
            <span className="font-mono" style={{ color: 'rgba(255,255,255,0.40)' }}>
              aistudio.google.com
            </span>
            {' '}· Free tier: 15 req / min
          </p>

          {/* ── Action buttons ───────────────────────────────────────────────── */}
          <div className="flex gap-3">
            {/* Cancel */}
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2.5 rounded-xl text-sm font-medium transition-all duration-150"
              style={{
                border: '1px solid rgba(255,255,255,0.10)',
                color: 'rgba(255,255,255,0.40)',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,255,255,0.20)';
                (e.currentTarget as HTMLButtonElement).style.color       = 'rgba(255,255,255,0.65)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,255,255,0.10)';
                (e.currentTarget as HTMLButtonElement).style.color       = 'rgba(255,255,255,0.40)';
              }}
            >
              Cancel
            </button>

            {/* Save / Unlock — primary CTA */}
            <button
              type="button"
              onClick={handleSave}
              disabled={saveState !== 'idle'}
              className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white transition-all duration-150 disabled:cursor-not-allowed"
              style={{
                background:
                  saveState === 'saved'
                    ? 'linear-gradient(135deg, #10b981 0%, #059669 100%)'
                    : 'linear-gradient(135deg, #c96442 0%, #e07a52 100%)',
                boxShadow:
                  saveState === 'saved'
                    ? '0 4px 18px rgba(16,185,129,0.35)'
                    : '0 4px 18px rgba(201,100,66,0.35)',
                opacity: saveState === 'saving' ? 0.75 : 1,
              }}
            >
              {saveState === 'saving' ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle
                      className="opacity-25"
                      cx="12" cy="12" r="10"
                      stroke="currentColor" strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8v8H4z"
                    />
                  </svg>
                  Verifying…
                </span>
              ) : (
                saveLabel
              )}
            </button>
          </div>

          {/* ── Clear Key — destructive action (only shown when key is active) ── */}
          <AnimatePresence>
            {hasActiveKey && (
              <motion.div
                key="clear-row"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.18 }}
                className="overflow-hidden"
              >
                <div className="mt-3 pt-3" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                  <button
                    type="button"
                    onClick={handleClear}
                    className="w-full py-2 rounded-xl text-xs font-semibold transition-all duration-150"
                    style={{
                      background: 'rgba(239,68,68,0.07)',
                      border: '1px solid rgba(239,68,68,0.20)',
                      color: 'rgba(239,68,68,0.70)',
                    }}
                    onMouseEnter={(e) => {
                      const el = e.currentTarget as HTMLButtonElement;
                      el.style.background   = 'rgba(239,68,68,0.14)';
                      el.style.borderColor  = 'rgba(239,68,68,0.40)';
                      el.style.color        = 'rgba(239,68,68,0.95)';
                    }}
                    onMouseLeave={(e) => {
                      const el = e.currentTarget as HTMLButtonElement;
                      el.style.background   = 'rgba(239,68,68,0.07)';
                      el.style.borderColor  = 'rgba(239,68,68,0.20)';
                      el.style.color        = 'rgba(239,68,68,0.70)';
                    }}
                  >
                    🗑 Clear Saved Key — revert to free tier
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </motion.div>
  );
};

// ─── Animated error helper ─────────────────────────────────────────────────────
const AnimatedError: React.FC<{ message: string }> = ({ message }) => (
  <motion.p
    initial={false}
    animate={message ? { opacity: 1, y: 0, height: 'auto' } : { opacity: 0, y: -4, height: 0 }}
    transition={{ duration: 0.15 }}
    className="text-xs overflow-hidden"
    style={{ color: 'rgba(239,68,68,0.85)' }}
  >
    {message}
  </motion.p>
);
