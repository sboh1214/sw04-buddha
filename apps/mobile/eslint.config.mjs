import { react } from '@buddha/config-eslint/react';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores(['.expo/**', 'android/**', 'ios/**', 'dist/**', 'expo-env.d.ts'], 'mobile/ignores'),
  ...react({ tsconfigRootDir: import.meta.dirname }),
]);
