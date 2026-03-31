import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Bind to 0.0.0.0 so Docker port-forwarding can reach the Vite server.
    // Without this Vite binds only to 127.0.0.1 (loopback) and Docker cannot
    // forward the port to the macOS host.
    host: '0.0.0.0',
    // 5174 — worktree dev server. 5173 is reserved for the main-branch
    // frontend so both can run side-by-side without conflicting.
    port: 5174,

    // macOS Docker bind mounts don't support inotify. Without polling Vite
    // never sees file changes and HMR silently stops working.
    watch: {
      usePolling: true,
      interval: 300,
    },

    // Tell the HMR client (in the browser) to connect to localhost, not the
    // container's internal hostname. The browser lives on the host and reaches
    // the dev server via the Docker-forwarded port.
    hmr: {
      host: 'localhost',
      port: 5174,
    },

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
})