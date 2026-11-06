import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Memory is tight on dev machines and CI runners (same knob as apps/api).
const maxWorkers = Number(process.env.VITEST_MAX_WORKERS ?? 2);

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    // Logic tests run in node; component tests opt into jsdom with a `@vitest-environment jsdom` docblock.
    environment: 'node',
    maxWorkers,
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
    unstubGlobals: true,
  },
});
