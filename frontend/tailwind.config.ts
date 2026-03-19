/**
 * Tailwind CSS Configuration
 * ─────────────────────────────────────────────────────────────────────────────
 * Tailwind works by scanning your source files for class names and generating
 * only the CSS those classes need.  `content` tells it where to look.
 *
 * We extend the default theme rather than replace it — you keep all of
 * Tailwind's utilities AND get your custom brand tokens on top.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Config } from 'tailwindcss';

export default {
  // Scan these files for Tailwind class names (tree-shakes unused CSS in prod)
  content: ['./index.html', './src/**/*.{ts,tsx}'],

  // 'class' strategy: toggle dark mode by adding/removing class="dark" on <html>
  // This gives us programmatic control (user preference + OS preference sync).
  darkMode: 'class',

  theme: {
    extend: {
      // ── Brand colours ────────────────────────────────────────────────────
      // Apple-tier purple/violet palette — feels premium and AI-native.
      // Use brand-500 for primary actions, brand-50 for subtle backgrounds.
      colors: {
        brand: {
          50:  '#f5f3ff',
          100: '#ede9fe',
          200: '#ddd6fe',
          300: '#c4b5fd',
          400: '#a78bfa',
          500: '#8b5cf6',  // ← Primary accent
          600: '#7c3aed',  // ← Primary CTA (buttons)
          700: '#6d28d9',  // ← Hover state
          800: '#5b21b6',
          900: '#4c1d95',
        },

        // Page-level backgrounds (Apple website aesthetic)
        bg: {
          DEFAULT: '#f5f5f7',   // Light mode — off-white, not glaring white
          dark:    '#000000',   // Dark mode — true black (OLED-friendly)
        },

        // Card / panel surfaces
        surface: {
          DEFAULT: '#ffffff',
          dark:    '#1c1c1e',  // iOS dark surface colour
        },
      },

      // ── Typography ────────────────────────────────────────────────────────
      // Use the system UI font stack for an Apple-native feel on iOS/macOS.
      // -apple-system resolves to SF Pro on Apple devices.
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"SF Pro Display"',
          '"Segoe UI"',
          'system-ui',
          'sans-serif',
        ],
        mono: [
          '"SF Mono"',
          '"Fira Code"',
          '"Cascadia Code"',
          'monospace',
        ],
      },

      // ── Spacing / radii ───────────────────────────────────────────────────
      borderRadius: {
        '4xl': '2rem',    // Used on the Bottom Sheet's top corners
        '5xl': '2.5rem',
      },

      // ── Custom animations ─────────────────────────────────────────────────
      // These are CSS animation names — Framer Motion handles the mascot's
      // spring physics separately.  These are for simpler CSS-only animations.
      animation: {
        'float':      'float 4s ease-in-out infinite',
        'pulse-soft': 'pulse-soft 2s ease-in-out infinite',
        'shimmer':    'shimmer 2s linear infinite',
      },
      keyframes: {
        float: {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%':      { transform: 'translateY(-10px)' },
        },
        'pulse-soft': {
          '0%, 100%': { opacity: '1' },
          '50%':      { opacity: '0.6' },
        },
        shimmer: {
          '0%':   { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },

      // ── Box shadows ───────────────────────────────────────────────────────
      boxShadow: {
        'card':       '0 4px 24px -4px rgba(0,0,0,0.08)',
        'brand':      '0 4px 20px -4px rgba(124,58,237,0.35)',
        'sheet':      '0 -8px 40px -8px rgba(0,0,0,0.15)',
      },
    },
  },

  plugins: [],
} satisfies Config;
