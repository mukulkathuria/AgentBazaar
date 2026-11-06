// Mutation testing, critical scope (every push and PR in .github/workflows/quality.yml): the pricing domain
// (policy engine, negotiation state machine), quote token signing, inventory and the order state machine.
import full from './stryker.config.mjs';

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  ...full,
  // Fast suites only (see that file), so static mutants such as the transition tables are tested too.
  vitest: { ...full.vitest, configFile: 'vitest.critical.config.mjs' },
  testFiles: [],
  mutate: [
    'src/modules/pricing/domain/**/*.ts',
    'src/shared/crypto/keyring.ts',
    'src/modules/inventory/{domain,application}/**/*.ts',
    'src/modules/orders/domain/**/*.ts',
    '!src/**/*.spec.ts',
  ],
  ignoreStatic: false,
  incrementalFile: 'reports/mutation/critical-incremental.json',
  thresholds: { high: 90, low: 80, break: 80 },
  htmlReporter: { fileName: 'reports/mutation/critical.html' },
  jsonReporter: { fileName: 'reports/mutation/critical.json' },
  clearTextReporter: { reportMutants: true },
};
