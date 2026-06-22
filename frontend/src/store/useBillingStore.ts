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
import { useAuthStore } from '@/store/useAuthStore';
import { supabase } from '@/lib/supabase';

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
   * Invokes the `create-checkout-session` Supabase Edge Function and redirects
   * the browser to the returned Stripe Checkout URL on success.
   *
   * @param priceId  Stripe Price ID (e.g. price_xxx)
   * @param mode     'subscription' for Pro monthly, 'payment' for 24-Hour Pass.
   *                 Defaults to 'subscription' if omitted.
   */
  startCheckout: (priceId: string, mode?: 'subscription' | 'payment') => Promise<void>;
  finishCheckout: () => void;

  /**
   * Returns true if the user is premium (no-op).
   * Returns false AND opens the paywall modal with the given context if not premium.
   * Use this to gate any premium feature: `if (!checkPaywall('rewrite-limit')) return;`
   */
  checkPaywall: (context?: string) => boolean;
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

  startCheckout: async (priceId: string, mode: 'subscription' | 'payment' = 'subscription') => {
    set({ isCheckingOut: true });

    // When true, the page is navigating to Stripe — do NOT reset the spinner
    // in finally, or it flashes back to resting state before the page unloads.
    let navigatingToStripe = false;

    try {
      console.log('💳 [Billing] startCheckout — priceId:', priceId, '| mode:', mode);

      // ── Invoke the Edge Function ─────────────────────────────────────────
      // supabase.functions.invoke() can fail in two distinct ways:
      //   A) Returns { data: null, error: FunctionsHttpError }  — HTTP 4xx/5xx
      //   B) Throws SyntaxError — older SDK versions fail to parse an empty
      //      404 body (e.g. when the local Functions container isn't running).
      // Both paths are caught here; the outer try/catch handles (B).
      let invokeData: unknown = null;
      let invokeError: unknown = null;

      try {
        const result = await supabase.functions.invoke('create-checkout-session', {
          body: {
            priceId,
            returnUrl: `${window.location.origin}/dashboard`,
            mode,
          },
        });
        invokeData  = result.data;
        invokeError = result.error;
      } catch (sdkErr) {
        // SDK threw directly (SyntaxError on empty body, network failure, etc.)
        // Reclassify into a user-friendly message based on what we know.
        const raw = sdkErr instanceof Error ? sdkErr.message : String(sdkErr);
        const isParseError = raw.toLowerCase().includes('json') ||
                             raw.toLowerCase().includes('unexpected');
        const isNetworkError = raw.toLowerCase().includes('fetch') ||
                               raw.toLowerCase().includes('network');

        if (isParseError || isNetworkError) {
          throw new Error(
            'Payment service is currently booting up. Please try again in a moment.',
          );
        }
        throw new Error(`Payment service error: ${raw}`);
      }

      // ── Inspect the structured error (path A) ───────────────────────────
      if (invokeError) {
        const errObj = invokeError as { message?: string; status?: number; context?: { status?: number } };
        const status  = errObj.status ?? errObj.context?.status ?? 0;
        const rawMsg  = errObj.message ?? String(invokeError);

        // 404 = function not deployed / local container not started yet
        if (status === 404 || rawMsg.includes('404') || rawMsg.includes('Not Found')) {
          throw new Error(
            'Payment service is currently booting up. Please try again in a moment.',
          );
        }
        // 401 = JWT expired mid-session
        if (status === 401 || rawMsg.includes('401') || rawMsg.includes('Unauthorized')) {
          throw new Error('Your session expired. Please refresh the page and try again.');
        }
        throw new Error(`Edge Function error: ${rawMsg}`);
      }

      // ── Extract the Stripe checkout URL ─────────────────────────────────
      const payload  = invokeData as { url?: string; error?: string } | null;
      const url      = payload?.url;

      if (!url) {
        const serverMsg = payload?.error;
        throw new Error(serverMsg ?? 'No checkout URL returned — please try again.');
      }

      // ── Hand off to Stripe ───────────────────────────────────────────────
      console.log('💳 [Billing] Redirecting to Stripe Checkout…');
      navigatingToStripe = true;
      window.location.href = url;

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('❌ [Billing] startCheckout failed:', msg);
      alert(msg);   // already user-friendly at this point

    } finally {
      if (!navigatingToStripe) {
        set({ isCheckingOut: false });
      }
    }
  },

  finishCheckout: () =>
    set({ isCheckingOut: false }),

  checkPaywall: (context = 'general') => {
    const isPremium = useAuthStore.getState().isPremium;
    if (isPremium) return true;
    set({ isPaywallOpen: true, paywallContext: context });
    return false;
  },
}));
