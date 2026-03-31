/**
 * AuthModal — Soft-gate authentication overlay
 * FSD location: shared/ui/AuthModal.tsx
 *
 * Opened by: LandingPage soft-gate CTAs (Fix My Resume / Start Interview Prep)
 * Also opened by: ProtectedRoute redirect via ?returnTo param
 *
 * Modes: 'signin' | 'signup' — toggled inline, no route change (PRD §1.3)
 *
 * Auth methods:
 *   1. Email + password  → useAuthStore.signInWithEmail / signUpWithEmail
 *   2. Google OAuth      → useAuthStore.signInWithGoogle (redirect flow)
 *
 * Post-auth navigation:
 *   Reads ?returnTo from the current URL. If present, navigates there.
 *   Falls back to /dashboard.
 *
 * Phase 7 wiring points (marked TODO):
 *   - Add Magic Link / OTP tab
 *   - Wire real Google OAuth redirect URL
 *   - Show email confirmation banner after signUp
 */

import { useState, useRef, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuthStore } from '@/store/useAuthStore';

// ── Intent copy map ───────────────────────────────────────────────────────────

const INTENT_COPY: Record<string, { headline: string; sub: string }> = {
  'fix-resume': {
    headline: 'Sign in to fix your resume',
    sub: 'Your ATS score is ready. Create a free account to unlock the full rewrite.',
  },
  'start-interview': {
    headline: 'Sign in to start Interview Prep',
    sub: 'Create a free account to begin your role-specific interview practice.',
  },
  general: {
    headline: 'Welcome to JobifAI',
    sub: 'Sign in or create a free account to continue.',
  },
};

// ── Props ─────────────────────────────────────────────────────────────────────

export type AuthIntent = 'fix-resume' | 'start-interview' | 'general';

interface AuthModalProps {
  isOpen:   boolean;
  onClose:  () => void;
  intent?:  AuthIntent;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function AuthModal({ isOpen, onClose, intent = 'general' }: AuthModalProps) {
  const navigate       = useNavigate();
  const [searchParams] = useSearchParams();

  const signInWithEmail  = useAuthStore(s => s.signInWithEmail);
  const signUpWithEmail  = useAuthStore(s => s.signUpWithEmail);
  const signInWithGoogle = useAuthStore(s => s.signInWithGoogle);

  const [mode,     setMode]     = useState<'signin' | 'signup'>('signin');
  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const [success,  setSuccess]  = useState<string | null>(null);

  const emailRef = useRef<HTMLInputElement>(null);

  // Focus email input when modal opens; reset form state on close
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => emailRef.current?.focus(), 80);
    } else {
      setEmail('');
      setPassword('');
      setError(null);
      setSuccess(null);
      setLoading(false);
    }
  }, [isOpen]);

  // Dismiss error when user starts typing again
  useEffect(() => { setError(null); }, [email, password]);

  const returnTo = searchParams.get('returnTo') ?? '/dashboard';

  const handleSuccess = () => {
    onClose();
    navigate(returnTo);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password.trim()) return;

    setLoading(true);
    setError(null);

    const err = mode === 'signin'
      ? await signInWithEmail(email.trim(), password)
      : await signUpWithEmail(email.trim(), password);

    setLoading(false);

    if (err) {
      setError(err.message);
      return;
    }

    if (mode === 'signup') {
      // Supabase may require email confirmation before SIGNED_IN fires.
      // Show a message instead of navigating immediately.
      setSuccess('Check your inbox to confirm your email, then sign in.');
      setMode('signin');
      setPassword('');
      return;
    }

    // signIn success — onAuthStateChange fires SIGNED_IN → store updates
    handleSuccess();
  };

  const handleGoogle = async () => {
    setLoading(true);
    setError(null);
    // TODO Phase 7: pass correct redirectTo for production domain
    const err = await signInWithGoogle(`${window.location.origin}/dashboard`);
    if (err) {
      setLoading(false);
      setError(err.message);
    }
    // On success, Supabase redirects the browser — no further action here
  };

  const copy = INTENT_COPY[intent] ?? INTENT_COPY.general;

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            key="auth-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={onClose}
            className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
          />

          {/* Modal */}
          <motion.div
            key="auth-modal"
            initial={{ opacity: 0, scale: 0.95, y: 12 }}
            animate={{ opacity: 1, scale: 1,    y: 0  }}
            exit={{    opacity: 0, scale: 0.95, y: 8  }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="fixed inset-0 z-50 flex items-center justify-center px-4 pointer-events-none"
          >
            <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl pointer-events-auto overflow-hidden">

              {/* Header */}
              <div className="px-6 pt-6 pb-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-bold text-brand-600 uppercase tracking-wide mb-1">
                      Jobif<span className="text-slate-900">AI</span>
                    </p>
                    <h2 className="text-lg font-black text-slate-900 leading-tight">
                      {copy.headline}
                    </h2>
                    <p className="text-sm text-slate-500 mt-1 leading-snug">
                      {copy.sub}
                    </p>
                  </div>
                  <button
                    onClick={onClose}
                    className="flex-shrink-0 text-slate-400 hover:text-slate-700
                               transition-colors p-1 rounded-lg hover:bg-slate-100 mt-0.5"
                    aria-label="Close"
                  >
                    ✕
                  </button>
                </div>
              </div>

              {/* Mode tabs */}
              <div className="px-6 pb-4">
                <div className="flex rounded-xl bg-slate-100 p-1 gap-1">
                  {(['signin', 'signup'] as const).map(m => (
                    <button
                      key={m}
                      onClick={() => { setMode(m); setError(null); setSuccess(null); }}
                      className={`flex-1 py-1.5 rounded-lg text-sm font-semibold transition-all duration-150
                        ${mode === m
                          ? 'bg-white text-slate-900 shadow-sm'
                          : 'text-slate-500 hover:text-slate-700'}`}
                    >
                      {m === 'signin' ? 'Sign In' : 'Create Account'}
                    </button>
                  ))}
                </div>
              </div>

              {/* Body */}
              <div className="px-6 pb-6 space-y-4">

                {/* Success message */}
                <AnimatePresence>
                  {success && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className="rounded-xl bg-green-50 border border-green-200 px-3 py-2.5"
                    >
                      <p className="text-sm text-green-700 font-medium">✓ {success}</p>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Error message */}
                <AnimatePresence>
                  {error && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className="rounded-xl bg-red-50 border border-red-200 px-3 py-2.5"
                    >
                      <p className="text-sm text-red-700">⚠ {error}</p>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Form */}
                <form onSubmit={handleSubmit} className="space-y-3">
                  <input
                    ref={emailRef}
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    required
                    autoComplete="email"
                    className="w-full rounded-xl border border-slate-200 bg-white
                               px-3 py-2.5 text-sm text-slate-700 placeholder:text-slate-400
                               focus:outline-none focus:ring-2 focus:ring-brand-400
                               focus:border-transparent"
                  />
                  <input
                    type="password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder={mode === 'signup' ? 'Create a password' : 'Password'}
                    required
                    autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                    minLength={mode === 'signup' ? 6 : undefined}
                    className="w-full rounded-xl border border-slate-200 bg-white
                               px-3 py-2.5 text-sm text-slate-700 placeholder:text-slate-400
                               focus:outline-none focus:ring-2 focus:ring-brand-400
                               focus:border-transparent"
                  />

                  <button
                    type="submit"
                    disabled={loading || !email.trim() || !password.trim()}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5
                               rounded-xl bg-brand-600 hover:bg-brand-700
                               disabled:bg-slate-200 disabled:text-slate-400
                               text-white font-bold text-sm transition-colors
                               active:scale-[0.98]"
                  >
                    {loading ? (
                      <>
                        <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10"
                            stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor"
                            d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                        </svg>
                        {mode === 'signin' ? 'Signing in…' : 'Creating account…'}
                      </>
                    ) : (
                      mode === 'signin' ? 'Sign In' : 'Create Free Account'
                    )}
                  </button>
                </form>

                {/* Divider */}
                <div className="flex items-center gap-3">
                  <div className="flex-1 border-t border-slate-100" />
                  <span className="text-xs text-slate-400 font-medium">or</span>
                  <div className="flex-1 border-t border-slate-100" />
                </div>

                {/* Google OAuth */}
                <button
                  onClick={handleGoogle}
                  disabled={loading}
                  className="w-full flex items-center justify-center gap-3 px-4 py-2.5
                             rounded-xl bg-white border border-slate-200
                             hover:bg-slate-50 disabled:opacity-50
                             text-slate-700 font-semibold text-sm
                             transition-colors active:scale-[0.98]"
                >
                  {/* Google "G" logo */}
                  <svg width="18" height="18" viewBox="0 0 48 48" fill="none">
                    <path d="M43.6 20.5H42V20H24v8h11.3C33.7 32.6 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.5-.4-3.5z" fill="#FFC107"/>
                    <path d="M6.3 14.7l6.6 4.8C14.7 16 19.1 12 24 12c3.1 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4c-7.7 0-14.4 4.4-17.7 10.7z" fill="#FF3D00"/>
                    <path d="M24 44c5.2 0 9.9-1.9 13.5-5l-6.2-5.3C29.3 35.3 26.8 36 24 36c-5.3 0-9.7-3.4-11.3-8H6.2C9.5 36.7 16.2 44 24 44z" fill="#4CAF50"/>
                    <path d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4.1 5.4l6.2 5.3C41.3 34.7 44 29.8 44 24c0-1.2-.1-2.5-.4-3.5z" fill="#1976D2"/>
                  </svg>
                  Continue with Google
                </button>

                {/* Footer note */}
                <p className="text-xs text-center text-slate-400 leading-relaxed">
                  By continuing you agree to our Terms of Service and Privacy Policy.
                  Free tier: 3 resume rewrites · 1 interview session.
                </p>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
