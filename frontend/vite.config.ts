import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0', // Дозволяє доступ ззовні контейнера
    port: 5173,
    watch: {
      usePolling: true, // Критично для роботи HMR через Docker Volumes на Mac
    },
  },
})