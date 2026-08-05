import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Development runs two processes: Vite on 5173 and the Go server on 8080.
// Proxying /api and /health means the browser sees a single origin, so session
// cookies are sent and stored without the server needing any CORS handling.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // The app shell is the whole app, and a stale one cannot be told
      // apart from a working one, so a waiting worker is not offered to
      // the user, it just takes over.
      registerType: 'autoUpdate',
      manifest: {
        name: 'nefix — študijné poznámky',
        short_name: 'nefix',
        description: 'Študijné poznámky, ktoré fungujú offline.',
        lang: 'sk',
        display: 'standalone',
        start_url: '/',
        theme_color: '#1b1b1f',
        background_color: '#1b1b1f',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        // IndexedDB is the source of truth. A cached API response would be
        // handed to a client whose local copy is newer, so nothing under
        // /api/ is ever cached or read from the cache. The denylist keeps
        // the navigation fallback from answering an API request with the
        // app shell.
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/api/'),
            handler: 'NetworkOnly',
          },
        ],
        navigateFallbackDenylist: [/^\/api\//, /^\/health$/],
      },
    }),
  ],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8080',
      '/health': 'http://127.0.0.1:8080',
    },
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    // Rendering a component needs a DOM. The db tests run happily under it.
    environment: 'jsdom',
  },
})
