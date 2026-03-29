// Handbook §4.2 — Store 2: useBillingStore
// Owns: paywall modal, auth modal, checkout state.
// Reads canUseAI() from useAuthStore — never duplicates quota logic here.
// Target location (post-migration): features/billing/model/useBillingStore.ts

import { create } from 'zustand'

type PaywallContext = 'rewrite' | 'interview' | 'cover-letter' | null
type AuthModalContext = 'sign-in' | 'sign-up' | null

interface BillingState {
  isPaywallOpen: boolean
  paywallContext: PaywallContext
  isAuthModalOpen: boolean
  authModalContext: AuthModalContext
  isCheckingOut: boolean
}

interface BillingActions {
  openPaywall: (context?: PaywallContext) => void
  closePaywall: () => void
  openAuthModal: (context?: AuthModalContext) => void
  closeAuthModal: () => void
  startCheckout: () => void
  finishCheckout: () => void
}

export const useBillingStore = create<BillingState & BillingActions>((set) => ({
  isPaywallOpen: false,
  paywallContext: null,
  isAuthModalOpen: false,
  authModalContext: null,
  isCheckingOut: false,

  openPaywall: (context = null) =>
    set({ isPaywallOpen: true, paywallContext: context }),
  closePaywall: () =>
    set({ isPaywallOpen: false, paywallContext: null }),

  openAuthModal: (context = null) =>
    set({ isAuthModalOpen: true, authModalContext: context }),
  closeAuthModal: () =>
    set({ isAuthModalOpen: false, authModalContext: null }),

  startCheckout: () => set({ isCheckingOut: true }),
  finishCheckout: () => set({ isCheckingOut: false }),
}))
