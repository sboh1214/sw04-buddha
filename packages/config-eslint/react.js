// Shared ESLint config for React code (apps/web, apps/mobile): base + react-hooks.
// eslint-plugin-react-hooks 7 `flat.recommended` = rules-of-hooks + exhaustive-deps + React Compiler rules.
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import { base } from './base.js';

export function react(options) {
  return defineConfig([
    ...base(options),
    {
      name: 'buddha/react',
      files: ['**/*.{js,jsx,ts,tsx}'],
      extends: [reactHooks.configs.flat.recommended],
      languageOptions: { globals: { ...globals.browser } },
    },
  ]);
}
