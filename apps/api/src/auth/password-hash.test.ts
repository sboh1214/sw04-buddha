import { hashPassword, verifyPassword } from 'better-auth/crypto';
import { describe, expect, it } from 'vitest';

/**
 * Every stored password is a better-auth scrypt hash, `<salt hex>:<key hex>` (the seed writes them
 * with `hashPassword` too, ADR-0021). An upgrade that changed the parameters would lock every
 * existing account out while CI stayed green — CI only verifies hashes the same version just made.
 * This one was made by better-auth 1.7.7 (@better-auth/utils 0.4.2) on 2026-11-20, before the
 * upgrade to 1.7.26 (ADR-0151); the installed version must still accept it.
 */
const HASH_FROM_1_7_7 =
  'fe3c5e2fdefba13938c361bd113bf4b8:7105417a23b8b8e2a77c402ef57e2d44375dc9a489950b57a5477ea8483465622f67277c9a56c505d31dd308117d386e80fac9c09ed12348bdfa6895a151dfce';

describe('a password hash from an earlier better-auth', () => {
  it('still verifies, and only for its own password', async () => {
    await expect(
      verifyPassword({ hash: HASH_FROM_1_7_7, password: 'fixture-password-1234' }),
    ).resolves.toBe(true);
    await expect(
      verifyPassword({ hash: HASH_FROM_1_7_7, password: 'fixture-password-1235' }),
    ).resolves.toBe(false);
  });

  it('is in the shape the installed version writes', async () => {
    const fresh = await hashPassword('fixture-password-1234');
    expect(fresh).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    expect(HASH_FROM_1_7_7).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
  });
});
