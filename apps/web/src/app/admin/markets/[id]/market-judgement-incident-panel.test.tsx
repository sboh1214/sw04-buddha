import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { type AdminMarket } from '@/lib/api';
import { formatKst } from '@/lib/datetime';
import { byTestId, renderWithQueries, testIdsStartingWith } from '@/test/render';
import { MarketJudgementIncidentBody } from './market-judgement-incident-panel';

const PAID_REGISTRANT = { id: 'paid-registrant', nickname: '판정등록한이' };
const INCIDENT_REGISTRANT = { id: 'incident-registrant', nickname: '사건등록한이' };
const REVIEWER = { id: 'reviewer', nickname: '검토한이' };
const REQUEST = 'a1b2c3d4-0000-4000-8000-000000000001';
const DISMISSED = 'a1b2c3d4-0000-4000-8000-000000000002';

const pending = {
  requestId: REQUEST,
  correctedResult: 'NO' as const,
  description: '1차 출처가 발표를 정정했습니다.',
  evidence: { links: ['https://example.com/fix'], collectedAt: '2026-11-30T01:00:00.000Z' },
  requestedBy: INCIDENT_REGISTRANT,
  requestedAt: '2026-11-30T02:00:00.000Z',
};

const confirmed = {
  ...pending,
  incidentId: 'b1b2c3d4-0000-4000-8000-000000000001',
  judgementVersion: 1,
  originalResult: 'YES' as const,
  registeredBy: INCIDENT_REGISTRANT,
  confirmedBy: REVIEWER,
  registeredAt: pending.requestedAt,
  confirmedAt: '2026-11-30T02:30:00.000Z',
  reason: '정정 발표를 확인했습니다.',
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

/**
 * A market paid YES on judgement v1, which PAID_REGISTRANT registered — with a market price, a
 * volume and counts, which no judgement screen draws (#152 AC 8).
 */
const market = (
  status: AdminMarket['status'],
  incident: Partial<AdminMarket['judgementIncident']> = {},
): AdminMarket =>
  ({
    id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    status,
    resolvedResult: 'YES',
    judgementVersion: 1,
    lastPrice: 63,
    volumeCoin: '123456',
    tradeCount: 789,
    traderCount: 321,
    judgement: {
      current: { version: 1, result: 'YES', registeredBy: PAID_REGISTRANT },
      history: [],
      pending: null,
      log: [],
      disputeWindowUndecided: false,
    },
    judgementIncident: {
      registrable: false,
      confirmable: status === 'settled',
      pending: null,
      confirmed: null,
      log: [],
      ...incident,
    },
  }) as unknown as AdminMarket;

const draw = (value: AdminMarket, operatorId: string | undefined) =>
  renderWithQueries(
    <MarketJudgementIncidentBody market={value} operatorId={operatorId} onOpen={() => {}} />,
  );

const isOff = (html: string, testId: string) => {
  const element = byTestId(html, testId);
  expect(element, testId).toBeDefined();
  return Object.hasOwn(element?.attributes ?? {}, 'disabled');
};

describe('the 판정 오류 사건 panel (#144, ADR-0165)', () => {
  it('offers 사건 등록 from 결과 확정 on, to the paid registrant too, once the admin is known', () => {
    const open = market('resolved', { registrable: true });
    expect(isOff(draw(open, undefined), 'market-judgement-incident-register')).toBe(true);
    for (const admin of [REVIEWER.id, PAID_REGISTRANT.id]) {
      const html = draw(open, admin);
      expect(isOff(html, 'market-judgement-incident-register'), admin).toBe(false);
      expect(byTestId(html, 'market-judgement-incident-unregistrable'), admin).toBeUndefined();
    }
    const html = draw(open, REVIEWER.id);
    expect(byTestId(html, 'market-judgement-incident')?.attributes['data-status']).toBe('resolved');
    expect(byTestId(html, 'market-judgement-incident-log-empty')?.text).toBe(
      copy.adminMarketJudgementIncidentLogEmpty,
    );
    // No price, volume or count of the market.
    for (const label of [copy.tradeStatsLastPrice, copy.marketVolume, copy.marketTradeCount]) {
      expect(byTestId(html, 'market-judgement-incident')?.text).not.toContain(label);
    }
    expect(html).not.toContain('123456');
  });

  it('shows the waiting incident and says why a registration waits (one at a time)', () => {
    const html = draw(
      market('settled', { pending, log: [logEntry(REQUEST, 'pending')] }),
      REVIEWER.id,
    );
    expect(isOff(html, 'market-judgement-incident-register')).toBe(true);
    expect(
      byTestId(html, 'market-judgement-incident-unregistrable')?.attributes['data-reason'],
    ).toBe('pending');
    expect(byTestId(html, 'market-judgement-incident-pending-paid')?.text).toBe('YES (v1)');
    expect(byTestId(html, 'market-judgement-incident-pending-result')?.text).toBe('NO');
    expect(byTestId(html, 'market-judgement-incident-pending-description')?.text).toBe(
      pending.description,
    );
    expect(byTestId(html, 'market-judgement-incident-pending-links')?.text).toContain(
      'https://example.com/fix',
    );
    expect(byTestId(html, 'market-judgement-incident-pending-collected-at')?.text).toBe(
      formatKst(pending.evidence.collectedAt),
    );
    expect(byTestId(html, 'market-judgement-incident-pending-by')?.text).toBe('사건등록한이');
    // Another admin, on a paid market: both decisions, no 철회.
    expect(isOff(html, 'market-judgement-incident-confirm')).toBe(false);
    expect(isOff(html, 'market-judgement-incident-dismiss')).toBe(false);
    expect(byTestId(html, 'market-judgement-incident-retract')).toBeUndefined();
    expect(byTestId(html, 'market-judgement-incident-log-0')?.attributes['data-status']).toBe(
      'pending',
    );
  });

  it('gives its registrant no 오류 확인 or 기각 — another admin decides — and the 철회 (#171)', () => {
    const html = draw(market('settled', { pending }), INCIDENT_REGISTRANT.id);
    expect(byTestId(html, 'market-judgement-incident-confirm')).toBeUndefined();
    expect(byTestId(html, 'market-judgement-incident-dismiss')).toBeUndefined();
    expect(isOff(html, 'market-judgement-incident-retract')).toBe(false);
    expect(byTestId(html, 'market-judgement-incident-own-note')?.text).toBe(
      copy.adminMarketJudgementIncidentOwnNote,
    );
    expect(byTestId(html, 'market-judgement-incident-registrant-note')).toBeUndefined();
  });

  it('turns both decisions off for the paid version’s registrant, saying why (144-4)', () => {
    const html = draw(market('settled', { pending }), PAID_REGISTRANT.id);
    expect(isOff(html, 'market-judgement-incident-confirm')).toBe(true);
    expect(isOff(html, 'market-judgement-incident-dismiss')).toBe(true);
    expect(byTestId(html, 'market-judgement-incident-registrant-note')?.text).toBe(
      copy.adminMarketJudgementIncidentRegistrantNote,
    );
    expect(byTestId(html, 'market-judgement-incident-retract')).toBeUndefined();
  });

  it('keeps 오류 확인 off until 지급 완료 with 144-13’s words; 기각 is taken before (144-13)', () => {
    for (const status of ['resolved', 'settling'] as const) {
      const html = draw(market(status, { pending }), REVIEWER.id);
      expect(isOff(html, 'market-judgement-incident-confirm'), status).toBe(true);
      expect(isOff(html, 'market-judgement-incident-dismiss'), status).toBe(false);
      expect(byTestId(html, 'market-judgement-incident-confirm-waits')?.text, status).toBe(
        '지급이 끝난 뒤 확인할 수 있습니다.',
      );
    }
    expect(
      byTestId(
        draw(market('settled', { pending }), REVIEWER.id),
        'market-judgement-incident-confirm-waits',
      ),
    ).toBeUndefined();
  });

  it('shows the confirmed incident with both admins and the reason, and takes no new one (144-14)', () => {
    const html = draw(
      market('settled', {
        confirmed,
        log: [
          logEntry(REQUEST, 'approved', {
            decidedBy: REVIEWER,
            decidedAt: confirmed.confirmedAt,
            decisionReason: confirmed.reason,
          }),
          logEntry(DISMISSED, 'rejected', {
            decidedBy: REVIEWER,
            decidedAt: '2026-11-29T02:00:00.000Z',
            decisionReason: '근거가 정정 발표가 아닙니다.',
          }),
        ],
      }),
      REVIEWER.id,
    );
    expect(isOff(html, 'market-judgement-incident-register')).toBe(true);
    expect(byTestId(html, 'market-judgement-incident-unregistrable')?.text).toBe(
      copy.adminMarketJudgementIncidentUnregistrableConfirmed,
    );
    expect(byTestId(html, 'market-judgement-incident-pending')).toBeUndefined();
    expect(byTestId(html, 'market-judgement-incident-confirmed-paid')?.text).toBe('YES (v1)');
    expect(byTestId(html, 'market-judgement-incident-confirmed-result')?.text).toBe('NO');
    expect(byTestId(html, 'market-judgement-incident-confirmed-registered-by')?.text).toContain(
      '사건등록한이',
    );
    expect(byTestId(html, 'market-judgement-incident-confirmed-confirmed-by')?.text).toContain(
      '검토한이',
    );
    expect(byTestId(html, 'market-judgement-incident-confirmed-reason')?.text).toBe(
      confirmed.reason,
    );
    expect(byTestId(html, 'market-judgement-incident-log-0-status')?.text).toBe('오류 확인');
    expect(byTestId(html, 'market-judgement-incident-log-1-status')?.text).toBe('기각');
    expect(byTestId(html, 'market-judgement-incident-log-1-reason')?.text).toContain(
      '근거가 정정 발표가 아닙니다.',
    );
    const ids = testIdsStartingWith(html, 'market-judgement-incident');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is placed after the judgement panel, keyed and prefixed by its market', () => {
    const detail = readFileSync(new URL('./admin-market-detail.tsx', import.meta.url), 'utf8');
    const judgement = detail.indexOf('<MarketJudgementPanel');
    const incident = detail.indexOf(
      '<MarketJudgementIncidentPanel key={`judgement-incident-${data.id}`} market={data} />',
    );
    expect(judgement).toBeGreaterThan(-1);
    expect(incident).toBeGreaterThan(judgement);
  });

  it('decides the incident each dialog was opened on, and refuses the paid result in the form', () => {
    const dialogs = readFileSync(
      new URL('./market-judgement-incident-dialogs.tsx', import.meta.url),
      'utf8',
    );
    // 오류 확인·기각 and 철회 each pin the waiting incident as they opened (`usePinnedIncident`):
    // one decided or retracted meanwhile turns the confirm off and says so.
    expect(dialogs.match(/const pinned = usePinnedIncident\(market\);/g)).toHaveLength(2);
    expect(dialogs.match(/\|\| pinned\.changed\n?\s*\}?/g)?.length).toBeGreaterThanOrEqual(2);
    expect(
      dialogs.match(/pinned\.changed \? copy\.adminMarketJudgementIncidentChanged : null/g),
    ).toHaveLength(2);
    // The registration offers every result but the paid one, and its conflict box starts empty.
    expect(dialogs).toContain('incidentResultChoices(market.resolvedResult).map(');
    expect(dialogs).toContain('const [noConflict, setNoConflict] = useState(false);');
  });
});
