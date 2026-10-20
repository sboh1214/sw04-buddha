/**
 * The one check point of public profile item writes (#41, ADR-0069 decision 3 #37-9 and decision
 * 7), with the sanction lookup stubbed: no writing restriction (#185) or account restriction
 * (#139) exists yet, so the stub stands for them. And the onboarding those writes need (owner
 * decision 2026-10-21 answer 2), with its check stubbed. Pure: no database.
 */
import { type Db } from '@buddha/db';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../common/errors/app-error.js';
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

describe('assertPublicItemEdit', () => {
  it('refuses a new value under a sanction, with a 403 that names no field', async () => {
    const sanctioned = vi.fn<SanctionCheck>(() => Promise.resolve(true));
    const refusal = await assertPublicItemEdit(executor, 'u1', 'replace', sanctioned).catch(
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(AppError);
    expect(refusal).toMatchObject({ code: 'FORBIDDEN', status: 403, details: undefined });
    // Asked about the account the write is for, inside the caller's executor.
    expect(sanctioned).toHaveBeenCalledWith(executor, 'u1');
  });

  it('lets a clearing through whatever the sanction, without asking (decision 7)', async () => {
    const sanctioned = vi.fn<SanctionCheck>(() => Promise.resolve(true));
    await expect(assertPublicItemEdit(executor, 'u1', 'clear', sanctioned)).resolves.toBe(
      undefined,
    );
    expect(sanctioned).not.toHaveBeenCalled();
  });

  it('lets the onboarding’s first choice through whatever the sanction, without asking (answer 4)', async () => {
    const sanctioned = vi.fn<SanctionCheck>(() => Promise.resolve(true));
    await expect(assertPublicItemEdit(executor, 'u1', 'first', sanctioned)).resolves.toBe(
      undefined,
    );
    expect(sanctioned).not.toHaveBeenCalled();
  });

  it('lets a new value through when no sanction is in force', async () => {
    const sanctioned = vi.fn<SanctionCheck>(() => Promise.resolve(false));
    await expect(assertPublicItemEdit(executor, 'u1', 'replace', sanctioned)).resolves.toBe(
      undefined,
    );
    expect(sanctioned).toHaveBeenCalledOnce();
  });

  it('finds no sanction today: neither #185 nor #139 exists yet', async () => {
    await expect(sanctionInForce(executor, 'u1')).resolves.toBe(false);
    await expect(assertPublicItemEdit(executor, 'u1', 'replace')).resolves.toBe(undefined);
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
