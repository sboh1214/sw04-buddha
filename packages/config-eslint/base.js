// Shared ESLint base config: type-aware TypeScript + Node globals + Prettier compatibility.
// Consumers call base({ tsconfigRootDir: import.meta.dirname }) from their eslint.config.mjs.
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier/flat';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export const commonIgnores = globalIgnores(
  ['**/dist/**', '**/coverage/**', '**/.turbo/**', '**/node_modules/**'],
  'buddha/ignores',
);

/**
 * @param {{ tsconfigRootDir: string }} options
 *   tsconfigRootDir must be the directory of the consuming eslint.config.mjs (`import.meta.dirname`).
 *   It cannot be inferred here: typescript-eslint only auto-detects it from files named eslint.config.*.
 */
export function base({ tsconfigRootDir }) {
  return defineConfig([
    commonIgnores,
    {
      name: 'buddha/typescript',
      files: [tseslint.globs.ts],
      extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
      languageOptions: {
        globals: { ...globals.node },
        parserOptions: { projectService: true, tsconfigRootDir },
      },
      rules: {
        '@typescript-eslint/no-unused-vars': [
          'error',
          { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
        ],
        '@typescript-eslint/consistent-type-imports': [
          'error',
          { fixStyle: 'inline-type-imports' },
        ],
      },
    },
    {
      // *.config.ts files at a package root are usually outside tsconfig "include";
      // lint them without type information instead of failing with a project-service error.
      name: 'buddha/config-files',
      files: ['*.config.{ts,mts,cts}'],
      extends: [tseslint.configs.disableTypeChecked],
    },
    {
      name: 'buddha/javascript',
      files: [tseslint.globs.js],
      extends: [js.configs.recommended],
      languageOptions: { globals: { ...globals.node } },
    },
    prettier,
  ]);
}
