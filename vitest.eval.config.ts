import { loadEnv } from 'vite';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => ({
  test: {
    include: ['tests/eval/clinical-vignettes.eval.ts'],
    exclude: [...configDefaults.exclude, 'backups/**'],
    env: loadEnv(mode || 'development', process.cwd(), ''),
    fileParallelism: false,
    testTimeout: 60000,
    hookTimeout: 60000,
  },
}));
