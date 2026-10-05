import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const appSource = fileURLToPath(new URL('../../src', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '/src': appSource } },
  server: { port: 5173 },
  optimizeDeps: { include: ['@gradebook/domain/assessment', '@gradebook/domain/score'] },
});