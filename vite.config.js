import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The app is served from https://guatermelon.com/smashcards/, so every asset
 * URL has to carry that prefix. Build output goes to dist/ for upload.
 */
export default defineConfig({
  base: '/smashcards/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    // 5173 by default, but PORT can override it when that port is taken.
    port: Number(process.env.PORT) || 5173,

    /**
     * Proxy API calls to production during development.
     *
     * The browser then sees same-origin requests, exactly as in production, so
     * local dev does not depend on the dev port appearing in the API's CORS
     * allow-list — and works on whatever port Vite ends up using.
     */
    proxy: {
      '/smashcards/api': {
        target: 'https://guatermelon.com',
        changeOrigin: true,
        secure: true,
      },
    },
  },
});
