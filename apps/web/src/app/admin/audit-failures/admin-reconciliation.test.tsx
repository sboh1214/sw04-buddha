import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { type ReconciliationHoldDetail } from '@/lib/api';
import { byTestId, renderWithQueries } from '@/test/render';
import { AdminReconciliation, ReconciliationResultCard } from './admin-reconciliation';

const AT = '2026-11-09T01:00:00.000Z';
const row: ReconciliationHoldDetail = {
  hold: {
    id: '00000000-0000-4000-8000-000000000001',
    scope: 'account',
    targetKey: 'user:holder',
    marketId: null,
    userId: 'holder',
    failureResultId: '10',
    legacyPauseId: null,
    startedAt: AT,
    recoveredAt: null,
  },
  latestResult: {
    id: '11',
    scope: 'account',
    targetKey: 'user:holder',
    marketId: null,
    accountId: '1',
    userId: 'holder',
    source: 'manual',
    passed: true,
    checkedAt: AT,
    ledgerCursor: '3',
    findings: [],
    facts: {},
  },
  requests: [
    {
      id: '00000000-0000-4000-8000-000000000002',
      holdId: '00000000-0000-4000-8000-000000000001',
      failureResultId: '10',
      requestedBy: { id: 'a', nickname: '요청자' },
      reason: '복구 확인',
      requestedAt: AT,
      status: 'pending',
      decidedBy: null,
      decisionReason: null,
      decidedAt: null,
      retractedAt: null,
    },
  ],
  market: null,
  user: { id: 'holder', nickname: '보유자' },
};
const draw = (operator: string | undefined, item = row) =>
  renderWithQueries(<AdminReconciliation />, [
    ...(operator ? [[['me'], { id: operator }] as const] : []),
    [
      ['admin', 'reconciliation', 'holds', false],
      { pages: [{ items: [item], nextCursor: null }], pageParams: [undefined] },
    ],
    [
      ['admin', 'reconciliation', 'results'],
      { pages: [{ items: [], nextCursor: null }], pageParams: [undefined] },
    ],
  ]);
const off = (html: string, id: string) =>
  Object.hasOwn(byTestId(html, id)?.attributes ?? {}, 'disabled');

describe('reconciliation screen', () => {
  it('shows a clean audit and retained hold together, with requester controls separated', () => {
    const html = draw('a');
    expect(html).toContain(copy.reconciliationPassed);
    expect(html).toContain(copy.reconciliationHeld);
    expect(html).toContain(copy.reconciliationAccountHoldHint);
    expect(off(html, `reconciliation-approve-${row.requests[0]!.id}`)).toBe(true);
    expect(off(html, `reconciliation-reject-${row.requests[0]!.id}`)).toBe(true);
    expect(off(html, `reconciliation-retract-${row.requests[0]!.id}`)).toBe(false);
    expect(off(draw('b'), `reconciliation-approve-${row.requests[0]!.id}`)).toBe(false);
    expect(off(draw(undefined), `reconciliation-approve-${row.requests[0]!.id}`)).toBe(true);
  });
  it('offers the existing market path for PAUSED and keeps generic approval disabled', () => {
    const paused = {
      ...row,
      market: {
        id: '00000000-0000-4000-8000-000000000004',
        title: '검증 시장',
        status: 'paused' as const,
      },
    };
    const html = draw('b', paused);
    expect(html).toContain(copy.reconciliationPausePath);
    expect(html).toContain(`/admin/markets/${paused.market.id}`);
    expect(off(html, `reconciliation-approve-${row.requests[0]!.id}`)).toBe(true);
  });
  it.each(['market', 'account'] as const)(
    'stops claiming a recovered %s is waiting for approval and retains its completion record',
    (scope) => {
      const marketId = '00000000-0000-4000-8000-000000000004';
      const item: ReconciliationHoldDetail = {
        ...row,
        hold: {
          ...row.hold,
          scope,
          marketId: scope === 'market' ? marketId : null,
          userId: scope === 'account' ? 'holder' : null,
          targetKey: scope === 'market' ? `market:${marketId}` : 'user:holder',
        },
        market:
          scope === 'market' ? { id: marketId, title: '복구된 시장', status: 'cancelled' } : null,
        user: scope === 'account' ? row.user : null,
      };
      const hint =
        scope === 'market' ? copy.reconciliationMarketHoldHint : copy.reconciliationAccountHoldHint;
      expect(draw('b', item)).toContain(hint);
      const html = draw('b', {
        ...item,
        hold: { ...item.hold, recoveredAt: AT },
        requests: item.requests.map((request) => ({
          ...request,
          status: 'approved',
          decidedAt: AT,
          decidedBy: { id: 'b', nickname: '승인자' },
          decisionReason: '최신 대사를 확인했습니다.',
        })),
      });
      expect(html).toContain(copy.reconciliationRecovered);
      expect(html).toContain(copy.reconciliationRecoveredAt);
      expect(html).toContain(copy.reconciliationRequests);
      expect(html).not.toContain(hint);
      expect(byTestId(html, `reconciliation-request-${row.hold.id}`)).toBeUndefined();
      expect(byTestId(html, `reconciliation-rerun-${row.hold.id}`)).toBeUndefined();
    },
  );
  it('shows exact large Coin values and a Korean finding label', () => {
    const html = renderWithQueries(
      <ReconciliationResultCard
        result={{
          ...row.latestResult!,
          passed: false,
          findings: [
            {
              code: 'account_balance',
              expected: '900719925474099312345',
              actual: '900719925474099312346',
            },
          ],
        }}
      />,
    );
    expect(html).toContain(copy.reconciliationFindingAccountBalance);
    expect(html).toContain('900719925474099312345');
    expect(html).toContain('900719925474099312346');
  });
  it.each([
    ['closed_position_holder', copy.reconciliationFindingClosedHolder, '1'],
    ['empty_position_cost', copy.reconciliationFindingEmptyCost, '9007199254740993'],
  ] as const)(
    'explains %s as a failed contract audit with its exact evidence',
    (code, label, actual) => {
      const html = renderWithQueries(
        <ReconciliationResultCard
          result={{
            ...row.latestResult!,
            passed: false,
            scope: 'market',
            marketId: '00000000-0000-4000-8000-000000000004',
            targetKey: 'market:00000000-0000-4000-8000-000000000004',
            accountId: null,
            userId: null,
            findings: [{ code, expected: '0', actual, detail: 'holder:YES' }],
          }}
        />,
      );
      expect(html).toContain(copy.reconciliationFailed);
      expect(html).toContain(label);
      expect(html).toContain(`${copy.reconciliationExpected} 0`);
      expect(html).toContain(`${copy.reconciliationActual} ${actual}`);
      expect(html).toContain('holder:YES');
      expect(html).not.toContain(code);
    },
  );
});
