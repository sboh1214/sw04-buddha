import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { type AdminMarket } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import { byTestId, renderWithQueries, testIdsStartingWith } from '@/test/render';
import { MarketJudgementCompensationBody } from './market-judgement-compensation-panel';

const PAID_REGISTRANT = { id: 'paid-registrant', nickname: '판정등록한이' };
const REQUESTER = { id: 'requester', nickname: '요청한이' };
const APPROVER = { id: 'approver', nickname: '승인한이' };
const REQUEST = 'a1b2c3d4-0000-4000-8000-000000000001';
const REJECTED = 'a1b2c3d4-0000-4000-8000-000000000002';

type Compensation = NonNullable<AdminMarket['judgementIncident']['compensation']>;

const pending = {
  requestId: REQUEST,
  requestedBy: REQUESTER,
  requestedAt: '2026-12-01T02:00:00.000Z',
  accountCount: 3,
  totalCoin: '1250',
  reason: '오류 확인된 사건의 보상을 요청합니다.',
  userReason: '1차 출처의 정정 발표에 따라 결과를 바로잡았습니다.',
};

const logEntry = (
  requestId: string,
  status: 'pending' | 'approved' | 'rejected' | 'retracted',
  fields: Record<string, unknown> = {},
) => ({
  ...pending,
  requestId,
  status,
  decidedBy: null,
  decidedAt: null,
  decisionReason: null,
  retractedAt: null,
  ...fields,
});

const preview = { accountCount: 3, totalCoin: '1250', closedCount: 1, blockedCount: 0 };

/** A market paid YES on v1 (PAID_REGISTRANT's), its incident confirmed NO, and `compensation`. */
const market = (compensation: Partial<Compensation> | null): AdminMarket =>
  ({
    id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    status: 'settled',
    resolvedResult: 'YES',
    judgementVersion: 1,
    judgement: {
      current: { version: 1, result: 'YES', registeredBy: PAID_REGISTRANT },
      history: [],
      pending: null,
      log: [],
      disputeWindowUndecided: false,
    },
    judgementIncident: {
      registrable: false,
      confirmable: true,
      pending: null,
      confirmed: null,
      log: [],
      compensation:
        compensation === null
          ? null
          : { preview, held: false, pending: null, paid: null, log: [], ...compensation },
    },
  }) as unknown as AdminMarket;

const draw = (value: AdminMarket, operatorId: string | undefined) =>
  renderWithQueries(
    <MarketJudgementCompensationBody market={value} operatorId={operatorId} onOpen={() => {}} />,
  );

const isOff = (html: string, testId: string) => {
  const element = byTestId(html, testId);
  expect(element, testId).toBeDefined();
  return Object.hasOwn(element?.attributes ?? {}, 'disabled');
};

describe('the 판정 오류 보상 panel (#144 part 2, ADR-0166)', () => {
  it('is drawn only once an incident is confirmed', () => {
    expect(byTestId(draw(market(null), APPROVER.id), 'market-judgement-compensation')).toBe(
      undefined,
    );
    expect(byTestId(draw(market({}), APPROVER.id), 'market-judgement-compensation')).toBeDefined();
  });

  it('shows what a request would list now and offers 보상 요청 — to the paid registrant too', () => {
    const open = market({});
    expect(isOff(draw(open, undefined), 'market-judgement-compensation-request')).toBe(true);
    for (const admin of [APPROVER.id, PAID_REGISTRANT.id]) {
      const html = draw(open, admin);
      expect(isOff(html, 'market-judgement-compensation-request'), admin).toBe(false);
      expect(byTestId(html, 'market-judgement-compensation-unrequestable'), admin).toBeUndefined();
    }
    const html = draw(open, APPROVER.id);
    // 144-7: the closed accounts are counted apart; no ledger line when none needs a check.
    expect(byTestId(html, 'market-judgement-compensation-preview')?.text).toBe(
      '대상 계정 3개 · 총 1,250 Coin · 탈퇴 1개',
    );
    expect(byTestId(html, 'market-judgement-compensation-log-empty')?.text).toBe(
      copy.adminMarketJudgementCompensationLogEmpty,
    );
    // The per-account list waits for 대상 계정 보기: no account in the panel itself.
    expect(byTestId(html, 'market-judgement-compensation-recipients')).toBeUndefined();
    expect(byTestId(html, 'market-judgement-compensation-recipients-toggle')?.text).toBe(
      copy.adminMarketJudgementCompensationRecipientsShow,
    );
  });

  it('says why no request is taken: a ledger hold, one waiting, nobody owed — and none once paid', () => {
    const held = draw(market({ held: true }), APPROVER.id);
    expect(byTestId(held, 'market-judgement-compensation-held')?.text).toBe(
      copy.adminMarketJudgementCompensationHeld,
    );
    expect(isOff(held, 'market-judgement-compensation-request')).toBe(true);
    expect(
      byTestId(held, 'market-judgement-compensation-unrequestable')?.attributes['data-reason'],
    ).toBe('held');
    const none = draw(
      market({ preview: { accountCount: 0, totalCoin: '0', closedCount: 0, blockedCount: 0 } }),
      APPROVER.id,
    );
    expect(isOff(none, 'market-judgement-compensation-request')).toBe(true);
    expect(byTestId(none, 'market-judgement-compensation-unrequestable')?.text).toBe(
      copy.adminMarketJudgementCompensationNone,
    );
    expect(byTestId(none, 'market-judgement-compensation-preview')).toBeUndefined();
    const waiting = draw(market({ pending, log: [logEntry(REQUEST, 'pending')] }), APPROVER.id);
    expect(isOff(waiting, 'market-judgement-compensation-request')).toBe(true);
    expect(
      byTestId(waiting, 'market-judgement-compensation-unrequestable')?.attributes['data-reason'],
    ).toBe('pending');
  });

  it('lets another admin approve or reject the waiting request, and its requester only retract', () => {
    const value = market({ pending, log: [logEntry(REQUEST, 'pending')] });
    const html = draw(value, APPROVER.id);
    const at = 'market-judgement-compensation-pending';
    expect(byTestId(html, at)?.attributes['data-request']).toBe(REQUEST);
    expect(byTestId(html, `${at}-summary`)?.text).toBe('대상 계정 3개 · 총 1,250 Coin');
    expect(byTestId(html, `${at}-user-reason`)?.text).toBe(pending.userReason);
    expect(byTestId(html, `${at}-reason`)?.text).toBe(pending.reason);
    expect(byTestId(html, `${at}-by`)?.text).toBe(`요청한이 · ${formatKst(pending.requestedAt)}`);
    expect(isOff(html, 'market-judgement-compensation-approve')).toBe(false);
    expect(isOff(html, 'market-judgement-compensation-reject')).toBe(false);
    expect(byTestId(html, 'market-judgement-compensation-retract')).toBeUndefined();
    // Its requester: no decision (#171), 철회 alone.
    const own = draw(value, REQUESTER.id);
    expect(byTestId(own, 'market-judgement-compensation-approve')).toBeUndefined();
    expect(byTestId(own, 'market-judgement-compensation-reject')).toBeUndefined();
    expect(isOff(own, 'market-judgement-compensation-retract')).toBe(false);
    expect(byTestId(own, 'market-judgement-compensation-own-note')?.text).toBe(
      copy.adminMarketJudgementCompensationOwnNote,
    );
    // Nobody known yet: every button waits.
    const unknown = draw(value, undefined);
    expect(isOff(unknown, 'market-judgement-compensation-approve')).toBe(true);
    expect(isOff(unknown, 'market-judgement-compensation-reject')).toBe(true);
  });

  it('keeps 보상 승인 from the paid registrant (144-4) but lets them reject (정리 목적의 반려)', () => {
    const html = draw(market({ pending, log: [logEntry(REQUEST, 'pending')] }), PAID_REGISTRANT.id);
    expect(isOff(html, 'market-judgement-compensation-approve')).toBe(true);
    expect(
      byTestId(html, 'market-judgement-compensation-approve')?.attributes['data-unavailable'],
    ).toBe('registrant');
    expect(isOff(html, 'market-judgement-compensation-reject')).toBe(false);
    expect(byTestId(html, 'market-judgement-compensation-registrant-note')?.text).toBe(
      copy.adminMarketJudgementCompensationRegistrantNote,
    );
  });

  it('holds the whole approval while an account needs a ledger check (144-16), saying how many', () => {
    const html = draw(
      market({
        pending,
        preview: { ...preview, blockedCount: 2 },
        log: [logEntry(REQUEST, 'pending')],
      }),
      APPROVER.id,
    );
    expect(isOff(html, 'market-judgement-compensation-approve')).toBe(true);
    expect(
      byTestId(html, 'market-judgement-compensation-approve')?.attributes['data-unavailable'],
    ).toBe('blocked');
    expect(byTestId(html, 'market-judgement-compensation-blocked-note')?.text).toBe(
      '원장 확인 필요 계정 2개가 있어 보상을 승인할 수 없습니다. 대상 계정 보기에서 확인하고 대사 정정으로 고친 뒤 다시 승인해 주세요.',
    );
    expect(byTestId(html, 'market-judgement-compensation-preview')?.text).toBe(
      '대상 계정 3개 · 총 1,250 Coin · 탈퇴 1개 · 원장 확인 필요 2개',
    );
    // A 반려 stays on: it pays nothing.
    expect(isOff(html, 'market-judgement-compensation-reject')).toBe(false);
    // A ledger-held market: no approval either.
    const held = draw(
      market({ pending, held: true, log: [logEntry(REQUEST, 'pending')] }),
      APPROVER.id,
    );
    expect(
      byTestId(held, 'market-judgement-compensation-approve')?.attributes['data-unavailable'],
    ).toBe('held');
  });

  it('shows the payout once approved, the closed accounts apart, and the log newest first', () => {
    const paid = {
      ...pending,
      approvedBy: APPROVER,
      approvedAt: '2026-12-01T03:00:00.000Z',
      paidCount: 2,
      paidCoin: '1150',
      closedCount: 1,
    };
    const html = draw(
      market({
        preview: null,
        paid,
        log: [
          logEntry(REQUEST, 'approved', {
            decidedBy: APPROVER,
            decidedAt: paid.approvedAt,
            decisionReason: '목록을 확인했습니다.',
          }),
          logEntry(REJECTED, 'rejected', {
            decidedBy: PAID_REGISTRANT,
            decidedAt: '2026-12-01T01:00:00.000Z',
            decisionReason: '회원에게 보일 사유를 고쳐 주세요.',
          }),
        ],
      }),
      APPROVER.id,
    );
    // Once paid no request is offered (144-2: once per incident).
    expect(byTestId(html, 'market-judgement-compensation-request')).toBeUndefined();
    expect(byTestId(html, 'market-judgement-compensation-preview')).toBeUndefined();
    const at = 'market-judgement-compensation-paid';
    expect(byTestId(html, `${at}-summary`)?.text).toBe(
      '대상 계정 3개 중 2개 지급 · 총 1,150 Coin · 탈퇴로 지급 못 함 1개',
    );
    expect(byTestId(html, `${at}-approved-by`)?.text).toBe(
      `승인한이 · ${formatKst(paid.approvedAt)}`,
    );
    expect(byTestId(html, `${at}-user-reason`)?.text).toBe(pending.userReason);
    expect(
      testIdsStartingWith(html, 'market-judgement-compensation-log-').filter((id) =>
        /-log-\d+$/.test(id),
      ),
    ).toEqual(['market-judgement-compensation-log-0', 'market-judgement-compensation-log-1']);
    expect(byTestId(html, 'market-judgement-compensation-log-0-status')?.text).toBe('지급 완료');
    expect(byTestId(html, 'market-judgement-compensation-log-1-status')?.text).toBe('반려');
    expect(byTestId(html, 'market-judgement-compensation-log-1-reason')?.text).toContain(
      '회원에게 보일 사유를 고쳐 주세요.',
    );
  });

  it('names no account in the panel: the list is 대상 계정 보기’s, admins only', () => {
    const source = readFileSync(
      new URL('./market-judgement-compensation-panel.tsx', import.meta.url),
      'utf8',
    );
    expect(source).toContain(
      '{listed && <JudgementCompensationRecipients marketId={market.id} />}',
    );
    expect(source).not.toMatch(/userId/);
  });
});
