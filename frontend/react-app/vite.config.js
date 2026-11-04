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
  // @gradebook/domain (backend/library) is linked as a workspace and is plain
  // ES modules with no dependencies, so Vite serves it as source. Do not add it
  // to optimizeDeps.include: Vite would then keep a pre-bundled copy in
  // node_modules/.vite that it never refreshes when the library changes, and a
  // page importing a newly added export would fail to load (blank screen).
});
