// Mutation testing, full scope: all domain and application code (nightly in .github/workflows/quality.yml).
// The critical scope (pricing, quotes, inventory, order state machine) lives in stryker.critical.config.mjs.
// Scores and how to run: docs/testing/quality-gates.md.

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  // pnpm keeps plugins out of @stryker-mutator/core's own node_modules, so its default glob finds none.
  plugins: [import.meta.resolve('@stryker-mutator/vitest-runner')],
  // forks matches plain `vitest run`; PGlite suites are not tried under worker threads.
  vitest: { configFile: 'vitest.config.ts', related: true, pool: 'forks' },
  mutate: ['src/modules/**/{domain,application}/**/*.ts', '!src/**/*.spec.ts', '!src/**/index.ts'],
  // The in-process suites on PGlite; the real-service `services` project never runs here.
  testFiles: [
    'src/**/*.spec.ts',
    'test/integration/**/*.spec.ts',
    'test/e2e/**/*.spec.ts',
    'test/contract/**/*.spec.ts',
    'test/negative/**/*.spec.ts',
    'test/regression/**/*.spec.ts',
  ],
  // A static mutant (module-level tables, word lists) can't be traced to tests, so Stryker would rerun every
  // suite, app boots included, once per mutant. Mutants also hit inside tests still run against those tests.
  ignoreStatic: true,
  concurrency: 2,
  incremental: true,
  incrementalFile: 'reports/mutation/full-incremental.json',
  thresholds: { high: 85, low: 70, break: 70 },
  reporters: ['clear-text', 'progress', 'html', 'json'],
  htmlReporter: { fileName: 'reports/mutation/full.html' },
  jsonReporter: { fileName: 'reports/mutation/full.json' },
  // Thousands of mutants: the console keeps the score table; survivors are in the HTML and JSON reports.
  clearTextReporter: { reportMutants: false },
  // App boots and migrations run outside the measured test time, so give each mutant room.
  timeoutMS: 30_000,
  dryRunTimeoutMinutes: 60,
  // Leftover sandboxes would otherwise be picked up by `eslint .` after an interrupted run.
  cleanTempDir: 'always',
};
