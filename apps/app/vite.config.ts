import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    port: 5173,
    // The API sets an httpOnly session cookie, so the SPA talks to it through
    // the dev server's own origin — no CORS, no SameSite surprises.
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
      '/r': { target: 'http://localhost:4000', changeOrigin: true },
    },
  },
});
