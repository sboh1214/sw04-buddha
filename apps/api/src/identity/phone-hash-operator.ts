import { phoneSchema } from '@buddha/shared';
import { ZodError } from 'zod';
import { phoneHash } from './phone-hash.js';

/**
 * The operator's side of the keyed hash (#70, owner decision 2026-10-18, ADR-0071): what the
 * phone-hash CLI (phone-hash-cli.ts) prints, kept apart from its stdin and process handling so it
 * is tested. An operator who changes a member's number by hand (ADR-0069 #57-3) records the new
 * number as one that received the start Coin, and SQL cannot compute the hash without the key —
 * so the CLI does it inside the api container, with the deployment's PHONE_HASH_KEY, and prints
 * the hash only, never the key (docs/OPERATIONS.md).
 */

export const PHONE_HASH_CLI_USAGE =
  'usage: phone-hash-cli.js [--psql] — mobile numbers on stdin, one per line';

/**
 * - `hash`: one line per number, its hash (64 lower-case hex) — the stable value of `phoneHash`;
 * - `psql`: for the first number only, the two psql lines docs/OPERATIONS.md pastes before its
 *   SQL — `\set new_phone` and `\set new_hash` from the one typed number, so the number changed
 *   and the number recorded cannot differ.
 */
export type PhoneHashCliFormat = 'hash' | 'psql';

/** The CLI's arguments: none, or `--psql`. Null for anything else (a usage error). */
export function phoneHashCliFormat(argv: readonly string[]): PhoneHashCliFormat | null {
  if (argv.length === 0) return 'hash';
  if (argv.length === 1 && argv[0] === '--psql') return 'psql';
  return null;
}

export type PhoneHashCliLine = { ok: true; lines: string[] } | { ok: false; error: string };

/**
 * What the CLI prints for one line typed on stdin, hashed with `key`: null for a blank line. The
 * number is read as the 본인확인 screen reads it (`phoneSchema`: spaces and hyphens dropped, a
 * Korean mobile number only), so `010-1234-5678` hashes as `01012345678` does — the digits the
 * stored record was hashed from. A line that is not such a number is refused without being
 * repeated (the error names no input) and nothing is printed for it.
 */
export function phoneHashCliLine(
  key: string,
  line: string,
  format: PhoneHashCliFormat,
): PhoneHashCliLine | null {
  if (line.trim() === '') return null;
  const parsed = phoneSchema.safeParse(line);
  if (!parsed.success) {
    return { ok: false, error: 'not a Korean mobile number (01X, digits with spaces or -)' };
  }
  const hash = phoneHash(key, parsed.data);
  return format === 'hash'
    ? { ok: true, lines: [hash] }
    : { ok: true, lines: [`\\set new_phone '${parsed.data}'`, `\\set new_hash '${hash}'`] };
}

/**
 * Why the environment cannot give the key, for stderr: the variable and the rule only. A ZodError
 * of the API's env schema (`loadEnv`) is reduced to each issue's path and message, which name the
 * variable and never echo its value — PHONE_HASH_KEY and BETTER_AUTH_SECRET stay off the screen
 * whatever is wrong with them.
 */
export function describeEnvError(error: unknown): string[] {
  if (error instanceof ZodError) {
    return error.issues.map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`);
  }
  return [error instanceof Error ? error.message : 'the environment could not be read'];
}
