import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/**/*.{test,spec}.js', 'src/**/*.{test,spec}.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.js'],
      exclude: ['lib/**', 'tests/**']
    },
    setupFiles: ['./tests/setup.js']
  },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: 'src/main.js',
      formats: ['es'],
      fileName: () => 'main.js',
    },
    rollupOptions: {
      external: [],
    },
  },
});
