import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/eval/clinical-eval.ts'],
    exclude: [...configDefaults.exclude, 'backups/**'],
    fileParallelism: false,
    testTimeout: 120000,
    hookTimeout: 60000,
  },
});

