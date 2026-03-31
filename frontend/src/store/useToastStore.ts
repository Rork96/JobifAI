/**
 * useToastStore — minimal global toast notifications
 * ─────────────────────────────────────────────────────────────────────────────
 * Single active toast at a time (no queue — PRD keeps UI simple).
 * Auto-dismisses after `duration` ms.
 *
 * Usage:
 *   useToastStore.getState().show('Failed to load documents', 'error');
 *   useToastStore.getState().show('Profile saved', 'success');
 *
 * Rendered by: <Toaster /> mounted once in App.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { create } from 'zustand';

export type ToastVariant = 'success' | 'error' | 'info';

interface ToastState {
  message:   string | null;
  variant:   ToastVariant;
  show: (message: string, variant?: ToastVariant, duration?: number) => void;
  dismiss: () => void;
}

let dismissTimer: ReturnType<typeof setTimeout> | null = null;

export const useToastStore = create<ToastState>((set) => ({
  message: null,
  variant: 'info',

  show: (message, variant = 'info', duration = 4000) => {
    if (dismissTimer) clearTimeout(dismissTimer);
    set({ message, variant });
    dismissTimer = setTimeout(() => {
      set({ message: null });
      dismissTimer = null;
    }, duration);
  },

  dismiss: () => {
    if (dismissTimer) { clearTimeout(dismissTimer); dismissTimer = null; }
    set({ message: null });
  },
}));
