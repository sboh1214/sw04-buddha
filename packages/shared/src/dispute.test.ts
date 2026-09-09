import { describe, expect, it } from 'vitest';
import { DISPUTE_ADMIN_NOTE_MAX, DISPUTE_REASON_MAX } from './constants.js';
import {
  adminDisputeSchema,
  adminDisputesQuerySchema,
  createDisputeBodySchema,
  disputeSchema,
  myDisputesQuerySchema,
  reviewDisputeBodySchema,
} from './dispute.js';

const marketId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const createdAt = '2026-09-09T00:00:00.000Z';

describe('createDisputeBodySchema', () => {
  it('trims the reason and accepts an optional http(s) evidence url', () => {
    expect(createDisputeBodySchema.parse({ reason: '  출처가 다릅니다  ' })).toEqual({
      reason: '출처가 다릅니다',
    });
    expect(
      createDisputeBodySchema.parse({ reason: 'x', evidenceUrl: 'https://example.com/a' }),
    ).toEqual({ reason: 'x', evidenceUrl: 'https://example.com/a' });
    expect(
      createDisputeBodySchema.parse({ reason: 'x', evidenceUrl: null }).evidenceUrl,
    ).toBeNull();
  });

  it('refuses a blank or over-long reason and a non-http url', () => {
    for (const body of [
      { reason: '' },
      { reason: '   ' },
      { reason: 'a'.repeat(DISPUTE_REASON_MAX + 1) },
      { reason: 'x', evidenceUrl: 'javascript:alert(1)' },
      { reason: 'x', evidenceUrl: 'ftp://example.com' },
      { reason: 'x', evidenceUrl: `https://example.com/${'a'.repeat(500)}` },
      {},
    ]) {
      expect(createDisputeBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});

describe('reviewDisputeBodySchema', () => {
  it('accepts the two verdicts with an optional trimmed note, never a return to open', () => {
    expect(reviewDisputeBodySchema.parse({ status: 'accepted' })).toEqual({ status: 'accepted' });
    expect(reviewDisputeBodySchema.parse({ status: 'rejected', adminNote: ' 근거 부족 ' })).toEqual(
      { status: 'rejected', adminNote: '근거 부족' },
    );
    expect(reviewDisputeBodySchema.safeParse({ status: 'open' }).success).toBe(false);
    expect(
      reviewDisputeBodySchema.safeParse({
        status: 'accepted',
        adminNote: 'a'.repeat(DISPUTE_ADMIN_NOTE_MAX + 1),
      }).success,
    ).toBe(false);
  });
});

describe('dispute read DTOs', () => {
  const dispute = {
    id: '9c858901-8a57-4791-81fe-4c455b099bc9',
    marketId,
    marketSlug: 'rate-cut-2026',
    marketTitle: '기준금리 인하?',
    marketStatus: 'resolving',
    resolvedResult: 'YES',
    reason: '출처가 다릅니다',
    evidenceUrl: null,
    status: 'open',
    adminNote: null,
    reviewedAt: null,
    createdAt,
  };

  it('parse the own row and the admin row, which adds the filer and the reviewer', () => {
    expect(disputeSchema.parse(dispute)).toEqual(dispute);
    const admin = { ...dispute, userId: 'u1', nickname: '예측가_1', reviewedBy: null };
    expect(adminDisputeSchema.parse(admin)).toEqual(admin);
    // The own DTO never carries another user's identity.
    expect('userId' in disputeSchema.shape).toBe(false);
    expect(disputeSchema.safeParse({ ...dispute, status: 'pending' }).success).toBe(false);
  });
});

describe('dispute query DTOs', () => {
  it('default the page and accept the optional filters, lower-casing the market id', () => {
    expect(myDisputesQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(myDisputesQuerySchema.parse({ marketId: marketId.toUpperCase() }).marketId).toBe(
      marketId,
    );
    expect(adminDisputesQuerySchema.parse({ status: 'open', limit: '5' })).toEqual({
      status: 'open',
      limit: 5,
    });
    expect(adminDisputesQuerySchema.safeParse({ status: 'pending' }).success).toBe(false);
    expect(adminDisputesQuerySchema.safeParse({ marketId: 'nope' }).success).toBe(false);
  });
});
