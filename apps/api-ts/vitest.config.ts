import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Test files share one Postgres database and truncate it, so they must not run concurrently.
    fileParallelism: false,
  },
});
