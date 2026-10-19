import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Test against SDK sources so a prior build is not required.
    alias: { '@ferryvn/sdk': fileURLToPath(new URL('../sdk/src/index.ts', import.meta.url)) },
  },
  test: {
    name: 'mcp',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
