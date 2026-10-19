/**
 * The operator's phone-hash CLI (docs/OPERATIONS.md, owner decision 2026-10-18, ADR-0071): what
 * it prints for what is typed, and that it never prints the key or a secret of the environment.
 * Pure: the entry (phone-hash-cli.ts) only wires these to stdin, stdout and `loadEnv`.
 */
import { describe, expect, it } from 'vitest';
import { envSchema } from '../config/env.js';
import { phoneHash } from './phone-hash.js';
import { describeEnvError, phoneHashCliFormat, phoneHashCliLine } from './phone-hash-operator.js';

const KEY = 'operator-test-phone-hash-key-0123456789';

describe('phoneHashCliFormat', () => {
  it('takes no argument (a hash per line) or --psql, and nothing else', () => {
    expect(phoneHashCliFormat([])).toBe('hash');
    expect(phoneHashCliFormat(['--psql'])).toBe('psql');
    // Not a number on the command line: it would stay in the shell history.
    for (const argv of [['01012345678'], ['--psql', '01012345678'], ['--key'], ['-p']]) {
      expect(phoneHashCliFormat(argv), argv.join(' ')).toBeNull();
    }
  });
});

describe('phoneHashCliLine', () => {
  it('prints the hash of the stored digits, however the number is spelled', () => {
    const hash = phoneHash(KEY, '01012345678');
    for (const line of ['01012345678', '010-1234-5678', ' 010 1234 5678 ']) {
      expect(phoneHashCliLine(KEY, line, 'hash'), line).toEqual({ ok: true, lines: [hash] });
    }
  });

  it('prints the two psql lines of the operations doc from the one number typed', () => {
    const hash = phoneHash(KEY, '01098765432');
    expect(phoneHashCliLine(KEY, '010-9876-5432', 'psql')).toEqual({
      ok: true,
      lines: ["\\set new_phone '01098765432'", `\\set new_hash '${hash}'`],
    });
  });

  it('skips a blank line and refuses what is not a mobile number, without repeating it', () => {
    expect(phoneHashCliLine(KEY, '   ', 'hash')).toBeNull();
    for (const line of ['0212345678', 'abc', "01012345678'; DROP TABLE x; --", '+821012345678']) {
      const result = phoneHashCliLine(KEY, line, 'psql');
      expect(result?.ok, line).toBe(false);
      if (result && !result.ok) expect(result.error).not.toContain(line.trim());
    }
  });

  it('never prints the key', () => {
    for (const format of ['hash', 'psql'] as const) {
      const result = phoneHashCliLine(KEY, '01012345678', format);
      expect(JSON.stringify(result)).not.toContain(KEY);
    }
  });
});

describe('describeEnvError', () => {
  it('names the variable and the rule, never the value', () => {
    const secret = 's'.repeat(40);
    const result = envSchema.safeParse({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://u:p@localhost:5432/buddha',
      REDIS_URL: 'redis://localhost:6379',
      BETTER_AUTH_SECRET: secret,
      // The same value as the session secret: refused, and named only.
      PHONE_HASH_KEY: secret,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const lines = describeEnvError(result.error);
    expect(lines).toEqual([expect.stringMatching(/^PHONE_HASH_KEY: /) as string]);
    expect(lines.join('\n')).not.toContain(secret);
    expect(describeEnvError(new Error('PHONE_HASH_KEY is required in production'))).toEqual([
      'PHONE_HASH_KEY is required in production',
    ]);
  });
});
