/**
 * The keyed hash of a verified number (ADR-0071). Pure: no database, no Redis. The fixed vector is
 * the point: a stored hash only recognises its number while the function stays exactly as it is,
 * so a change here (another message, encoding or algorithm) must fail this before it reaches a
 * deployment that holds hashes.
 */
import { type ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { DEV_PHONE_HASH_KEY, type Env } from '../config/env.js';
import { PhoneHasher, phoneHash } from './phone-hash.js';

const KEY = 'unit-test-phone-hash-key';

function hasher(env: Partial<Env>): PhoneHasher {
  const config = { get: (key: keyof Env) => env[key] } as unknown as ConfigService<Env, true>;
  return new PhoneHasher(config);
}

describe('phoneHash', () => {
  it('is HMAC-SHA256 of the digits under the key, in lower-case hex (a fixed vector)', () => {
    // `printf %s 01012345678 | openssl dgst -sha256 -hmac unit-test-phone-hash-key`
    expect(phoneHash(KEY, '01012345678')).toBe(
      '6485241c25ac0bbfd259ecbd6fc7940a38d3e27d9558f849941da0850a6d4d69',
    );
  });

  it('is one value per number and key, and another for another number or key', () => {
    const hash = phoneHash(KEY, '01012345678');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(phoneHash(KEY, '01012345678')).toBe(hash);
    expect(phoneHash(KEY, '01012345679')).not.toBe(hash);
    expect(phoneHash(`${KEY}-rotated`, '01012345678')).not.toBe(hash);
    // Not a plain SHA-256 of the number, which anyone could reverse by trying every number.
    expect(hash).not.toContain('01012345678');
  });

  it('takes the stored digits only, so no spelling of a number is a second identity', () => {
    for (const phone of ['010-1234-5678', '010 1234 5678', ' 01012345678', '0212345678', '']) {
      expect(() => phoneHash(KEY, phone), JSON.stringify(phone)).toThrow(/digits/);
    }
  });
});

describe('PhoneHasher', () => {
  it('hashes with PHONE_HASH_KEY, or the development key outside production', () => {
    expect(hasher({ NODE_ENV: 'production', PHONE_HASH_KEY: KEY }).hash('01012345678')).toBe(
      phoneHash(KEY, '01012345678'),
    );
    expect(hasher({ NODE_ENV: 'test' }).hash('01012345678')).toBe(
      phoneHash(DEV_PHONE_HASH_KEY, '01012345678'),
    );
    expect(() => hasher({ NODE_ENV: 'production' })).toThrow(/PHONE_HASH_KEY/);
  });
});
