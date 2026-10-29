import { defineConfig } from 'vite';

/**
 * Extension pages — ES module builds (Round 3):
 *   src entry        → dist output
 *   sidepanel.js     → dist/sidepanel.js   (sidepanel.html, type="module")
 *   options.js       → dist/options.js     (options.html, type="module")
 * Both import canonical src/services/* + src/utils/* directly; the
 * globalThis.LiveTranslateShared indirection is gone for these pages.
 */
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    rollupOptions: {
      input: {
        sidepanel: 'sidepanel.js',
        options: 'options.js',
      },
      output: {
        format: 'es',
        // Deterministic names so manifest/HTML references stay stable.
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name].js',
      },
    },
  },
});
