import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { ME_QUERY_KEY } from '@/hooks/use-me';
import { type Market, type Me, type MyDispute, type MyMarketDispute } from '@/lib/api';
import { DISPUTE_REFUSAL_TEXT, myMarketDisputeKey } from '@/lib/disputes';
import { marketKey } from '@/lib/market-keys';
import { byTestId, renderWithQueries, testIdsStartingWith } from '@/test/render';
import { StatusNotice } from '../market-detail';
import { DisputeScreen } from './dispute-screen';

const MARKET_ID = '1f2e3d4c-0000-4000-8000-000000000000';
const DEADLINE = '2026-12-01T03:00:00.000Z';

/**
 * A provisional market taking 판정 이의 — with a price, a volume and counts, which no dispute screen
 * may show (N03 §5, as #152 AC 8).
 */
const provisional: Market = {
  id: MARKET_ID,
  slug: 'first-snow',
  title: '첫눈이 올까?',
  category: { slug: 'weather', nameKo: '날씨' },
  imageUrl: null,
  status: 'provisional',
  judgementDelayed: false,
  disputeUnderReview: false,
  lastPrice: 63,
  volumeCoin: '123456',
  tradeCount: 789,
  traderCount: 321,
  closeAt: '2026-11-29T15:00:00.000Z',
  openAt: '2026-11-01T00:00:00.000Z',
  resolvedResult: 'NO',
  judgementVersion: 1,
  disputeDeadline: DEADLINE,
  disputeOpen: true,
  statusEventId: '4',
  createdAt: '2026-10-01T00:00:00.000Z',
  description: null,
  yesCondition: '관측되면 YES',
  noCondition: '',
  eventDeadline: null,
  primarySource: null,
  fallbackSources: [],
  fallbackCondition: '',
  longDelayDays: null,
  delayHandling: '',
  scheduledOpenAt: null,
  scheduledAnnouncementAt: null,
  scheduledJudgementAt: null,
  judgementTimeZone: 'Asia/Seoul',
  resolvedAt: null,
  settledAt: null,
  tags: [],
  ruleVersion: 1,
  ruleVersions: [],
};

const ACCOUNT = { id: 'b7c9a1d2-6f34-4e58-9b0a-2d1e5f8c7a46' } as Me;

const own: MyDispute = {
  id: 'd1b07384-d9a0-4c9b-8e2f-2d1c0f8a4b11',
  judgementVersion: 1,
  links: ['https://example.com/a'],
  reason: '규칙의 출처와 다릅니다.',
  status: 'dismissed',
  submittedAt: '2026-11-30T03:00:00.000Z',
  decidedAt: '2026-11-30T05:00:00.000Z',
  decisionReason: '출처의 발표와 같습니다.',
  retractedAt: null,
  closedAt: null,
  market: {
    id: MARKET_ID,
    slug: 'first-snow',
    title: '첫눈이 올까?',
    status: 'provisional',
    judgementVersion: 1,
  },
  retractable: false,
};

const drawn = (market: Market, standing?: MyMarketDispute) =>
  renderWithQueries(<DisputeScreen marketId={MARKET_ID} />, [
    [marketKey(MARKET_ID), market],
    [ME_QUERY_KEY, ACCOUNT],
    ...(standing === undefined
      ? []
      : [[myMarketDisputeKey(MARKET_ID, ACCOUNT.id), standing] as const]),
  ]);

/** No price, volume, count or holding of the market (N03 §5: a dispute argues the source). */
const expectNoMarketSignal = (html: string) => {
  const drawnText = byTestId(html, 'dispute-screen')?.text ?? '';
  expect(drawnText).not.toBe('');
  for (const text of [
    copy.marketVolume,
    copy.marketTraders,
    copy.marketTradeCount,
    copy.marketTraderCount,
    '63%',
    '63 ',
    '123456',
    '123,456',
    '789',
    '321',
    'Coin',
  ]) {
    expect(drawnText, text).not.toContain(text);
  }
};

/**
 * 판정 이의 제출 as drawn (#175, ADR-0104; #173 items 5·6·7·13): the market, the standing's sentence
 * or the form, the member's own dispute. What the form sends and what a refusal says are
 * lib/disputes.ts' (disputes.test.ts); the e2e (dispute.spec.ts) drives the screen.
 */
describe('DisputeScreen', () => {
  it('draws the market with its 잠정 결과 and 이의 기한, and the privacy note', () => {
    const html = drawn(provisional, { eligibility: 'no_fill', judgementVersion: 1, dispute: null });
    expect(byTestId(html, 'dispute-market-link')?.attributes.href).toBe('/markets/first-snow');
    expect(byTestId(html, 'dispute-market-result')?.text).toBe('NO');
    expect(byTestId(html, 'dispute-market-deadline-viewer-zone')).toBeDefined();
    expect(byTestId(html, 'dispute-notice')?.text).toContain(copy.disputePrivacyNote);
    expect(byTestId(html, 'dispute-notice')?.text).toContain(copy.disputeNotAppealNote);
    expect(byTestId(html, 'dispute-my-link')?.attributes.href).toBe('/my/disputes');
  });

  it('says why not, one sentence each, with no form: no fill, an admin, the deadline, a confirmed market', () => {
    for (const eligibility of ['no_fill', 'admin', 'deadline_passed', 'not_provisional'] as const) {
      const html = drawn(provisional, { eligibility, judgementVersion: 1, dispute: null });
      const closed = byTestId(html, 'dispute-closed');
      expect(closed?.attributes['data-reason'], eligibility).toBe(eligibility);
      expect(closed?.text, eligibility).toBe(DISPUTE_REFUSAL_TEXT[eligibility]);
      expect(byTestId(html, 'dispute-form'), eligibility).toBeUndefined();
    }
    // The live row first: a market confirmed meanwhile takes no dispute, whatever was read.
    const confirmed = drawn(
      { ...provisional, status: 'resolved', disputeOpen: false },
      { eligibility: 'eligible', judgementVersion: 1, dispute: null },
    );
    expect(byTestId(confirmed, 'dispute-closed')?.attributes['data-reason']).toBe(
      'not_provisional',
    );
  });

  it('offers the form to an eligible member: one link to start, the reason with its count', () => {
    const html = drawn(provisional, {
      eligibility: 'eligible',
      judgementVersion: 1,
      dispute: null,
    });
    expect(byTestId(html, 'dispute-form')).toBeDefined();
    expect(byTestId(html, 'dispute-once')?.text).toBe(copy.disputeOnce);
    expect(testIdsStartingWith(html, 'dispute-link-')).toEqual([
      'dispute-link-0',
      'dispute-link-add',
    ]);
    expect(byTestId(html, 'dispute-reason-count')?.text).toBe(`0 ${copy.disputeReasonCountMax}`);
    expect(byTestId(html, 'dispute-submit')?.text).toBe(copy.disputeSubmitButton);
    expect(byTestId(html, 'dispute-closed')).toBeUndefined();
    expectNoMarketSignal(html);
  });

  it('shows the member’s own dispute with its status and the decision’s reason, never who decided', () => {
    const html = drawn(provisional, {
      eligibility: 'duplicate',
      judgementVersion: 1,
      dispute: own,
    });
    // The one per version speaks for itself once the dispute is drawn.
    expect(byTestId(html, 'dispute-closed')).toBeUndefined();
    expect(byTestId(html, 'dispute-form')).toBeUndefined();
    const item = byTestId(html, `my-dispute-${own.id}`);
    expect(item?.attributes['data-status']).toBe('dismissed');
    expect(byTestId(html, `my-dispute-${own.id}-status`)?.text).toBe('기각');
    expect(byTestId(html, `my-dispute-${own.id}-decision-reason`)?.text).toBe(own.decisionReason);
    expect(byTestId(html, `my-dispute-${own.id}-retract`)).toBeUndefined();
    expect(item?.text).not.toContain(copy.adminDisputeDecidedBy);
    // Pending and retractable: 철회.
    const pending = drawn(provisional, {
      eligibility: 'duplicate',
      judgementVersion: 1,
      dispute: {
        ...own,
        status: 'pending',
        decidedAt: null,
        decisionReason: null,
        retractable: true,
      },
    });
    expect(byTestId(pending, `my-dispute-${own.id}-retract`)?.text).toBe(copy.disputeRetract);
    expectNoMarketSignal(pending);
  });

  it('reads the standing again once the live row is another version’s, saying nothing meanwhile', () => {
    // Opened on the CLOSED market, the socket has since moved it to 잠정 결과 v1: the standing
    // read then (`not_provisional`, no version) is not this version's.
    const html = drawn(provisional, {
      eligibility: 'not_provisional',
      judgementVersion: null,
      dispute: null,
    });
    expect(byTestId(html, 'dispute-standing')?.attributes['data-view']).toBe('pending');
    expect(byTestId(html, 'dispute-closed')).toBeUndefined();
    expect(byTestId(html, 'dispute-form')).toBeUndefined();
    // The row the event moved, its REST read not in: no version, no deadline — not 'deadline'.
    const moved = drawn(
      { ...provisional, judgementVersion: null, disputeDeadline: null, disputeOpen: false },
      { eligibility: 'not_provisional', judgementVersion: null, dispute: null },
    );
    expect(byTestId(moved, 'dispute-standing')?.attributes['data-view']).toBe('pending');
    expect(byTestId(moved, 'dispute-closed')).toBeUndefined();
  });

  it('waits for the standing, and for `GET /me`', () => {
    expect(byTestId(drawn(provisional), 'dispute-standing-pending')).toBeDefined();
    const noAccount = renderWithQueries(<DisputeScreen marketId={MARKET_ID} />, [
      [marketKey(MARKET_ID), provisional],
    ]);
    expect(byTestId(noAccount, 'dispute-standing-pending')).toBeDefined();
    expect(byTestId(noAccount, 'dispute-form')).toBeUndefined();
  });
});

/**
 * The detail's 상태별 안내 on a 잠정 결과 (#175, #173 item 6: 기한과 접수 링크는 비로그인에게도 보인다):
 * the 이의 기한 row and, while disputes are taken, the link — in the server's HTML, the same for
 * every visitor; past the deadline the row stays and the link goes; no other status has either.
 */
describe('the detail’s 이의 기한 and its link', () => {
  const notice = (market: Market) => renderWithQueries(<StatusNotice market={market} />);

  it('draws the deadline and the link to the submission screen while disputes are taken', () => {
    const html = notice(provisional);
    expect(byTestId(html, 'market-detail-result')?.text).toBe('NO');
    expect(byTestId(html, 'market-detail-dispute-deadline')?.text).toContain(
      copy.marketDisputeDeadline,
    );
    expect(byTestId(html, 'market-detail-dispute-deadline')?.text).toContain('2026');
    expect(byTestId(html, 'market-detail-dispute-deadline-viewer-zone')).toBeDefined();
    expect(byTestId(html, 'market-dispute-link')?.attributes.href).toBe(
      '/markets/first-snow/dispute',
    );
    expect(byTestId(html, 'market-dispute-link')?.text).toBe(copy.marketDisputeSubmit);
  });

  it('keeps the deadline once it has passed, and says why the result waits while one holds it', () => {
    const late = notice({
      ...provisional,
      disputeOpen: false,
      disputeUnderReview: true,
      judgementDelayed: true,
    });
    expect(byTestId(late, 'market-detail-dispute-deadline')).toBeDefined();
    expect(byTestId(late, 'market-dispute-link')).toBeUndefined();
    expect(byTestId(late, 'market-status-notice-detail')?.text).toBe(copy.marketProvisionalDelayed);
    const reviewing = notice({ ...provisional, disputeUnderReview: true });
    expect(byTestId(reviewing, 'market-status-notice-detail')?.text).toBe(
      copy.marketProvisionalUnderReview,
    );
    // Held past it by a correction waiting for its approval, no dispute holding it (#176).
    const correcting = notice({ ...provisional, disputeOpen: false, judgementDelayed: true });
    expect(byTestId(correcting, 'market-status-notice-detail')?.text).toBe(
      copy.marketProvisionalDelayedCorrection,
    );
    expect(byTestId(correcting, 'market-detail-dispute-deadline')).toBeDefined();
  });

  it('draws neither on any other status, and no 이의 on a settled market', () => {
    for (const status of ['closed', 'resolved', 'settling', 'settled', 'cancelled'] as const) {
      const html = notice({ ...provisional, status, disputeOpen: false });
      expect(byTestId(html, 'market-detail-dispute-deadline'), status).toBeUndefined();
      expect(byTestId(html, 'market-dispute-link'), status).toBeUndefined();
      expect(byTestId(html, 'market-status-notice')?.text ?? '', status).not.toContain('이의');
    }
  });
});
