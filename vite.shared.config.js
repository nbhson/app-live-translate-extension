import { defineConfig } from 'vite';

/**
 * Shared runtime bundle — classic-script (IIFE) build for sidepanel.html.
 * Exposes `globalThis.LiveTranslateShared` (set by src/shared/entry.js) plus
 * the lib global `LiveTranslateSharedBundle` (default export).
 */
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: 'src/shared/entry.js',
      name: 'LiveTranslateSharedBundle',
      formats: ['iife'],
      fileName: () => 'shared.js',
    },
  },
});
