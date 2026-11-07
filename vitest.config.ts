import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['tests/setup-env.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});