import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/*/src/index.ts', 'packages/sdk/src/generated/**', '**/*.d.ts'],
      reporter: ['text-summary', 'lcov'],
      // Floor just under the 1.0.0 baseline (~80% lines) so coverage cannot silently regress.
      thresholds: { lines: 78, statements: 75, functions: 65, branches: 65 },
    },
  },
});
