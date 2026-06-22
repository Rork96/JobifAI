/**
 * Toaster — global toast renderer
 * Mounted once in App.tsx. Reads from useToastStore.
 *
 * Variants:
 *   success → green   (saved, accepted, signed in)
 *   error   → red     (DB fetch failed, auth error)
 *   info    → slate   (neutral feedback)
 */

import { motion, AnimatePresence } from 'framer-motion';
import { useToastStore } from '@/store/useToastStore';

const VARIANT_STYLES = {
  success: 'bg-green-600 text-white',
  error:   'bg-red-600 text-white',
  info:    'bg-slate-800 text-white',
};

const VARIANT_ICONS = {
  success: '✓',
  error:   '⚠',
  info:    'ℹ',
};

export default function Toaster() {
  const { message, variant, dismiss } = useToastStore();

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] pointer-events-none">
      <AnimatePresence>
        {message && (
          <motion.div
            key={message}
            initial={{ opacity: 0, y: 16, scale: 0.95 }}
            animate={{ opacity: 1, y: 0,  scale: 1    }}
            exit={{    opacity: 0, y: 8,  scale: 0.95 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className={`
              pointer-events-auto flex items-center gap-3
              px-4 py-3 rounded-2xl shadow-2xl
              text-sm font-semibold max-w-sm
              ${VARIANT_STYLES[variant]}
            `}
          >
            <span className="flex-shrink-0 font-bold">{VARIANT_ICONS[variant]}</span>
            <span className="flex-1">{message}</span>
            <button
              onClick={dismiss}
              className="flex-shrink-0 opacity-70 hover:opacity-100 transition-opacity ml-1"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
