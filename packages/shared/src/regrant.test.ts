import { describe, expect, it } from 'vitest';
import { expectedAccountBodySchema } from './expected-account.js';
import {
  adminRegrantListQuerySchema,
  adminRegrantPageSchema,
  adminRegrantSchema,
  applyRegrantBodySchema,
  applyRegrantResultSchema,
  REGRANT_REFUSALS,
  regrantNotAllowedDetailsSchema,
  regrantRefusalSchema,
  regrantSchema,
  regrantStatusSchema,
  serializeRegrant,
  serializeRegrantStatus,
  type RegrantStatusRead,
} from './regrant.js';

const id = '3f1a5b6c-1111-4222-8333-444455556666';

const closed: RegrantStatusRead = {
  open: false,
  eligible: false,
  refusals: ['not_ready'],
  amountCoin: null,
  thresholdCoin: null,
  waitHours: null,
  waitUntil: null,
  periodDays: null,
  periodLimit: null,
  periodUsed: null,
  nextPeriodAt: null,
  totalCapCoin: null,
  totalGrantedCoin: null,
  remainingCapCoin: null,
};

describe('제한적 재지급 (#74, ADR-0155)', () => {
  it('names every refusal in the order the server asks them', () => {
    // owner answers 2026-11-21: 12 (준비 중), 8 (계정 제한), #93's hold, 4 (시작 지급), 1 (소진), 2
    // (대기 주문), 7 (미정산 계약), 5 (대기기간·주기·누적 상한).
    expect(REGRANT_REFUSALS).toEqual([
      'not_ready',
      'restricted',
      'held',
      'no_start_grant',
      'not_exhausted',
      'live_orders',
      'unsettled_positions',
      'waiting',
      'period_limit',
      'total_cap',
    ]);
    expect(regrantRefusalSchema.options).toEqual([...REGRANT_REFUSALS]);
    expect(regrantRefusalSchema.safeParse('pending').success).toBe(false);
  });

  it('writes a status out with Coin as decimal strings and times as ISO, nulls kept', () => {
    expect(regrantStatusSchema.parse(serializeRegrantStatus(closed))).toEqual({
      ...closed,
      refusals: ['not_ready'],
    });
    const waiting: RegrantStatusRead = {
      open: true,
      eligible: false,
      refusals: ['waiting', 'period_limit', 'total_cap'],
      amountCoin: 500n,
      thresholdCoin: 0n,
      waitHours: 24,
      waitUntil: new Date('2026-11-22T00:00:00.000Z'),
      periodDays: 30,
      periodLimit: 2,
      periodUsed: 2,
      nextPeriodAt: new Date('2026-12-01T09:30:00.123Z'),
      totalCapCoin: 1_000n,
      totalGrantedCoin: 1_000n,
      remainingCapCoin: 0n,
    };
    const wire = serializeRegrantStatus(waiting);
    expect(wire).toEqual({
      open: true,
      eligible: false,
      refusals: ['waiting', 'period_limit', 'total_cap'],
      amountCoin: '500',
      thresholdCoin: '0',
      waitHours: 24,
      waitUntil: '2026-11-22T00:00:00.000Z',
      periodDays: 30,
      periodLimit: 2,
      periodUsed: 2,
      nextPeriodAt: '2026-12-01T09:30:00.123Z',
      totalCapCoin: '1000',
      totalGrantedCoin: '1000',
      remainingCapCoin: '0',
    });
    expect(regrantStatusSchema.parse(wire)).toEqual(wire);
    // The refusals are copied, never the read's own array.
    expect(wire.refusals).not.toBe(waiting.refusals);
    // REGRANT_NOT_ALLOWED's details are the status itself.
    expect(regrantNotAllowedDetailsSchema).toBe(regrantStatusSchema);
  });

  it('refuses a status that misses a number or names an unknown refusal', () => {
    const wire = serializeRegrantStatus(closed);
    const { amountCoin: _amount, ...missing } = wire;
    expect(regrantStatusSchema.safeParse(missing).success).toBe(false);
    expect(regrantStatusSchema.safeParse({ ...wire, refusals: ['closed'] }).success).toBe(false);
    expect(regrantStatusSchema.safeParse({ ...wire, amountCoin: 500 }).success).toBe(false);
    expect(regrantStatusSchema.safeParse({ ...wire, periodUsed: -1 }).success).toBe(false);
  });

  it('takes the account on screen as the body, and answers the re-grant and whether it replayed', () => {
    expect(applyRegrantBodySchema).toBe(expectedAccountBodySchema);
    expect(applyRegrantBodySchema.parse({ expectedAccountId: 'u-1' })).toEqual({
      expectedAccountId: 'u-1',
    });
    expect(applyRegrantBodySchema.safeParse({}).success).toBe(false);
    const regrant = { id, amountCoin: '500', createdAt: '2026-11-21T00:00:00.000Z' };
    expect(regrantSchema.parse(regrant)).toEqual(regrant);
    // A stored row written out: Coin as a decimal string, the time as ISO; nothing else carried.
    expect(
      serializeRegrant({
        id,
        amountCoin: 500n,
        createdAt: new Date('2026-11-21T00:00:00.000Z'),
        ...{ userId: 'u-1', requestId: 'req-12345678' },
      }),
    ).toEqual(regrant);
    expect(regrantSchema.safeParse({ ...regrant, id: 'not-a-uuid' }).success).toBe(false);
    expect(applyRegrantResultSchema.parse({ regrant, replayed: true })).toEqual({
      regrant,
      replayed: true,
    });
    expect(applyRegrantResultSchema.safeParse({ regrant }).success).toBe(false);
  });

  it('lists the records for admins newest first by a cursor, naming the account', () => {
    const item = {
      id,
      account: { userId: 'u-1', publicId: 'abcdefgh23', nickname: null },
      amountCoin: '500',
      availableBeforeCoin: '0',
      createdAt: '2026-11-21T00:00:00.000Z',
    };
    expect(adminRegrantSchema.parse(item)).toEqual(item);
    expect(
      adminRegrantSchema.safeParse({ ...item, account: { ...item.account, publicId: 'NOPE' } })
        .success,
    ).toBe(false);
    expect(adminRegrantPageSchema.parse({ data: [item], meta: { nextCursor: null } })).toEqual({
      data: [item],
      meta: { nextCursor: null },
    });
    expect(adminRegrantListQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(adminRegrantListQuerySchema.parse({ cursor: 'c', limit: '5' })).toEqual({
      cursor: 'c',
      limit: 5,
    });
  });
});
