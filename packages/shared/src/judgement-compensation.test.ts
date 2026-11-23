import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { APPROVAL_KIND_MAX_LENGTH, APPROVAL_KIND_PATTERN } from './approvals.js';
import { MARKET_RESULTS, type MarketResult, type Outcome } from './enums.js';
import { expectedAccountBodySchema } from './expected-account.js';
import { findExcludedIdentifier } from './guards/excluded.js';
import { findPrivateField } from './guards/private-data.js';
import * as shared from './index.js';
import {
  JUDGEMENT_COMPENSATION_PUBLIC_STATUSES,
  JUDGEMENT_COMPENSATION_RECIPIENT_STATES,
  MARKET_JUDGEMENT_COMPENSATION_APPROVAL_KIND,
  MARKET_JUDGEMENT_COMPENSATION_REFUSALS,
  adminJudgementCompensationRecipientSchema,
  adminMarketJudgementCompensationSchema,
  approveJudgementCompensationBodySchema,
  compareAccountIdsBytewise,
  isJudgementCompensationOwed,
  judgementCompensationOwed,
  judgementCompensationRequestPayload,
  marketJudgementCompensationRequestPayloadSchema,
  publicJudgementCompensationOf,
  publicJudgementCompensationSchema,
  rejectJudgementCompensationBodySchema,
  requestJudgementCompensationBodySchema,
  retractJudgementCompensationBodySchema,
  sameJudgementCompensationRecipients,
  type JudgementCompensationRecord,
} from './judgement-compensation.js';
import {
  MARKET_JUDGEMENT_INCIDENT_APPROVAL_KIND,
  MARKET_JUDGEMENT_INCIDENT_REFUSALS,
  judgementIncidentDecisionRefusal,
} from './market-judgement-incident.js';
import { MARKET_JUDGEMENT_APPROVAL_KIND } from './market-judgement.js';
import { settlementPayoutPerContract } from './market-settlement.js';

const at = '2026-11-23T03:00:00.000Z';
const incidentId = '6c1d2e3f-4a5b-4c6d-9e7f-8091a2b3c4d5';
const requestId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const requester = { id: 'admin-1', nickname: '운영자1' };
const approver = { id: 'admin-2', nickname: null };

const paths = (result: { error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((issue) => issue.path.join('.')) ?? [];

/**
 * The per-contract table of ADR-0166 (144-1), written out apart from
 * `settlementPayoutPerContract`: what one YES and one NO contract gain when `paid` is corrected to
 * `corrected` — the correct result's payout minus the paid one.
 */
const DELTA: Record<string, Record<Outcome, number>> = {
  'YES>NO': { YES: -100, NO: 100 },
  'YES>VOID': { YES: -50, NO: 50 },
  'NO>YES': { YES: 100, NO: -100 },
  'NO>VOID': { YES: 50, NO: -50 },
  'VOID>YES': { YES: 50, NO: -50 },
  'VOID>NO': { YES: -50, NO: 50 },
};

/** The records the paid result wrote for a holding: each outcome's qty and its paid payout. */
function settled(
  paid: MarketResult,
  holding: Partial<Record<Outcome, number>>,
): JudgementCompensationRecord[] {
  return (Object.entries(holding) as [Outcome, number][]).map(([outcome, qty]) => ({
    outcome,
    qty,
    payoutCoin: BigInt(qty) * BigInt(settlementPayoutPerContract(paid, outcome)),
  }));
}

const HOLDINGS = {
  'YES only': { YES: 2 },
  'NO only': { NO: 3 },
  'both sides': { YES: 2, NO: 1 },
} as const satisfies Record<string, Partial<Record<Outcome, number>>>;

describe('the 판정 오류 보상 amount (#144, ADR-0166; 144-1)', () => {
  const pairs = MARKET_RESULTS.flatMap((paid) =>
    MARKET_RESULTS.filter((corrected) => corrected !== paid).map(
      (corrected) => [paid, corrected] as const,
    ),
  );

  it('covers all six paid → corrected pairs, each per-contract delta as the table says', () => {
    expect(pairs.map(([paid, corrected]) => `${paid}>${corrected}`).sort()).toEqual(
      Object.keys(DELTA).sort(),
    );
    for (const [paid, corrected] of pairs) {
      for (const outcome of ['YES', 'NO'] as const) {
        expect(
          judgementCompensationOwed(settled(paid, { [outcome]: 1 }), corrected),
          `${paid}>${corrected} ${outcome}`,
        ).toBe(BigInt(DELTA[`${paid}>${corrected}`]![outcome]));
      }
    }
  });

  it.each(pairs)(
    'nets %s → %s per account: a YES-only, a NO-only and a both-sides holder',
    (paid, corrected) => {
      const delta = DELTA[`${paid}>${corrected}`]!;
      for (const [name, holding] of Object.entries(HOLDINGS)) {
        const expected = (Object.entries(holding) as [Outcome, number][]).reduce(
          (sum, [outcome, qty]) => sum + BigInt(qty * delta[outcome]),
          0n,
        );
        const owed = judgementCompensationOwed(settled(paid, holding), corrected);
        expect(owed, `${paid}>${corrected} ${name}`).toBe(expected);
        expect(isJudgementCompensationOwed(owed)).toBe(expected > 0n);
      }
    },
  );

  it('works the cases: VOID→YES with YES 2 + NO 1 is 50; YES→VOID with YES 1 + NO 1 is none', () => {
    // 2×100 − (2×50 + 1×50) = 50.
    expect(judgementCompensationOwed(settled('VOID', { YES: 2, NO: 1 }), 'YES')).toBe(50n);
    // 100 − 100 = 0: even, not a target.
    const even = judgementCompensationOwed(settled('YES', { YES: 1, NO: 1 }), 'VOID');
    expect(even).toBe(0n);
    expect(isJudgementCompensationOwed(even)).toBe(false);
  });

  it('pays a loser of the paid result (0 paid) the whole correct payout', () => {
    const loser: JudgementCompensationRecord[] = [{ outcome: 'NO', qty: 4, payoutCoin: 0n }];
    expect(judgementCompensationOwed(loser, 'NO')).toBe(400n);
    expect(judgementCompensationOwed(loser, 'VOID')).toBe(200n);
    expect(judgementCompensationOwed(loser, 'YES')).toBe(0n);
    // No records (sold out before the payout, ADR-0118): owed nothing (144-1).
    expect(judgementCompensationOwed([], 'NO')).toBe(0n);
  });

  it('keeps an over-paid account negative — nothing is taken back (N03 §7)', () => {
    const over = judgementCompensationOwed(settled('YES', { YES: 5 }), 'NO');
    expect(over).toBe(-500n);
    expect(isJudgementCompensationOwed(over)).toBe(false);
  });

  it('computes in bigint beyond a double’s exact range', () => {
    const qty = 2n ** 60n;
    const owed = judgementCompensationOwed([{ outcome: 'NO', qty, payoutCoin: 0n }], 'NO');
    expect(owed).toBe(qty * 100n);
    expect(typeof owed).toBe('bigint');
  });

  it('refuses a record with a negative quantity or payout', () => {
    expect(() =>
      judgementCompensationOwed([{ outcome: 'YES', qty: -1, payoutCoin: 0n }], 'YES'),
    ).toThrow(RangeError);
    expect(() =>
      judgementCompensationOwed([{ outcome: 'YES', qty: 1, payoutCoin: -1n }], 'YES'),
    ).toThrow(RangeError);
  });
});

describe('the frozen list (144-2; ADR-0166 T23)', () => {
  it('orders account ids bytewise, as COLLATE "C" does — never by a locale', () => {
    // Upper case sorts before lower case and digits before letters, bytewise; a locale would
    // put 'a' before 'B'.
    const ids = ['b', 'B', 'a', '_x', '9', 'A'];
    expect([...ids].sort(compareAccountIdsBytewise)).toEqual(['9', 'A', 'B', '_x', 'a', 'b']);
    expect(['a', 'B'].sort((x, y) => x.localeCompare(y))).toEqual(['a', 'B']);
    expect(compareAccountIdsBytewise('x', 'x')).toBe(0);
  });

  it('freezes the server’s list sorted, counted and totalled, with the members’ reason', () => {
    const payload = judgementCompensationRequestPayload({
      incidentId,
      correctedResult: 'NO',
      owed: [
        { userId: 'b-user', amountCoin: 100n },
        { userId: 'B-user', amountCoin: 50n },
        { userId: 'a-user', amountCoin: 300n },
      ],
      userReason: '  판정 오류로 덜 받은 몫을 보상합니다.  ',
    });
    expect(payload).toEqual({
      noConflictConfirmed: true,
      incidentId,
      correctedResult: 'NO',
      recipients: [
        { userId: 'B-user', amountCoin: '50' },
        { userId: 'a-user', amountCoin: '300' },
        { userId: 'b-user', amountCoin: '100' },
      ],
      accountCount: 3,
      totalCoin: '450',
      userReason: '판정 오류로 덜 받은 몫을 보상합니다.',
    });
    expect(marketJudgementCompensationRequestPayloadSchema.parse(payload)).toEqual(payload);
  });

  it('refuses to freeze an empty list, a non-positive amount or an account twice', () => {
    const base = { incidentId, correctedResult: 'NO' as const, userReason: '사유' };
    expect(() => judgementCompensationRequestPayload({ ...base, owed: [] })).toThrow(RangeError);
    expect(() =>
      judgementCompensationRequestPayload({ ...base, owed: [{ userId: 'u', amountCoin: 0n }] }),
    ).toThrow(RangeError);
    expect(() =>
      judgementCompensationRequestPayload({
        ...base,
        owed: [
          { userId: 'u', amountCoin: 1n },
          { userId: 'u', amountCoin: 2n },
        ],
      }),
    ).toThrow(RangeError);
  });

  it('reads back only a consistent payload: bytewise order, no repeat, its count and total', () => {
    const good = {
      noConflictConfirmed: true,
      incidentId,
      correctedResult: 'VOID',
      recipients: [
        { userId: 'A', amountCoin: '50' },
        { userId: 'a', amountCoin: '100' },
      ],
      accountCount: 2,
      totalCoin: '150',
      userReason: '사유',
    };
    expect(marketJudgementCompensationRequestPayloadSchema.safeParse(good).success).toBe(true);
    for (const [bad, path] of [
      [{ ...good, recipients: [...good.recipients].reverse() }, 'recipients.1.userId'],
      [
        { ...good, recipients: [good.recipients[0], good.recipients[0]], totalCoin: '100' },
        'recipients.1.userId',
      ],
      [{ ...good, accountCount: 3 }, 'accountCount'],
      [{ ...good, totalCoin: '151' }, 'totalCoin'],
    ] as const) {
      expect(paths(marketJudgementCompensationRequestPayloadSchema.safeParse(bad)), path).toEqual([
        path,
      ]);
    }
    for (const amountCoin of ['0', '-1', '01', '1.5', 100]) {
      expect(
        marketJudgementCompensationRequestPayloadSchema.safeParse({
          ...good,
          recipients: [{ userId: 'A', amountCoin }],
          accountCount: 1,
          totalCoin: '1',
        }).success,
        String(amountCoin),
      ).toBe(false);
    }
    expect(
      marketJudgementCompensationRequestPayloadSchema.safeParse({
        ...good,
        recipients: [],
        accountCount: 0,
        totalCoin: '0',
      }).success,
    ).toBe(false);
    expect(
      marketJudgementCompensationRequestPayloadSchema.safeParse({
        ...good,
        noConflictConfirmed: false,
      }).success,
    ).toBe(false);
  });

  it('compares the frozen list with the re-derived one after a bytewise sort (stale)', () => {
    const frozen = [
      { userId: 'A', amountCoin: '50' },
      { userId: 'a', amountCoin: '100' },
    ];
    expect(
      sameJudgementCompensationRecipients(frozen, [
        { userId: 'a', amountCoin: 100n },
        { userId: 'A', amountCoin: 50n },
      ]),
    ).toBe(true);
    expect(
      sameJudgementCompensationRecipients(frozen, [
        { userId: 'a', amountCoin: 101n },
        { userId: 'A', amountCoin: 50n },
      ]),
    ).toBe(false);
    expect(sameJudgementCompensationRecipients(frozen, [{ userId: 'A', amountCoin: 50n }])).toBe(
      false,
    );
    expect(
      sameJudgementCompensationRecipients(frozen, [
        { userId: 'A', amountCoin: 50n },
        { userId: 'b', amountCoin: 100n },
      ]),
    ).toBe(false);
  });
});

describe('the compensation request and its decisions (#144, ADR-0166)', () => {
  it('names its own approval kind, apart from the judgement’s and the incident’s', () => {
    expect(MARKET_JUDGEMENT_COMPENSATION_APPROVAL_KIND).toBe('market_judgement_compensation');
    expect(APPROVAL_KIND_PATTERN.test(MARKET_JUDGEMENT_COMPENSATION_APPROVAL_KIND)).toBe(true);
    expect(MARKET_JUDGEMENT_COMPENSATION_APPROVAL_KIND.length).toBeLessThanOrEqual(
      APPROVAL_KIND_MAX_LENGTH,
    );
    expect(MARKET_JUDGEMENT_COMPENSATION_APPROVAL_KIND).not.toBe(MARKET_JUDGEMENT_APPROVAL_KIND);
    expect(MARKET_JUDGEMENT_COMPENSATION_APPROVAL_KIND).not.toBe(
      MARKET_JUDGEMENT_INCIDENT_APPROVAL_KIND,
    );
  });

  it('names its refusals apart under each path, 144-16’s blocked and the #93 hold included', () => {
    expect(MARKET_JUDGEMENT_COMPENSATION_REFUSALS).toEqual({
      incident: { missing: 'not confirmed' },
      market: { held: 'held' },
      compensation: { pending: 'pending', paid: 'paid' },
      recipients: { none: 'none', stale: 'stale', blocked: 'blocked' },
      decider: { registrant: 'registrant' },
      requestId: { unknown: 'unknown' },
    });
    for (const [path, messages] of Object.entries(MARKET_JUDGEMENT_COMPENSATION_REFUSALS)) {
      const values = Object.values(messages);
      expect(new Set(values).size, path).toBe(values.length);
    }
    // 144-4 on the approval is the incident's refusal, from the same shared function.
    expect(MARKET_JUDGEMENT_COMPENSATION_REFUSALS.decider.registrant).toBe(
      MARKET_JUDGEMENT_INCIDENT_REFUSALS.decider.registrant,
    );
    expect(judgementIncidentDecisionRefusal('admin-1', 'admin-1')).toBe(
      MARKET_JUDGEMENT_COMPENSATION_REFUSALS.decider.registrant,
    );
  });

  it('takes a request with the two reasons and a fresh conflict confirmation — no account, no amount (144-1, 144-12)', () => {
    const body = {
      reason: '  정정된 결과로 차액 보상  ',
      userReason: '  판정 오류로 덜 받은 몫을 보상합니다.  ',
      noConflictConfirmed: true,
      expectedAccountId: 'admin-1',
      // What the admin cannot give: the server computes the list.
      recipients: [{ userId: 'u', amountCoin: '1000' }],
      amountCoin: '1000',
      totalCoin: '1000',
    };
    expect(requestJudgementCompensationBodySchema.parse(body)).toEqual({
      reason: '정정된 결과로 차액 보상',
      userReason: '판정 오류로 덜 받은 몫을 보상합니다.',
      noConflictConfirmed: true,
      expectedAccountId: 'admin-1',
    });
    for (const noConflictConfirmed of [false, undefined, 'true']) {
      expect(
        paths(requestJudgementCompensationBodySchema.safeParse({ ...body, noConflictConfirmed })),
      ).toEqual(['noConflictConfirmed']);
    }
    for (const key of ['reason', 'userReason'] as const) {
      expect(
        paths(requestJudgementCompensationBodySchema.safeParse({ ...body, [key]: '   ' })),
      ).toEqual([key]);
      expect(
        paths(
          requestJudgementCompensationBodySchema.safeParse({ ...body, [key]: '가'.repeat(501) }),
        ),
      ).toEqual([key]);
      expect(
        requestJudgementCompensationBodySchema.safeParse({ ...body, [key]: '가'.repeat(500) })
          .success,
      ).toBe(true);
    }
  });

  it('approves with a reason and the conflict confirmation; rejects with a reason alone (정리 목적 반려)', () => {
    const approve = { reason: '확인', noConflictConfirmed: true, expectedAccountId: 'admin-2' };
    expect(approveJudgementCompensationBodySchema.parse(approve)).toEqual(approve);
    expect(
      paths(
        approveJudgementCompensationBodySchema.safeParse({
          ...approve,
          noConflictConfirmed: false,
        }),
      ),
    ).toEqual(['noConflictConfirmed']);
    // ADR-0120 decision 5: no conflict box on a 반려; an extra one is dropped.
    expect(
      rejectJudgementCompensationBodySchema.parse({
        reason: ' 사유를 고쳐 주세요 ',
        noConflictConfirmed: true,
        expectedAccountId: 'admin-2',
      }),
    ).toEqual({ reason: '사유를 고쳐 주세요', expectedAccountId: 'admin-2' });
    expect(
      paths(rejectJudgementCompensationBodySchema.safeParse({ expectedAccountId: 'a' })),
    ).toEqual(['reason']);
    expect(retractJudgementCompensationBodySchema).toBe(expectedAccountBodySchema);
  });

  it('stores and answers names no excluded feature reads', () => {
    for (const name of [
      MARKET_JUDGEMENT_COMPENSATION_APPROVAL_KIND,
      ...shared.ADMIN_ACTION_TYPES.filter((type) =>
        type.startsWith('market_judgement_compensation_'),
      ),
      'JUDGEMENT_COMPENSATION',
      'judgement_compensation',
      'judgement_compensations',
      'judgementCompensation',
      'judgement_compensation_owed',
      'market_judgement_compensated',
      'judgement-compensations',
      'recipients',
      'userReason',
      'user_reason',
      'amount_coin',
      'amountCoin',
      'accountCount',
      'paidCount',
      'paidCoin',
      'closedCount',
      'blockedCount',
      'totalCoin',
      'compensationCoin',
      'incident_id',
      'ledger_entry_id',
      'approved_by',
      'approvedBy',
      'approvedAt',
      ...JUDGEMENT_COMPENSATION_RECIPIENT_STATES,
      ...JUDGEMENT_COMPENSATION_PUBLIC_STATUSES,
      'held',
      'preview',
    ]) {
      expect(findExcludedIdentifier(name, 'api'), name).toEqual([]);
      expect(findExcludedIdentifier(name, 'storage'), name).toEqual([]);
    }
  });
});

describe('the admin compensation state (ADR-0166 §6.5)', () => {
  const request = {
    requestId,
    requestedBy: requester,
    requestedAt: at,
    accountCount: 2,
    totalCoin: '150',
    reason: '정정된 결과로 차액 보상',
    userReason: '판정 오류로 덜 받은 몫을 보상합니다.',
  };

  it('shows the preview, the hold, the waiting request, the payout and the log', () => {
    const state = {
      preview: null,
      held: false,
      pending: null,
      paid: {
        ...request,
        approvedBy: approver,
        approvedAt: '2026-11-23T04:00:00.000Z',
        paidCount: 1,
        paidCoin: '100',
        closedCount: 1,
      },
      log: [
        {
          ...request,
          status: 'approved',
          decidedBy: approver,
          decidedAt: '2026-11-23T04:00:00.000Z',
          decisionReason: '확인',
          retractedAt: null,
        },
        {
          ...request,
          requestId: incidentId,
          status: 'rejected',
          decidedBy: approver,
          decidedAt: at,
          decisionReason: '회원 사유를 고쳐 주세요',
          retractedAt: null,
        },
      ],
    };
    expect(adminMarketJudgementCompensationSchema.parse(state)).toEqual(state);
    const waiting = {
      ...state,
      preview: { accountCount: 2, totalCoin: '150', closedCount: 1, blockedCount: 1 },
      held: true,
      pending: request,
      paid: null,
    };
    expect(adminMarketJudgementCompensationSchema.parse(waiting)).toEqual(waiting);
    expect(
      paths(adminMarketJudgementCompensationSchema.safeParse({ ...state, held: undefined })),
    ).toEqual(['held']);
  });

  it('lists each account with its amount and where it stands, the closed one without a nickname', () => {
    expect(JUDGEMENT_COMPENSATION_RECIPIENT_STATES).toEqual([
      'pending',
      'blocked',
      'closed',
      'paid',
    ]);
    for (const state of JUDGEMENT_COMPENSATION_RECIPIENT_STATES) {
      const row = { account: { id: 'u1', nickname: null }, amountCoin: '100', state };
      expect(adminJudgementCompensationRecipientSchema.parse(row)).toEqual(row);
    }
    expect(
      adminJudgementCompensationRecipientSchema.safeParse({
        account: { id: 'u1', nickname: 'a' },
        amountCoin: '100',
        state: 'withdrawn',
      }).success,
    ).toBe(false);
  });
});

describe('the public compensation figures (144-6, 144-15)', () => {
  it('reads paid, then pending, then none, then preparing', () => {
    expect(
      publicJudgementCompensationOf({
        paid: { accountCount: 3, paidCount: 2, paidCoin: 250n },
        pendingAccountCount: null,
        owedCount: 3,
      }),
    ).toEqual({ status: 'paid', accountCount: 3, paidCount: 2, totalCoin: '250' });
    expect(
      publicJudgementCompensationOf({ paid: null, pendingAccountCount: 3, owedCount: 3 }),
    ).toEqual({ status: 'pending', accountCount: 3, paidCount: null, totalCoin: null });
    expect(
      publicJudgementCompensationOf({ paid: null, pendingAccountCount: null, owedCount: 0 }),
    ).toEqual({ status: 'none', accountCount: null, paidCount: null, totalCoin: null });
    expect(
      publicJudgementCompensationOf({ paid: null, pendingAccountCount: null, owedCount: 2 }),
    ).toEqual({ status: 'preparing', accountCount: null, paidCount: null, totalCoin: null });
  });

  it('keeps the 대상 count when every target was closed: paid 0 of n, 0 Coin (144-7, 144-15)', () => {
    const allClosed = publicJudgementCompensationOf({
      paid: { accountCount: 2, paidCount: 0, paidCoin: 0n },
      pendingAccountCount: null,
      owedCount: 2,
    });
    expect(allClosed).toEqual({ status: 'paid', accountCount: 2, paidCount: 0, totalCoin: '0' });
    expect(publicJudgementCompensationSchema.parse(allClosed)).toEqual(allClosed);
  });

  it('publishes counts, the total and the status alone — no account, nickname or reason', () => {
    expect(Object.keys(publicJudgementCompensationSchema.shape).sort()).toEqual([
      'accountCount',
      'paidCount',
      'status',
      'totalCoin',
    ]);
    for (const key of Object.keys(publicJudgementCompensationSchema.shape)) {
      expect(findPrivateField(key), key).toEqual([]);
      expect(findExcludedIdentifier(key, 'api'), key).toEqual([]);
    }
    expect(findPrivateField('compensation')).toEqual([]);
    // One paid account: the total is that account's amount, which 144-6 accepted — still no
    // identity in the shape.
    const one = publicJudgementCompensationSchema.parse({
      status: 'paid',
      accountCount: 1,
      paidCount: 1,
      totalCoin: '100',
      userId: 'private',
      nickname: 'private',
      userReason: 'private',
    });
    expect(JSON.stringify(one)).not.toContain('private');
    expect(publicJudgementCompensationSchema.safeParse({ ...one, status: 'partial' }).success).toBe(
      false,
    );
  });
});

describe('the OpenAPI component ids of the compensation', () => {
  it('are each named once and convert with the admin market and the public detail', () => {
    const ids = new Map<string, number>();
    for (const value of Object.values(shared)) {
      if (!(value instanceof z.ZodType)) continue;
      const id = z.globalRegistry.get(value)?.id;
      if (id !== undefined) ids.set(id, (ids.get(id) ?? 0) + 1);
    }
    for (const id of [
      'RequestJudgementCompensationBody',
      'ApproveJudgementCompensationBody',
      'RejectJudgementCompensationBody',
      'MarketJudgementCompensationPreview',
      'MarketJudgementCompensationPending',
      'MarketJudgementCompensationPaid',
      'MarketJudgementCompensationLogEntry',
      'AdminMarketJudgementCompensation',
      'AdminJudgementCompensationRecipient',
      'PublicJudgementCompensation',
    ]) {
      expect(ids.get(id), id).toBe(1);
    }
    expect(() =>
      z.toJSONSchema(
        z.object({
          market: shared.adminMarketSchema,
          detail: shared.marketSchema,
          request: requestJudgementCompensationBodySchema,
          approve: approveJudgementCompensationBodySchema,
          reject: rejectJudgementCompensationBodySchema,
          recipient: adminJudgementCompensationRecipientSchema,
          entry: shared.ledgerEntrySchema,
        }),
      ),
    ).not.toThrow();
  });
});
