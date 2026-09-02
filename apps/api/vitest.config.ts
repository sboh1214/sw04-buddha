import { defineConfig } from 'vitest/config';

// Decorator support: Vite 8 (oxc) reads `experimentalDecorators` and
// `emitDecoratorMetadata` from tsconfig.json, so no SWC plugin is needed.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    passWithNoTests: true,
  },
});
