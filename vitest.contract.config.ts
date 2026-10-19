import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** Live, read-only contract tests against UAT. Needs FERRY_UAT_API_KEY. */
export default defineConfig({
  resolve: {
    alias: { '@ferryvn/sdk': fileURLToPath(new URL('./packages/sdk/src/index.ts', import.meta.url)) },
  },
  test: {
    include: ['contract/**/*.contract.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
