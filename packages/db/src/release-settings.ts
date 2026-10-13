import {
  readReleaseSetting,
  type ReleaseSettingDefinition,
  type ReleaseSettingReading,
  type ReleaseSettingsRegistry,
  type ReleaseSettingValue,
} from '@buddha/shared';
import { eq, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { releaseSettings } from './schema/release-settings.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * `release_settings.value` for a select list, read as JSON text and parsed here once. node-postgres
 * already parses jsonb, and drizzle's jsonb reader then `JSON.parse`s any STRING it is handed once
 * more — so through the column itself a stored string that is JSON text (`"24"`, `"null"`) would
 * come back as 24 or null. Object values are not affected; a top-level string value is, and an
 * item may well hold one. Every reader of the table selects this, never the bare column.
 */
export const storedReleaseSettingValue = sql<unknown>`${releaseSettings.value}::text`.mapWith(
  (text: string): unknown => JSON.parse(text),
);

/**
 * The one way server code reads a release setting (#170): the stored row of `definition`, through
 * `readReleaseSetting` (@buddha/shared) — so only the very definition object `registry` holds is
 * read, `undecided` comes back with no value and any other status with the value its schema types.
 * apps/api reads through `ReleaseSettingsService.get` (its injected registry), the worker calls
 * this with RELEASE_SETTINGS. A value applies to work started after it changed (owner decision
 * 2026-10-13): read it once when the work begins, inside that work's transaction when it has one.
 * Throws a plain Error for an unregistered definition or a stored value that no longer fits.
 */
export async function getReleaseSetting<T extends ReleaseSettingValue>(
  executor: Db | Tx,
  registry: ReleaseSettingsRegistry,
  definition: ReleaseSettingDefinition<T>,
): Promise<ReleaseSettingReading<T>> {
  const [row] = await executor
    .select({ status: releaseSettings.status, value: storedReleaseSettingValue })
    .from(releaseSettings)
    .where(eq(releaseSettings.key, definition.key))
    .limit(1);
  return readReleaseSetting(registry, definition, row);
}
