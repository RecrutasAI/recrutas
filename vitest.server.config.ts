import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * Server-side UNIT tests.
 *
 * vite.config.ts scopes vitest to `client/src/**`, so TypeScript tests under
 * test/ were never picked up by any runner — including the résumé
 * role-extraction corpus, which was written as a regression guard and then
 * silently stopped being one.
 *
 * Excluded on purpose:
 *  - `*-integration`, `e2e-*`, `*-api`: need a live database or running server.
 *  - ai-client-retry / job-discovery-v1: Jest suites (`@jest/globals`), which
 *    run under `npm run test:backend`, not vitest.
 *  - ingestion-chunk-salvage, ats-probe-circuit: scripts with a `main()` and
 *    a `process.exit`, not suites.
 *
 *   npm run test:server
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './client/src'),
      '@shared': path.resolve(__dirname, './shared'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      'test/**/*-integration.test.ts',
      'test/e2e-*.test.ts',
      'test/*-api.test.ts',
      'test/ai-client-retry.test.ts',
      'test/job-discovery-v1.test.ts',
      'test/ingestion-chunk-salvage.test.ts',
      'test/ats-probe-circuit.test.ts',
    ],
    environment: 'node',
    globals: true,
  },
});
