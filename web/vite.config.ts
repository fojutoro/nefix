import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Development runs two processes: Vite on 5173 and the Go server on 8080.
// Proxying /api and /health means the browser sees a single origin, so session
// cookies are sent and stored without the server needing any CORS handling.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8080',
      '/health': 'http://127.0.0.1:8080',
    },
  },
})
