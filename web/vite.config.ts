import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Backend origin for dev proxy (REST + WebSocket upgrade)
const API_TARGET = process.env.VITE_API_TARGET || 'http://localhost:4000';

// Vite 5.4 doesn't read __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS itself (Vite 6+),
// so we forward it here as an explicit hostname list — exact hosts only,
// never allowedHosts:true and never a blanket .style.dev pattern.
// The per-VM preview host is supplied per-process via that env var; nothing
// environment-specific is hardcoded in this config.
const previewHosts = (process.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS || '')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3001,
    host: true,
    strictPort: true,
    // Allowed preview host is supplied per-process via the env var above
    ...(previewHosts.length > 0 ? { allowedHosts: previewHosts } : {}),    proxy: {
      // changeOrigin: false (default) — the API must see the original Host so its
      // same-origin CSRF guard can match Origin against Host. Vite's own allowedHosts
      // gate already rejects unknown hosts before any proxying happens.
      '/api': { target: API_TARGET },
      '/webhooks': { target: API_TARGET },
      '/uploads': { target: API_TARGET },
      '/ws': { target: API_TARGET, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
});
