/**
 * Vite Configuration
 * ─────────────────────────────────────────────────────────────────────────────
 * Vite is our build tool + dev server.  Think of it as webpack but ~100×
 * faster because it skips bundling in dev (serves ES modules directly) and
 * uses esbuild (written in Go) for TypeScript transpilation.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [
    // Transforms React JSX/TSX and enables React Fast Refresh (hot reload
    // that preserves component state — unlike full-page refresh).
    react(),
  ],

  resolve: {
    alias: {
      // '@' maps to 'src/' so we can import '@/store/useAppStore'
      // instead of '../../../store/useAppStore'.  DRY, rename-proof.
      '@': path.resolve(__dirname, './src'),
    },
  },

  server: {
    port: 5173,

    // Dev proxy: any request to /api/* is forwarded to the FastAPI backend.
    // This avoids CORS issues during development — the browser thinks everything
    // comes from the same origin (localhost:5173).
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        // Don't rewrite the path — FastAPI expects the full /api/v1/... prefix
      },
    },
  },

  build: {
    // ES2020 is safe for modern browsers and the Pi 5 runs Chromium.
    target: 'es2020',
    // Source maps in production help debug errors reported from the field
    // without exposing raw source (source maps are only fetched by DevTools).
    sourcemap: true,
    // Chunk size warning threshold in kB — warn if any chunk exceeds 800 kB
    chunkSizeWarningLimit: 800,
  },
});
