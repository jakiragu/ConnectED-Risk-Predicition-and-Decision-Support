import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const appSource = fileURLToPath(new URL('../../src', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  envDir: repoRoot,
  plugins: [react()],
  resolve: { alias: { '/src': appSource } },
  server: { port: 5173 },
  optimizeDeps: { include: ['@gradebook/domain/assessment', '@gradebook/domain/score', '@gradebook/domain/conflict', '@gradebook/domain/ids', '@gradebook/domain/results', '@gradebook/domain/calendar', '@gradebook/domain/attendance', '@gradebook/domain/explanations', '@gradebook/domain/targets', '@gradebook/domain/decision'] },
});
