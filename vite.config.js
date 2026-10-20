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
  server: { port: 5173, strictPort: true },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome130',
    rollupOptions: {
      input: { main: resolve(import.meta.dirname, 'index.html'), quick: resolve(import.meta.dirname, 'quick.html') },
    },
  },
});
