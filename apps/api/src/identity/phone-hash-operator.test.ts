/**
 * The operator's phone-hash CLI (docs/OPERATIONS.md, owner decision 2026-10-18, ADR-0071): what
 * it prints for what is typed, that it never prints the key or a secret of the environment, and
 * the confirmation code it picks (`--code`, ADR-0071 7-29). Pure: the entry (phone-hash-cli.ts)
 * only wires these to stdin, stdout and `loadEnv`.
 */
import * as crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { envSchema } from '../config/env.js';
import { phoneHash } from './phone-hash.js';
import {
  describeEnvError,
  operatorConfirmationCode,
  phoneHashCliLine,
  phoneHashCliMode,
} from './phone-hash-operator.js';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof crypto>();
  return { ...actual, randomInt: vi.fn(actual.randomInt) };
});

afterEach(() => {
  vi.mocked(crypto.randomInt).mockClear();
});

const KEY = 'operator-test-phone-hash-key-0123456789';

describe('phoneHashCliMode', () => {
  it('takes no argument (a hash per line), --psql, --psql-old or --code, and nothing else', () => {
    expect(phoneHashCliMode([])).toBe('hash');
    expect(phoneHashCliMode(['--psql'])).toBe('psql');
    expect(phoneHashCliMode(['--psql-old'])).toBe('psql-old');
    expect(phoneHashCliMode(['--code'])).toBe('code');
    // Not a number on the command line: it would stay in the shell history.
    for (const argv of [
      ['01012345678'],
      ['--psql', '01012345678'],
      ['--psql-old', '01012345678'],
      ['--psql', '--psql-old'],
      ['--old'],
      ['--code', '--psql'],
      ['--code', '6'],
      ['--key'],
      ['-p'],
    ]) {
      expect(phoneHashCliMode(argv), argv.join(' ')).toBeNull();
    }
  });
});

describe('operatorConfirmationCode', () => {
  it('is six digits, leading zeros kept, over the whole range', () => {
    expect(operatorConfirmationCode(() => 0)).toBe('000000');
    expect(operatorConfirmationCode(() => 42)).toBe('000042');
    expect(operatorConfirmationCode((_min, max) => max - 1)).toBe('999999');
    const draw = vi.fn((min: number) => min);
    operatorConfirmationCode(draw);
    expect(draw).toHaveBeenCalledWith(0, 1_000_000);
  });

  it('draws from node:crypto’s CSPRNG by default, not Math.random', () => {
    // Codex review (ADR-0071 7-29): the code is the only proof the requester holds the new number.
    const random = vi.spyOn(Math, 'random');
    const codes = Array.from({ length: 200 }, () => operatorConfirmationCode());
    for (const code of codes) expect(code).toMatch(/^\d{6}$/);
    // node:crypto's randomInt, asked for the whole range [0, 10^6) every time.
    expect(crypto.randomInt).toHaveBeenCalledTimes(200);
    expect(
      vi.mocked(crypto.randomInt).mock.calls.every(([min, max]) => min === 0 && max === 1_000_000),
    ).toBe(true);
    expect(random).not.toHaveBeenCalled();
    random.mockRestore();
    expect(new Set(codes).size).toBeGreaterThan(150);
  });

  it('pads whatever the CSPRNG returns to six digits', () => {
    for (const value of [0, 7, 99_999, 100_000, 999_999]) {
      vi.mocked(crypto.randomInt).mockImplementationOnce(() => value);
      const code = operatorConfirmationCode();
      expect(code).toMatch(/^\d{6}$/);
      expect(Number(code)).toBe(value);
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

  it('prints the old number’s two psql lines the same way (owner decision 2026-10-21)', () => {
    // The change checks the account still holds `old_phone` and moves the likes it inherited
    // under `old_hash` (ADR-0076): both from the one number typed, so they cannot differ.
    const hash = phoneHash(KEY, '01012345678');
    expect(phoneHashCliLine(KEY, '010 1234 5678', 'psql-old')).toEqual({
      ok: true,
      lines: ["\\set old_phone '01012345678'", `\\set old_hash '${hash}'`],
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
    for (const format of ['hash', 'psql', 'psql-old'] as const) {
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
