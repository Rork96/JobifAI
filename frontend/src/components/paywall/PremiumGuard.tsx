/**
 * PremiumGuard — wraps any premium feature in the UI.
 *
 * Usage (render-prop or wrapper):
 *
 *   <PremiumGuard context="cover-letter">
 *     <CoverLetterButton />
 *   </PremiumGuard>
 *
 * When the user is NOT premium, clicking anywhere inside the wrapper opens
 * the paywall modal with the given context and swallows the original click.
 * When the user IS premium, children render and behave normally.
 */

import React from 'react';
import { useAuthStore } from '@/store/useAuthStore';
import { useBillingStore } from '@/store/useBillingStore';

interface PremiumGuardProps {
  /** Passed to openPaywall() so the modal can show tailored copy. */
  context?: string;
  children: React.ReactNode;
  /** Optional: render a lock badge overlay on the children. Default: false. */
  showLockBadge?: boolean;
}

export default function PremiumGuard({
  context = 'general',
  children,
  showLockBadge = false,
}: PremiumGuardProps) {
  const isPremium    = useAuthStore(s => s.isPremium);
  const checkPaywall = useBillingStore(s => s.checkPaywall);

  if (isPremium) return <>{children}</>;

  return (
    <div
      className="relative"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        checkPaywall(context);
      }}
      style={{ cursor: 'pointer' }}
    >
      {/* Dim the children slightly to hint they're locked */}
      <div className="pointer-events-none opacity-60 select-none">
        {children}
      </div>

      {showLockBadge && (
        <span className="absolute top-1 right-1 flex items-center gap-1 bg-[#c96442] text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full shadow-sm">
          <svg width="8" height="10" viewBox="0 0 24 24" fill="currentColor">
            <path d="M18 11H6V8a6 6 0 0 1 12 0v3zm-6 9a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm8-9V8A8 8 0 0 0 4 8v3H2v11h20V11h-2z"/>
          </svg>
          PRO
        </span>
      )}
    </div>
  );
}
