import { defineConfig } from 'vite';
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: 'src/main.js',
      formats: ['es'],
      fileName: () => 'main.js',
    },
    rollupOptions: { external: [] },
  },
});
