import { defineConfig } from 'vitest/config';

// Memory is tight on small machines and CI runners; PGlite instances are ~100 MB each.
const maxWorkers = Number(process.env.VITEST_MAX_WORKERS ?? 4);

export default defineConfig({
  test: {
    environment: 'node',
    maxWorkers,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    projects: [
      { extends: true, test: { name: 'unit', include: ['src/**/*.spec.ts'] } },
      { extends: true, test: { name: 'integration', include: ['test/integration/**/*.spec.ts'] } },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: [
            'test/e2e/**/*.spec.ts',
            'test/contract/**/*.spec.ts',
            'test/negative/**/*.spec.ts',
            'test/regression/**/*.spec.ts',
          ],
        },
      },
      // Growth and scale suites against real services (tests/infra/docker-compose.yml).
      {
        extends: true,
        test: {
          name: 'services',
          include: ['test/services/**/*.spec.ts'],
          setupFiles: ['test/services/load-env.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/modules/**/domain/**', 'src/modules/**/application/**', 'src/shared/**'],
      exclude: ['**/*.spec.ts', '**/index.ts'],
      thresholds: { lines: 85, branches: 80 },
    },
  },
});
