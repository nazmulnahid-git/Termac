import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  base: './',
  plugins: [
    react(),
    {
      // React Fast Refresh injects an inline preamble in dev only.
      name: 'dev-csp',
      transformIndexHtml: (html, ctx) => (ctx.server ? html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'") : html),
    },
  ],
  // Tauri serves the dev build to WKWebView; keep the port fixed for tauri.conf.json.
  server: { port: 5173, strictPort: true },
  clearScreen: false,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'safari16',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: { main: resolve(import.meta.dirname, 'index.html'), quick: resolve(import.meta.dirname, 'quick.html') },
    },
  },
});
