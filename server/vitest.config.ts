import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    env: { NODE_ENV: 'test', LLM_PROVIDER: 'mock' },
    fileParallelism: false,
  },
});
