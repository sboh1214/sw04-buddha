import { randomInt } from 'node:crypto';
import { phoneSchema } from '@buddha/shared';
import { ZodError } from 'zod';
import { phoneHash } from './phone-hash.js';

/**
 * The operator's side of the keyed hash (#70, owner decision 2026-10-18, ADR-0071): what the
 * phone-hash CLI (phone-hash-cli.ts) prints, kept apart from its stdin and process handling so it
 * is tested. An operator who changes a member's number by hand (ADR-0069 #57-3) records the new
 * number as one that received the start Coin, and SQL cannot compute the hash without the key —
 * so the CLI does it inside the api container, with the deployment's PHONE_HASH_KEY, and prints
 * the hash only, never the key (docs/OPERATIONS.md). The same CLI picks the confirmation code
 * the operator texts to the new number before changing it (`--code`, ADR-0071 7-29), and hashes
 * the account's old number for the same change (`--psql-old`): the likes the account inherited
 * from a withdrawn account on that number go with it to the new one (#49, owner decision
 * 2026-10-21, ADR-0076), and so do the write-limit and link records of the last 24 hours under
 * that number (#187, owner decision 2026-10-22, ADR-0083).
 */

export const PHONE_HASH_CLI_USAGE =
  'usage: phone-hash-cli.js [--psql | --psql-old] — mobile numbers on stdin, one per line; ' +
  'phone-hash-cli.js --code — one 6-digit confirmation code';

/**
 * - `hash`: one line per number, its hash (64 lower-case hex) — the stable value of `phoneHash`;
 * - `psql`: for the first number only, the two psql lines docs/OPERATIONS.md pastes before its
 *   SQL — `\set new_phone` and `\set new_hash` from the one typed number, so the number changed
 *   and the number recorded cannot differ;
 * - `psql-old`: the same for the account's number before the change — `\set old_phone` and
 *   `\set old_hash` from the one typed number, so the number the change's UPDATE checks the
 *   account still holds and the hash the likes it inherited and the records it moves carry cannot
 *   differ (owner decisions 2026-10-21, ADR-0076, and 2026-10-22, ADR-0083).
 */
export type PhoneHashCliFormat = 'hash' | 'psql' | 'psql-old';

/**
 * What the CLI does: hash the numbers typed (`hash` or `psql`), or `code` — read nothing, use no
 * key, print one confirmation code (`operatorConfirmationCode`).
 */
export type PhoneHashCliMode = PhoneHashCliFormat | 'code';

/**
 * The CLI's arguments: none, `--psql`, `--psql-old` or `--code`. Null for anything else (a usage
 * error).
 */
export function phoneHashCliMode(argv: readonly string[]): PhoneHashCliMode | null {
  if (argv.length === 0) return 'hash';
  if (argv.length === 1 && argv[0] === '--psql') return 'psql';
  if (argv.length === 1 && argv[0] === '--psql-old') return 'psql-old';
  if (argv.length === 1 && argv[0] === '--code') return 'code';
  return null;
}

/**
 * The 6-digit code step 1 of docs/OPERATIONS.md texts to the new number, which the member sends
 * back from the account's email (owner decisions 2026-10-19 3차, answer 1, and 4차, answer 2):
 * leading zeros kept, every one of the 10^6 codes equally likely, drawn from node:crypto's CSPRNG.
 * It is the only proof that the requester holds the new number, so it must not be predictable —
 * not PostgreSQL's `random()`, which is no CSPRNG (Codex review, ADR-0071 7-29). `draw` is
 * `randomInt(min, max)` (max exclusive); the tests pass their own.
 */
export function operatorConfirmationCode(
  draw: (min: number, max: number) => number = (min, max) => randomInt(min, max),
): string {
  return String(draw(0, 1_000_000)).padStart(6, '0');
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
  if (format === 'hash') return { ok: true, lines: [hash] };
  const which = format === 'psql' ? 'new' : 'old';
  return {
    ok: true,
    lines: [`\\set ${which}_phone '${parsed.data}'`, `\\set ${which}_hash '${hash}'`],
  };
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
