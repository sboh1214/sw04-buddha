import { describe, expect, it } from 'vitest';
import {
  ADMIN_GRANT_REFUSALS,
  ADMIN_REVOKE_REFUSALS,
  ADMIN_ROLE_CHANGE_TYPES,
  ADMIN_ROLE_REASON_MAX_LENGTH,
  MIN_ADMINS,
  adminGrantBodySchema,
  adminRevokeBodySchema,
  adminRoleChangeListQuerySchema,
} from './admin-accounts.js';
import { APPROVAL_KIND_PATTERN, APPROVAL_REFUSALS, approvalReasonSchema } from './approvals.js';
import { ADMIN_ACTION_TYPES } from './enums.js';

describe('admin accounts (#171)', () => {
  it('keeps two admins at least', () => {
    expect(MIN_ADMINS).toBe(2);
  });

  it('records grants and revokes as admin_actions types', () => {
    for (const type of ADMIN_ROLE_CHANGE_TYPES) expect(ADMIN_ACTION_TYPES).toContain(type);
  });

  it('requires a non-blank reason within the limit, trimmed, and the account on screen', () => {
    const me = { expectedAccountId: 'a1' };
    expect(adminGrantBodySchema.parse({ userId: 'u1', reason: '  운영 인원  ', ...me })).toEqual({
      userId: 'u1',
      reason: '운영 인원',
      expectedAccountId: 'a1',
    });
    for (const body of [
      { userId: 'u1', ...me },
      { userId: 'u1', reason: '   ', ...me },
      { userId: '', reason: '사유', ...me },
      { userId: 'u1', reason: 'x'.repeat(ADMIN_ROLE_REASON_MAX_LENGTH + 1), ...me },
      { userId: 'u1', reason: '사유' },
      { userId: 'u1', reason: '사유', expectedAccountId: '' },
    ]) {
      expect(adminGrantBodySchema.safeParse(body).success).toBe(false);
    }
    for (const body of [
      {},
      me,
      { reason: '담당 종료' },
      { reason: '담당 종료', expectedAccountId: '' },
    ]) {
      expect(adminRevokeBodySchema.safeParse(body).success).toBe(false);
    }
    expect(adminRevokeBodySchema.parse({ reason: ' 담당 종료 ', ...me })).toEqual({
      reason: '담당 종료',
      expectedAccountId: 'a1',
    });
  });

  it('pages the history, of one account when asked', () => {
    expect(adminRoleChangeListQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(adminRoleChangeListQuerySchema.parse({ userId: 'u1', limit: '5' })).toEqual({
      userId: 'u1',
      limit: 5,
    });
  });

  it('names each refusal once, so a screen can pick its copy by it', () => {
    const all = [...ADMIN_GRANT_REFUSALS, ...ADMIN_REVOKE_REFUSALS];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('two-person rule (#171)', () => {
  it('requires a non-blank reason for a request and a decision', () => {
    expect(approvalReasonSchema.parse(' 확인 ')).toBe('확인');
    expect(approvalReasonSchema.safeParse('  ').success).toBe(false);
  });

  it('names kinds like the other varchar types, and the refusals', () => {
    expect(APPROVAL_KIND_PATTERN.test('market_open')).toBe(true);
    expect(APPROVAL_KIND_PATTERN.test('Market Open')).toBe(false);
    expect(APPROVAL_REFUSALS).toEqual(['requester', 'decided', 'retracted', 'not_requester']);
  });
});
