import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

let loaded = false;

/**
 * Loads the repo-root `.env` (buddha/.env) into process.env for CLI entry points
 * (migrate/seed). Values already present in process.env are never overridden, and a
 * missing file is not an error (CI and containers inject real env vars instead).
 *
 * Path is resolved relative to this module, so it works from both src/ (tsx) and dist/.
 */
export function loadRootEnv(): void {
  if (loaded) return;
  loaded = true;
  loadEnv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });
}
