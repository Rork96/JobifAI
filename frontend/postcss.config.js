/**
 * PostCSS Configuration
 * PostCSS is a CSS transformer pipeline.  Tailwind and Autoprefixer are
 * PostCSS plugins — this file wires them together.
 *
 *   tailwindcss   → generates utility classes from your config + source scan
 *   autoprefixer  → adds vendor prefixes (e.g. -webkit-) so CSS works in
 *                   older browsers without you manually writing them
 */
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
