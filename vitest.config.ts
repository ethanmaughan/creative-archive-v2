import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    // The kill-survival and recovery specs spawn a real daemon and wait on fsync.
    testTimeout: 20_000,
  },
});
