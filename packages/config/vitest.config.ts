import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    // Same gate as the API's domain code (docs/testing/quality-gates.md).
    coverage: { provider: 'v8', include: ['src/**'], exclude: ['**/*.spec.ts'], thresholds: { lines: 85, branches: 80 } },
  },
});
