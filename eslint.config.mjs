import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.test-dist/**',
      '**/.seed-dist/**',
      '**/.next/**',
      '**/src/generated/**',
      '**/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.mjs'],
    languageOptions: {
      globals: {
        AbortSignal: 'readonly',
        URL: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        process: 'readonly',
      },
    },
  },
  prettier,
);
