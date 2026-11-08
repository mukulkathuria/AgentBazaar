// Mutation testing, full scope: all domain and application code (nightly in .github/workflows/mutation.yml).
// The critical scope (pricing, quotes, inventory, order state machine) lives in stryker.critical.config.mjs.
// Scores and how to run: docs/testing/quality-gates.md.

// One run takes about 7 hours on a 4-vCPU runner, so the nightly job splits it into shards that run in
// parallel: STRYKER_SHARD lists modules ("orders payments") or module/layer pairs ("agent/domain").
// A shard has no break threshold of its own; scripts/mutation-score.mjs gates the merged score.
const shard = (process.env.STRYKER_SHARD ?? '').split(/\s+/).filter(Boolean);
const scope = shard.length
  ? shard.map((s) => (s.includes('/') ? `src/modules/${s}/**/*.ts` : `src/modules/${s}/{domain,application}/**/*.ts`))
  : ['src/modules/**/{domain,application}/**/*.ts'];

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  // pnpm keeps plugins out of @stryker-mutator/core's own node_modules, so its default glob finds none.
  plugins: [import.meta.resolve('@stryker-mutator/vitest-runner')],
  // forks matches plain `vitest run`; PGlite suites are not tried under worker threads.
  vitest: { configFile: 'vitest.config.ts', related: true, pool: 'forks' },
  mutate: [...scope, '!src/**/*.spec.ts', '!src/**/index.ts'],
  // The in-process suites on PGlite; the real-service `services` project never runs here. The two benchmarks
  // (120 priced conversations, a search latency run) are left out: they assert aggregates, not behaviour, and
  // rerunning them for every mutant they touch cost hours.
  testFiles: [
    'src/**/*.spec.ts',
    'test/integration/**/!(search-benchmark.int).spec.ts',
    'test/e2e/**/!(ai-cost.e2e).spec.ts',
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
  thresholds: { high: 85, low: 70, break: shard.length ? null : 70 },
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
