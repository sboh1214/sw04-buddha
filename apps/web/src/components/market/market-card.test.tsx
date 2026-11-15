import { describe, expect, it } from 'vitest';
import { TimeZoneScope } from '@/components/time-zone/time-zone-provider';
import { copy } from '@/copy';
import { type Category, type MarketSummary } from '@/lib/api';
import { formatKst, formatRemaining } from '@/lib/datetime';
import { CATEGORIES_QUERY_KEY } from '@/lib/market-keys';
import { byTagName, byTestId, renderWithQueries } from '@/test/render';
import { MarketCard } from './market-card';

const CLOSED: MarketSummary = {
  id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  slug: 'rate-cut-2026',
  title: '기준금리 인하?',
  category: { slug: 'economy', nameKo: '경제' },
  imageUrl: null,
  status: 'closed',
  judgementDelayed: false,
  disputeUnderReview: false,
  lastPrice: 63,
  lastFillAt: '2026-09-07T00:00:00.000Z',
  volumeCoin: '130000',
  tradeCount: 11,
  traderCount: 5,
  statsRevision: '11',
  closeAt: '2026-10-01T00:00:00.000Z',
  openAt: '2026-09-01T00:00:00.000Z',
  scheduledOpenAt: '2026-08-31T00:00:00.000Z',
  resolvedResult: null,
  judgementVersion: null,
  disputeDeadline: null,
  disputeOpen: false,
  statusEventId: '3',
  createdAt: '2026-08-30T00:00:00.000Z',
};

const draw = (market: MarketSummary) =>
  renderWithQueries(<MarketCard market={market} data-testid="card" />);

/**
 * The card's status badge (ADR-0093 decision 1 #173 item 11; #22, ADR-0098): every list draws a
 * market through this card — home, search, related markets, a theme, 관심 — so a closed market past
 * its scheduled judgement reads '판정 지연' in all of them, from the flag the API computed.
 */
describe('MarketCard status badge', () => {
  it("reads '판정 지연' for a closed market past its scheduled judgement, '거래 마감' before it", () => {
    const delayed = draw({ ...CLOSED, judgementDelayed: true });
    expect(delayed).toContain(copy.marketStatusJudgementDelayed);
    expect(delayed).not.toContain(copy.marketStatusClosed);
    const closed = draw(CLOSED);
    expect(closed).toContain(copy.marketStatusClosed);
    expect(closed).not.toContain(copy.marketStatusJudgementDelayed);
  });
});

/** An open market that has traded: its last fill a NO at 37, so the price reads YES 63 (#121). */
const TRADED: MarketSummary = {
  ...CLOSED,
  status: 'open',
  closeAt: '2026-12-01T00:00:00.000Z',
  statusEventId: '2',
};
/** The instant a server render measures the countdown against. */
const NOW = Date.parse('2026-11-16T00:00:00.000Z');
const NOW_ISO = new Date(NOW).toISOString();

const text = (html: string, testId: string) => byTestId(html, testId)?.text;

/**
 * The card's items (#61, ADR-0136; ADR-0135 decision 1 items 1·2·4·5·20, decision 2 A1–A3, 결과
 * 4). A static render is the first paint: the countdown reads the `now` given, and every absolute
 * time is KST, unmarked, until the viewer's zone has settled (ADR-0063).
 */
describe('MarketCard items (#61)', () => {
  it("shows the price with its fill's time, both rows, the participants, and no control", () => {
    const html = draw(TRADED);
    // The question, its category, and the close line (items 1·2·5).
    expect(html).toContain(TRADED.title);
    expect(html).toContain(TRADED.category.nameKo);
    expect(text(html, 'market-countdown')?.startsWith(copy.marketCloseAt)).toBe(true);
    expect(byTestId(html, 'market-card-probability')?.text).toBe('63%');
    expect(byTestId(html, 'market-card-probability-no')?.text).toBe('37%');
    expect(html).toContain(`aria-label="${copy.yes} 63%"`);
    expect(html).toContain(`aria-label="${copy.no} 37%"`);
    expect(text(html, 'market-card-last-fill')).toBe(
      `${copy.marketLastFillAt} ${formatKst(TRADED.lastFillAt ?? '')}`,
    );
    expect(text(html, 'market-card-traders')).toBe(`${copy.marketTraders} 5`);
    expect(html).not.toContain(copy.noFills);
    // A traded card still draws no payout multiple and no 거래량 (ADR-0061 decision 1, item 4).
    expect(html).not.toMatch(/\d\.\d{2}x/);
    expect(html).not.toContain(copy.marketVolume);
    // No order button (A1): the category and the question are the card's two links.
    expect(byTagName(html, 'button')).toHaveLength(0);
    expect(byTagName(html, 'a')).toHaveLength(2);
  });

  it("reads 체결 없음 before the first fill, never 50%, and leaves the time's slot empty", () => {
    const html = draw({ ...TRADED, lastPrice: null, lastFillAt: null, traderCount: 0 });
    expect(text(html, 'market-card-no-fills')).toBe(copy.noFills);
    expect(html).not.toContain('50%');
    expect(byTestId(html, 'market-card-last-fill')).toBeUndefined();
    expect(text(html, 'market-card-traders')).toBe(`${copy.marketTraders} 0`);
  });

  it('keeps an ended card as it was, with no result on it (ADR-0135 A2)', () => {
    for (const resolvedResult of ['YES', 'VOID'] as const) {
      const html = draw({ ...CLOSED, status: 'settled', resolvedResult, statusEventId: '9' });
      expect(byTestId(html, 'market-card-probability')?.text, resolvedResult).toBe('63%');
      expect(text(html, 'market-card-last-fill'), resolvedResult).toBe(
        `${copy.marketLastFillAt} ${formatKst(CLOSED.lastFillAt ?? '')}`,
      );
      expect(html, resolvedResult).toContain(copy.marketStatusSettled);
      expect(text(html, 'market-countdown'), resolvedResult).toBe(copy.marketClosed);
      // '무효' is a result label (ADR-0095 decision 7), and no result line is drawn either.
      expect(html, resolvedResult).not.toContain(copy.marketResultVoid);
      expect(html, resolvedResult).not.toContain(copy.marketResolvedResult);
    }
  });

  it('puts the scheduled open before the countdown on a 개장 예정 card (A3)', () => {
    const scheduled: MarketSummary = {
      ...TRADED,
      status: 'scheduled',
      openAt: null,
      scheduledOpenAt: '2026-11-20T00:00:00.000Z',
      closeAt: '2026-12-01T00:00:00.000Z',
      lastPrice: null,
      lastFillAt: null,
      traderCount: 0,
    };
    const html = renderWithQueries(<MarketCard market={scheduled} now={NOW} />);
    expect(html).toContain(copy.marketStatusScheduled);
    expect(text(html, 'market-card-opens-at')).toBe(
      `${copy.marketScheduledOpenAt} ${formatKst('2026-11-20T00:00:00.000Z')}`,
    );
    expect(text(html, 'market-countdown')).toBe(
      `${copy.marketCloseAt} ${formatRemaining(scheduled.closeAt, NOW)}`,
    );
    // One line: the time first, then the countdown.
    expect(html.indexOf('market-card-opens-at')).toBeLessThan(html.indexOf('market-countdown'));
    // Each piece leads with its own hidden '·' (the one starting a line is clipped, so a folded
    // line never starts or ends on a dot), and no reader hears one.
    expect(html.match(/aria-hidden="true"[^>]*>·</g)).toHaveLength(2);
    expect(html.match(/>·</g)).toHaveLength(2);

    // Past its scheduled time and its close, not opened (a close passed): the status decides.
    const late = renderWithQueries(
      <MarketCard
        market={{
          ...scheduled,
          scheduledOpenAt: '2026-11-01T00:00:00.000Z',
          closeAt: '2026-11-10T00:00:00.000Z',
        }}
        now={NOW}
      />,
    );
    expect(text(late, 'market-card-opens-at')).toBe(
      `${copy.marketScheduledOpenAt} ${formatKst('2026-11-01T00:00:00.000Z')}`,
    );
    expect(text(late, 'market-countdown')).toBe(copy.marketClosed);

    // A market made before #22 has no scheduled open: the countdown alone, nothing made up.
    const undated = renderWithQueries(
      <MarketCard market={{ ...scheduled, scheduledOpenAt: null }} now={NOW} />,
    );
    expect(byTestId(undated, 'market-card-opens-at')).toBeUndefined();
    // The countdown's own '·' alone, hidden and clipped as the line's first piece.
    expect(undated.match(/>·</g)).toHaveLength(1);
    expect(undated.match(/aria-hidden="true"[^>]*>·</g)).toHaveLength(1);
    expect(text(undated, 'market-countdown')).toBe(
      `${copy.marketCloseAt} ${formatRemaining(scheduled.closeAt, NOW)}`,
    );
    // Not in any other status, though the summary carries it in every one.
    const trading = draw({ ...TRADED, scheduledOpenAt: '2026-09-01T00:00:00.000Z' });
    expect(byTestId(trading, 'market-card-opens-at')).toBeUndefined();

    // The countdown sits in the same place whether the 예정 개장 piece is there or not — the
    // same wrapper and separator just before it — so a 개장 예정 card that opens under the
    // visitor keeps its CountdownBadge (and its server-clock anchor) instead of mounting anew.
    const lead = (html: string) => {
      const at = html.indexOf('data-testid="market-countdown"');
      // The countdown's '·', the separator span holding it, and the piece's span around both.
      const separator = html.lastIndexOf('<span', html.lastIndexOf('>·<', at));
      return html.slice(html.lastIndexOf('<span', separator - 1), at);
    };
    const opened = renderWithQueries(
      <MarketCard market={{ ...scheduled, status: 'open', openAt: NOW_ISO }} now={NOW} />,
    );
    expect(byTestId(html, 'market-card-close-line')).toBeDefined();
    expect(byTestId(opened, 'market-card-close-line')).toBeDefined();
    expect(lead(opened)).toBe(lead(html));
  });

  it('leaves the close line empty for a market cancelled before it opened (결과 4)', () => {
    const before = draw({ ...TRADED, status: 'cancelled', openAt: null, statusEventId: '9' });
    expect(before).toContain(copy.marketStatusCancelled);
    expect(before).not.toContain(copy.marketClosed);
    expect(byTestId(before, 'market-countdown')).toBeUndefined();
    // Cancelled after its open (#20): 마감됨 under the badge, as ever.
    const after = draw({ ...TRADED, status: 'cancelled', statusEventId: '9' });
    expect(text(after, 'market-countdown')).toBe(copy.marketClosed);
  });

  it('shows a paused card its badge and the time left', () => {
    const html = renderWithQueries(
      <MarketCard market={{ ...TRADED, status: 'paused', statusEventId: '3' }} now={NOW} />,
    );
    expect(html).toContain(copy.marketStatusPaused);
    expect(text(html, 'market-countdown')).toBe(
      `${copy.marketCloseAt} ${formatRemaining(TRADED.closeAt, NOW)}`,
    );
  });

  it("writes the times in the viewer's zone once settled, marked, on one line (ADR-0063)", () => {
    const html = renderWithQueries(
      <TimeZoneScope zone="America/New_York" settled>
        <MarketCard market={TRADED} now={NOW} />
      </TimeZoneScope>,
    );
    const line = text(html, 'market-card-last-fill') ?? '';
    expect(line.startsWith(`${copy.marketLastFillAt} `)).toBe(true);
    expect(line).toContain(' (GMT-');
    // No 판정 기준 시간대 line on a card (owner answer 2026-11-16, ADR-0136).
    expect(html).not.toContain(copy.rulesJudgementZoneLine);
  });
});

/**
 * The glyph (#61, ADR-0136; ADR-0135 결과 4): a leaf an admin added under a seeded parent draws
 * the parent's once the public category list is held. Drawn without links (`interactive={false}`)
 * so the category's slug reaches the HTML through the glyph alone.
 */
describe('MarketCard glyph (#61)', () => {
  const categories: Category[] = [
    { id: 1, slug: 'economy', nameKo: '경제', sortOrder: 10, parentId: null },
    { id: 13, slug: 'stocks', nameKo: '주식', sortOrder: 30, parentId: 1 },
  ];
  const cardIn = (slug: string, held?: Category[]) =>
    renderWithQueries(
      <MarketCard
        market={{ ...TRADED, category: { slug, nameKo: '주식' } }}
        interactive={false}
        data-testid="card"
      />,
      held === undefined ? [] : [[CATEGORIES_QUERY_KEY, held]],
    );

  it("draws an admin's leaf under a seeded parent with the parent's glyph", () => {
    const seeded = cardIn('economy');
    const neutral = cardIn('no-such-category');
    expect(seeded).not.toBe(neutral);
    expect(cardIn('stocks', categories)).toBe(seeded);
    // Before the list has come, the neutral glyph.
    expect(cardIn('stocks')).toBe(neutral);
  });
});
