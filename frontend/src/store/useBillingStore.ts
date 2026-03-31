/**
 * useBillingStore — Store 2 of 5
 * ─────────────────────────────────────────────────────────────────────────────
 * Handbook §4.2 — owns: paywall modal, auth modal, checkout state.
 *
 * FSD target location: features/billing/model/useBillingStore.ts
 * Lives in store/ during Phase 1; will move during FSD refactor.
 *
 * Rules:
 *   - NEVER duplicate quota logic here. Read canUseAI() from useAuthStore.
 *   - openPaywall() is called by apiClient on every 402 (Handbook §3.4).
 *     "402 always triggers openPaywall(). Handled in apiClient, never in
 *      individual feature API files."
 *   - The auth modal is non-blocking — it opens in-place, no route change.
 *     PRD §1.3: "AUTH MODAL (non-blocking, not a new route)"
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { create } from 'zustand';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Context strings explain WHY the paywall opened — used to tailor copy.
 * e.g. 'rewrite-limit' | 'interview-limit' | 'cover-letter' | 'general'
 */
type PaywallContext = string | null;

/**
 * Context strings explain WHY auth is needed — used to tailor modal copy.
 * e.g. 'fix-resume' | 'start-interview' | 'general'
 */
type AuthModalContext = string | null;

interface BillingState {
  // ── State ──────────────────────────────────────────────────────────────────
  isPaywallOpen: boolean;
  paywallContext: PaywallContext;

  /** Auth modal state — non-blocking, in-place (not a route change). */
  isAuthModalOpen: boolean;
  authModalContext: AuthModalContext;

  isCheckingOut: boolean;

  // ── Actions ────────────────────────────────────────────────────────────────
  /**
   * Open the paywall modal. Called automatically by apiClient on 402.
   * Also called by PremiumWrapper when a locked feature is clicked.
   */
  openPaywall: (context?: PaywallContext) => void;
  closePaywall: () => void;

  /**
   * Open the auth modal in-place (no route change).
   * Called by soft-gate CTA buttons on the landing page.
   * PRD §2.3: "Auth modal opens in place (no route change). On success → /dashboard"
   */
  openAuthModal: (context?: AuthModalContext) => void;
  closeAuthModal: () => void;

  /**
   * Begin Stripe Checkout. Sets isCheckingOut = true to prevent double-clicks.
   * The actual API call lives in features/billing/api/checkoutApi.ts.
   */
  startCheckout: () => void;
  finishCheckout: () => void;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useBillingStore = create<BillingState>((set) => ({
  // ── Initial state ──────────────────────────────────────────────────────────
  isPaywallOpen: false,
  paywallContext: null,
  isAuthModalOpen: false,
  authModalContext: null,
  isCheckingOut: false,

  // ── Actions ────────────────────────────────────────────────────────────────
  openPaywall: (context = null) =>
    set({ isPaywallOpen: true, paywallContext: context }),

  closePaywall: () =>
    set({ isPaywallOpen: false, paywallContext: null }),

  openAuthModal: (context = null) =>
    set({ isAuthModalOpen: true, authModalContext: context }),

  closeAuthModal: () =>
    set({ isAuthModalOpen: false, authModalContext: null }),

  startCheckout: () =>
    set({ isCheckingOut: true }),

  finishCheckout: () =>
    set({ isCheckingOut: false }),
}));
