import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// In dev, /api is proxied to Laravel so the browser talks to one origin,
// exactly like the nginx setup in production. No CORS configuration needed.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': process.env.VITE_API_PROXY ?? 'http://localhost:8000',
    },
  },
  test: {
    environment: 'jsdom',
    restoreMocks: true,
  },
})
