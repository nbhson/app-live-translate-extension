import { defineConfig } from 'vite';

/**
 * MV3 service worker — ES module build to `dist/background.js`.
 * Imports the canonical, tested src/background/isCapturableTab.js so the
 * worker no longer carries a hand-maintained copy.
 */
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: 'src/background/worker.js',
      formats: ['es'],
      fileName: () => 'background.js',
    },
  },
});
