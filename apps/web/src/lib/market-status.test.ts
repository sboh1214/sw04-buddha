import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MARKET_STATUSES } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { SRC } from '../test/screen-text';
import { MARKET_STATUS_LABEL } from './market-admin';
import { marketStatusLabel, readsDisputeUnderReview, readsJudgementDelayed } from './market-status';

const PLAIN = { judgementDelayed: false, disputeUnderReview: false };

/**
 * The automatic '판정 지연' (ADR-0093 decision 1 #173 items 11·12; #22, ADR-0098; #175, ADR-0104):
 * a CLOSED market whose scheduled judgement has passed reads it in place of '거래 마감', and a
 * PROVISIONAL market a 판정 이의 holds reads '이의 검토 중' before its 이의 기한 and '판정 지연' after
 * it (owner answer 2026-11-03), wherever a user sees its status.
 */
describe('marketStatusLabel', () => {
  it("reads '판정 지연' for a closed market the API flags, and the status label otherwise", () => {
    expect(
      marketStatusLabel({ status: 'closed', judgementDelayed: true, disputeUnderReview: false }),
    ).toBe(copy.marketStatusJudgementDelayed);
    expect(copy.marketStatusJudgementDelayed).toBe('판정 지연');
    for (const status of MARKET_STATUSES) {
      expect(marketStatusLabel({ status, ...PLAIN }), status).toBe(MARKET_STATUS_LABEL[status]);
    }
  });

  it("reads '이의 검토 중' for a held provisional market, and '판정 지연' once its deadline passed (#175)", () => {
    expect(copy.marketStatusDisputeUnderReview).toBe('이의 검토 중');
    expect(
      marketStatusLabel({
        status: 'provisional',
        judgementDelayed: false,
        disputeUnderReview: true,
      }),
    ).toBe(copy.marketStatusDisputeUnderReview);
    // Past the deadline the server flags both: the delay replaces the review, as on CLOSED.
    expect(
      marketStatusLabel({
        status: 'provisional',
        judgementDelayed: true,
        disputeUnderReview: true,
      }),
    ).toBe(copy.marketStatusJudgementDelayed);
    // With nothing holding it the market reads 잠정 결과, its deadline ahead or not.
    expect(marketStatusLabel({ status: 'provisional', ...PLAIN })).toBe(
      copy.marketStatusProvisional,
    );
  });

  it('labels no other status delayed or under review, whatever the flags a cached row still holds', () => {
    // A `market:status` moves a cached row on and resets its flags (`applyStatus`); a flag read
    // for one status never labels another — a confirmed market is 결과 확정, a CLOSED one never
    // '이의 검토 중'.
    const flagged = { judgementDelayed: true, disputeUnderReview: true };
    for (const status of MARKET_STATUSES.filter((s) => s !== 'closed' && s !== 'provisional')) {
      expect(readsJudgementDelayed({ status, ...flagged }), status).toBe(false);
      expect(readsDisputeUnderReview({ status, ...flagged }), status).toBe(false);
      expect(marketStatusLabel({ status, ...flagged }), status).toBe(MARKET_STATUS_LABEL[status]);
    }
    expect(
      readsDisputeUnderReview({
        status: 'closed',
        judgementDelayed: false,
        disputeUnderReview: true,
      }),
    ).toBe(false);
    expect(
      marketStatusLabel({ status: 'closed', judgementDelayed: false, disputeUnderReview: true }),
    ).toBe(copy.marketStatusClosed);
  });
});

/**
 * Every user-facing badge that names a market's status and has the flags reads them through
 * `marketStatusLabel` — the detail header, the card (home, search, related, themes, 관심), the
 * write screen's search picker and its market, MY 보유 계약, and a post's or a comment's market
 * (`PostMarket`, which carries both flags since #175) — so none of them still says '거래 마감' or
 * '잠정 결과' for a delayed or held market. The admin screens keep the status (their detail notes
 * the delay).
 */
describe("the screens that read '판정 지연' and '이의 검토 중'", () => {
  const SCREENS = [
    'app/markets/[slug]/market-detail.tsx',
    'components/market/market-card.tsx',
    'components/post/market-picker.tsx',
    'app/community/write/write-screen.tsx',
    'app/my/portfolio.tsx',
    'components/post/post-card.tsx',
    'components/authored/authored-comment-card.tsx',
    'app/community/posts/[postId]/post-screen.tsx',
  ];

  it('label the status with marketStatusLabel', () => {
    for (const screen of SCREENS) {
      const source = readFileSync(path.join(SRC, screen), 'utf8');
      expect(source, screen).toContain('marketStatusLabel(');
    }
  });
});
