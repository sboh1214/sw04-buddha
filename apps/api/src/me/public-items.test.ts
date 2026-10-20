/**
 * The one check point of public profile item writes (#41, ADR-0069 decision 3 #37-9 and decision
 * 7), with the sanction lookup stubbed: no writing restriction (#185) or account restriction
 * (#139) exists yet, so the stub stands for them. Pure: no database.
 */
import { type Db } from '@buddha/db';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../common/errors/app-error.js';
import { assertPublicItemEdit, sanctionInForce, type SanctionCheck } from './public-items.js';

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
