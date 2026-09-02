// Shared ESLint config for apps/web: react + @next/eslint-plugin-next core-web-vitals.
// `next lint` and eslint-config-next are not used (removed/unnecessary in Next 16).
import { defineConfig, globalIgnores } from 'eslint/config';
import nextPlugin from '@next/eslint-plugin-next';
import { react } from './react.js';

export function next(options) {
  return defineConfig([
    globalIgnores(['.next/**', 'out/**', 'next-env.d.ts'], 'buddha/next-ignores'),
    ...react(options),
    {
      name: 'buddha/next',
      files: ['**/*.{js,jsx,ts,tsx}'],
      extends: [nextPlugin.configs['core-web-vitals']],
    },
  ]);
}
