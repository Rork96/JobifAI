import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    // HMR must point to localhost so the browser (on the Mac host)
    // connects to the forwarded port, not the container's internal IP.
    hmr: {
      host: 'localhost',
      port: 5173,
    },
    watch: {
      // macOS → Docker uses a VM layer that breaks inotify; polling is required.
      usePolling: true,
    },
  },
})
