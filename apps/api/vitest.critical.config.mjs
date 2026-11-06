// The fast suites behind the critical mutation scope (stryker.critical.config.mjs): unit specs plus the
// inventory service's own PGlite suite. Kept as its own config, not Stryker's `testFiles` option, because
// with `testFiles` StrykerJS 10.1 activates static mutants (the transition tables) after import, so they
// can never be killed.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    include: ['src/**/*.spec.ts', 'test/integration/inventory.int.spec.ts'],
  },
});
