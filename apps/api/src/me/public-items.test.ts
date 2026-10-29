/**
 * The one check point of public profile item writes (#41, ADR-0069 decision 3 #37-9 and decision
 * 7), with the sanction lookup stubbed: the writing restriction (#185) answers it from its records
 * (`writingRestrictionOf`, proven against the database in restrictions.controller.test.ts and
 * public-items-sanctioned.test.ts) and #139's account restriction will; the stub stands for them.
 * The refusal is RESTRICTED carrying the sanction's kind and end (owner decision 2026-10-21 answer
 * 8 on #41, ADR-0082). And the onboarding those writes need (owner decision 2026-10-21 answer 2),
 * with its check stubbed. Pure: no database.
 */
import { type Db } from '@buddha/db';
import { type RestrictedDetails } from '@buddha/shared';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../common/errors/app-error.js';
import { writingRestrictionOf } from '../moderation/restrictions.js';
import { assertOnboarded } from '../onboarding/onboarded.guard.js';
import {
  assertPublicItemEdit,
  assertPublicItemOnboarding,
  sanctionInForce,
  type SanctionCheck,
} from './public-items.js';

vi.mock('../onboarding/onboarded.guard.js', () => ({
  assertOnboarded: vi.fn(() => Promise.resolve()),
}));

/** Never touched: the stubs below answer without it. */
const executor = {} as Db;

const UNTIL: RestrictedDetails = { kind: 'writing', endsAt: '2026-10-25T03:00:00.000Z' };
const NO_END: RestrictedDetails = { kind: 'writing', endsAt: null };

describe('assertPublicItemEdit', () => {
  it('refuses a new value under a sanction with RESTRICTED (403) and its end', async () => {
    for (const sanction of [UNTIL, NO_END]) {
      const sanctioned = vi.fn<SanctionCheck>(() => Promise.resolve(sanction));
      const refusal = await assertPublicItemEdit(executor, 'u1', 'replace', sanctioned).catch(
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(AppError);
      // A code of its own, not the 403 FORBIDDEN of another account's cookie, with the end the
      // screen says «…까지» by (null: 무기한).
      expect(refusal).toMatchObject({ code: 'RESTRICTED', status: 403, details: sanction });
      // Asked about the account the write is for, inside the caller's executor.
      expect(sanctioned).toHaveBeenCalledWith(executor, 'u1');
    }
  });

  it('lets a clearing through whatever the sanction, without asking (decision 7)', async () => {
    const sanctioned = vi.fn<SanctionCheck>(() => Promise.resolve(UNTIL));
    await expect(assertPublicItemEdit(executor, 'u1', 'clear', sanctioned)).resolves.toBe(
      undefined,
    );
    expect(sanctioned).not.toHaveBeenCalled();
  });

  it('lets the onboarding’s first choice through whatever the sanction, without asking (answer 4)', async () => {
    const sanctioned = vi.fn<SanctionCheck>(() => Promise.resolve(NO_END));
    await expect(assertPublicItemEdit(executor, 'u1', 'first', sanctioned)).resolves.toBe(
      undefined,
    );
    expect(sanctioned).not.toHaveBeenCalled();
  });

  it('lets a new value through when no sanction is in force', async () => {
    const sanctioned = vi.fn<SanctionCheck>(() => Promise.resolve(null));
    await expect(assertPublicItemEdit(executor, 'u1', 'replace', sanctioned)).resolves.toBe(
      undefined,
    );
    expect(sanctioned).toHaveBeenCalledOnce();
  });

  it('asks the writing restriction by default (#185)', () => {
    expect(sanctionInForce).toBe(writingRestrictionOf);
  });
});

describe('assertPublicItemOnboarding', () => {
  it('asks the onboarding for a new value and a first choice, in the caller’s executor', async () => {
    const asked = vi.mocked(assertOnboarded);
    asked.mockClear();
    await assertPublicItemOnboarding(executor, 'u1', 'replace');
    await assertPublicItemOnboarding(executor, 'u1', 'first');
    expect(asked.mock.calls).toEqual([
      [executor, 'u1'],
      [executor, 'u1'],
    ]);
  });

  it('lets a clearing through with sign-in only, without asking (answer 2)', async () => {
    const asked = vi.mocked(assertOnboarded);
    asked.mockClear();
    asked.mockRejectedValueOnce(new AppError('ONBOARDING_REQUIRED', { message: 'not done' }));
    await expect(assertPublicItemOnboarding(executor, 'u1', 'clear')).resolves.toBe(undefined);
    expect(asked).not.toHaveBeenCalled();
    // The refusal it would have given is the onboarding's own, passed on unchanged.
    await expect(assertPublicItemOnboarding(executor, 'u1', 'replace')).rejects.toMatchObject({
      code: 'ONBOARDING_REQUIRED',
    });
  });
});
