import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server proxies API + SSE to the Express backend (default :5174).
// Production build is emitted to web/dist and served by Express on one port.
const API_TARGET = process.env.GUI_API_TARGET ?? 'http://localhost:5174';

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.GUI_WEB_PORT ?? 5173),
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
        // SSE: keep the connection streaming, do not buffer.
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => proxyReq.setHeader('Connection', 'keep-alive'));
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
