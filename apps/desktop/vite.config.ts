import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // Tauri serves this in dev and bundles ../dist in release.
  server: { port: 5274, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true, target: 'esnext' },
});
