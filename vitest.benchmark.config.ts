import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/eval/audit-loop-benchmark.ts'],
    exclude: [...configDefaults.exclude, 'backups/**'],
    fileParallelism: false,
    testTimeout: 240000,
    hookTimeout: 60000,
  },
});
