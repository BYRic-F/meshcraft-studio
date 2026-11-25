import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'backups/**', 'tests/eval/**'],
    fileParallelism: false,
    testTimeout: 35000,
    hookTimeout: 35000,
  },
});
