/**
 * LoginPage — Route: /login
 * ─────────────────────────────────────────────────────────────────────────────
 * Auth entry point. Two sign-in methods:
 *   1. Google OAuth  — signInWithGoogle() → Supabase redirect → /dashboard
 *   2. Magic Link    — signInWithOtp()    → email link → /dashboard
 *
 * ?returnTo query param is forwarded through the OAuth redirectTo so users
 * land on the page they were trying to reach (e.g. /workspace).
 *
 * Guards:
 *   - Already authenticated → navigate to returnTo (or /dashboard)
 *   - isAuthLoading → spinner (session restore in flight)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthStore } from '@/store/useAuthStore';
import { supabase } from '@/lib/supabase';

export default function LoginPage() {
  const navigate       = useNavigate();
  const [params]       = useSearchParams();
  const returnTo       = params.get('returnTo') ?? '/dashboard';

  const { user, isAuthLoading, signInWithGoogle } = useAuthStore();

  const [email,        setEmail]        = useState('');
  const [magicSent,    setMagicSent]    = useState(false);
  const [magicLoading, setMagicLoading] = useState(false);
  const [magicError,   setMagicError]   = useState<string | null>(null);
  const [oauthError,   setOauthError]   = useState<string | null>(null);

  // Already logged in — bounce immediately
  useEffect(() => {
    if (!isAuthLoading && user) {
      navigate(returnTo, { replace: true });
    }
  }, [user, isAuthLoading, navigate, returnTo]);

  // ── Handlers ────────────────────────────────────────────────────────────────

  async function handleGoogle() {
    setOauthError(null);
    const redirectTo = `${window.location.origin}${returnTo}`;
    const err = await signInWithGoogle(redirectTo);
    if (err) setOauthError(err.message);
  }

  async function handleMagicLink(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setMagicLoading(true);
    setMagicError(null);
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: `${window.location.origin}${returnTo}` },
    });
    setMagicLoading(false);
    if (error) {
      setMagicError(error.message);
    } else {
      setMagicSent(true);
    }
  }

  // ── Loading state (session restore) ─────────────────────────────────────────
  if (isAuthLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#f5f3ec]">
        <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-[#c96442]" />
      </div>
    );
  }

  // ── Magic link sent confirmation ─────────────────────────────────────────────
  if (magicSent) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#f5f3ec] px-4">
        <div className="w-full max-w-sm text-center space-y-4">
          <div className="w-12 h-12 mx-auto rounded-full bg-[#c96442]/10 flex items-center justify-center">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="text-[#c96442]">
              <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <polyline points="22,6 12,13 2,6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-[#141413]">Check your inbox</h2>
          <p className="text-sm text-[#6b6963]">
            We sent a magic link to <strong>{email}</strong>.<br />
            Click it to sign in — no password needed.
          </p>
          <button
            onClick={() => setMagicSent(false)}
            className="text-sm text-[#c96442] hover:underline"
          >
            Use a different email
          </button>
        </div>
      </div>
    );
  }

  // ── Main login form ──────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#f5f3ec] px-4">
      <div className="w-full max-w-sm space-y-8">

        {/* Logo / wordmark */}
        <div className="text-center space-y-2">
          <div className="w-10 h-10 mx-auto rounded-xl bg-[#c96442] flex items-center justify-center">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" className="text-white">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <polyline points="14,2 14,8 20,8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <line x1="16" y1="13" x2="8" y2="13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              <line x1="16" y1="17" x2="8" y2="17" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              <polyline points="10,9 9,9 8,9" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </div>
          <h1 className="text-2xl font-semibold text-[#141413] tracking-tight">
            Welcome to JobifAI
          </h1>
          <p className="text-sm text-[#6b6963]">
            Sign in to access your AI resume editor
          </p>
        </div>

        <div className="space-y-4">

          {/* Google OAuth */}
          <button
            onClick={handleGoogle}
            className="w-full flex items-center justify-center gap-3 px-4 py-3 rounded-xl border border-[#d6d3ca] bg-white hover:bg-[#faf9f6] active:bg-[#f0ede6] transition-colors text-sm font-medium text-[#141413] shadow-sm"
          >
            {/* Google G logo */}
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615Z" fill="#4285F4"/>
              <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18Z" fill="#34A853"/>
              <path d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332Z" fill="#FBBC05"/>
              <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58Z" fill="#EA4335"/>
            </svg>
            Continue with Google
          </button>

          {oauthError && (
            <p className="text-xs text-red-600 text-center">{oauthError}</p>
          )}

          {/* Divider */}
          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-[#d6d3ca]" />
            <span className="text-xs text-[#b0aea5]">or</span>
            <div className="flex-1 h-px bg-[#d6d3ca]" />
          </div>

          {/* Magic link */}
          <form onSubmit={handleMagicLink} className="space-y-3">
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              className="w-full px-4 py-3 rounded-xl border border-[#d6d3ca] bg-white text-sm text-[#141413] placeholder:text-[#b0aea5] focus:outline-none focus:border-[#c96442] focus:ring-1 focus:ring-[#c96442]/30 transition-colors"
            />
            {magicError && (
              <p className="text-xs text-red-600">{magicError}</p>
            )}
            <button
              type="submit"
              disabled={magicLoading || !email.trim()}
              className="w-full px-4 py-3 rounded-xl bg-[#c96442] hover:bg-[#b85a3a] active:bg-[#a35234] disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm font-medium text-white"
            >
              {magicLoading ? 'Sending…' : 'Send magic link'}
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-[#b0aea5]">
          By continuing you agree to our{' '}
          <span className="underline cursor-pointer hover:text-[#6b6963]">Terms</span>
          {' '}and{' '}
          <span className="underline cursor-pointer hover:text-[#6b6963]">Privacy Policy</span>.
        </p>

      </div>
    </div>
  );
}
