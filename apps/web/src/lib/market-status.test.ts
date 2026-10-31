import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MARKET_STATUSES } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { SRC } from '../test/screen-text';
import { MARKET_STATUS_LABEL } from './market-admin';
import { marketStatusLabel, readsJudgementDelayed } from './market-status';

/**
 * The automatic '판정 지연' (ADR-0093 decision 1 #173 item 11; #22, ADR-0098): a CLOSED market whose
 * scheduled judgement has passed reads it in place of '거래 마감' wherever a user sees its status.
 */
describe('marketStatusLabel', () => {
  it("reads '판정 지연' for a closed market the API flags, and the status label otherwise", () => {
    expect(marketStatusLabel({ status: 'closed', judgementDelayed: true })).toBe(
      copy.marketStatusJudgementDelayed,
    );
    expect(copy.marketStatusJudgementDelayed).toBe('판정 지연');
    for (const status of MARKET_STATUSES) {
      expect(marketStatusLabel({ status, judgementDelayed: false }), status).toBe(
        MARKET_STATUS_LABEL[status],
      );
    }
  });

  it('labels no other status delayed, whatever the flag a cached row still holds', () => {
    // A `market:status` moves a cached row on and carries no flag: 잠정 결과 stays 잠정 결과.
    for (const status of MARKET_STATUSES.filter((s) => s !== 'closed')) {
      expect(readsJudgementDelayed({ status, judgementDelayed: true }), status).toBe(false);
      expect(marketStatusLabel({ status, judgementDelayed: true }), status).toBe(
        MARKET_STATUS_LABEL[status],
      );
    }
  });
});

/**
 * Every user-facing badge that names a market's status and has the flag reads it through
 * `marketStatusLabel` — the detail header, the card (home, search, related, themes, 관심), the
 * write screen's search picker and its market, MY 보유 계약 — so none of them still says '거래 마감'
 * for a delayed market. The admin screens keep the status (their detail notes the delay), and the
 * community's post market (`PostMarket`) carries no flag.
 */
describe("the screens that read '판정 지연'", () => {
  const SCREENS = [
    'app/markets/[slug]/market-detail.tsx',
    'components/market/market-card.tsx',
    'components/post/market-picker.tsx',
    'app/community/write/write-screen.tsx',
    'app/my/portfolio.tsx',
  ];

  it('label the status with marketStatusLabel', () => {
    for (const screen of SCREENS) {
      const source = readFileSync(path.join(SRC, screen), 'utf8');
      expect(source, screen).toContain('marketStatusLabel(');
    }
  });
});
