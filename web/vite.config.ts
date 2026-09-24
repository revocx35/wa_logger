import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    react(),
    {
      // The bundle is always same-origin. Vite's `crossorigin` attribute makes browsers fetch it in CORS
      // mode, which some (e.g. Safari) refuse on a self-signed certificate even after the user accepted
      // the warning — leaving a blank page. Plain same-origin script/style tags avoid that.
      name: 'wa-logger-strip-crossorigin',
      transformIndexHtml: (html) => html.replace(/ crossorigin(="[^"]*")?/g, ''),
    },
  ],
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: false,
    assetsInlineLimit: 0, // never inline assets as data: URLs into JS/CSS
    chunkSizeWarningLimit: 1500,
  },
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:8080', ws: true, changeOrigin: false },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
