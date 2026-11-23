import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  MARKET_STATUSES,
  CONTRACT_TERMS,
  PUBLIC_MARKET_STATUSES,
  formatCoin,
} from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { SRC } from '../test/screen-text';
import { ApiError } from './api';
import { BOTTOM_TABS_HEIGHT_PX, ORDER_ENTRY_BAR_HEIGHT_PX } from './nav';
import { LIVE_REFRESH_MS } from './ticks';
import {
  DEFAULT_DETAIL_VIEW,
  DETAIL_SLOTS,
  DETAIL_TOP_PADDING_MD_PX,
  DETAIL_VIEWS,
  DETAIL_VIEW_ITEMS,
  type DetailWidth,
  INITIAL_ORDER_SHEET,
  JUDGING_RECORD_ANCHOR,
  LONG_DELAY_SEPARATOR,
  MD_UP_MEDIA_QUERY,
  ORDER_COLUMN_MAX_H,
  ORDER_COLUMN_TOP,
  ORDER_ENTRY_CONTRACTS,
  ORDER_ENTRY_SCROLL_PADDING,
  backgroundText,
  closeOrderSheet,
  complementReading,
  copyDisplay,
  copyTestId,
  delta24h,
  detailViewOf,
  drawnAnchor,
  drawnOrder,
  judgingRecordPath,
  longDelayText,
  marketRefreshNotice,
  nextReviewWaitAt,
  openOrderSheet,
  orderEntryLabel,
  orderEntryPrice,
  orderInputClosedReason,
  orderSheetBody,
  perWidth,
  personalAreaView,
  ruleText,
  shownJudgementDelay,
  showsOrderArea,
  showsScheduledOpen,
  sourceView,
  statusNotice,
  viewDisplay,
  voidPayoutText,
} from './market-detail';

const WIDTHS: readonly DetailWidth[] = ['md', 'base'];

describe('the detail sections (#122, ADR-0061 decision 1, item 16)', () => {
  it("draws N02 §4's list from md up", () => {
    // 질문·배경·규칙·출처·마감(·판정 기록), 가격 차트, 호가·최근 체결, 내 포지션·대기 주문, 토론, 관련 시장
    // — the last one #65's (ADR-0068), in the place #122 left after 토론.
    expect(drawnOrder('md')).toEqual([
      'summary',
      'background',
      'rules',
      'judging',
      'chart',
      'activity',
      'position',
      'discussion',
      'related',
    ]);
  });

  it('below md draws 요약 and the chart first, then the 호가·거래 내역 switch, then the rest in order', () => {
    // N02 §4: "모바일은 요약과 차트 아래 호가·거래 내역을 전환한다".
    expect(drawnOrder('base')).toEqual([
      'summary',
      'chart',
      'activity',
      'background',
      'rules',
      'judging',
      'position',
      'discussion',
      'related',
    ]);
  });

  it('holds what each width draws in the order it draws it: no section is drawn out of DOM order', () => {
    // WCAG 1.3.2 (Codex review on #213): the CSS `order` this replaced lifted the chart and the
    // switch above 배경·규칙·판정 기록 below md on screen only, so a screen reader met them in
    // N02 §4's order there. Now a width draws a subsequence of the DOM, so its reading order is
    // its drawn order by construction — this pins that the DOM is that list, slot by slot.
    expect(DETAIL_SLOTS.map((slot) => `${slot.section}:${slot.width}`)).toEqual([
      'summary:all',
      'background:md',
      'rules:md',
      'judging:md',
      'chart:all',
      'activity:all',
      'background:base',
      'rules:base',
      'judging:base',
      'position:all',
      'discussion:all',
      'related:all',
    ]);
    // …and what CSS draws at a width is that subsequence: the shared slots and the width's own
    // copies, whose `display` is not `none` there.
    for (const width of WIDTHS) {
      const drawn = DETAIL_SLOTS.filter(
        (slot) => slot.width === 'all' || copyDisplay(slot.width)[width] !== 'none',
      );
      expect(
        drawn.map((slot) => slot.section),
        width,
      ).toEqual(drawnOrder(width));
    }
  });

  it('draws every section once at each width, and copies only 배경, 규칙 and 공개 판정 기록', () => {
    for (const width of WIDTHS) {
      const drawn = drawnOrder(width);
      expect(new Set(drawn).size, width).toBe(drawn.length);
      expect([...drawn].sort(), width).toEqual([...drawnOrder('md')].sort());
    }
    // The chart, the switch with 최근 체결, 요약 with 관심 등록, 내 포지션, 토론 and 관련 시장 hold
    // state or fetch: one slot each, so each is mounted once.
    const copied = DETAIL_SLOTS.filter((slot) => slot.width !== 'all');
    expect(copied.map((slot) => slot.section).sort()).toEqual([
      'background',
      'background',
      'judging',
      'judging',
      'rules',
      'rules',
    ]);
    for (const section of ['summary', 'chart', 'activity', 'position', 'discussion', 'related']) {
      expect(
        DETAIL_SLOTS.filter((slot) => slot.section === section),
        section,
      ).toEqual([{ section, width: 'all' }]);
    }
  });

  it("shows a copy at its own width only, as `contents` so the section in it is the column's item", () => {
    expect(copyDisplay('md')).toEqual({ base: 'none', md: 'contents' });
    expect(copyDisplay('base')).toEqual({ base: 'contents', md: 'none' });
    // At each width exactly one copy of each copied section is drawn: its own.
    for (const width of WIDTHS) {
      for (const section of ['background', 'rules', 'judging']) {
        const drawn = DETAIL_SLOTS.filter(
          (slot) =>
            slot.section === section &&
            slot.width !== 'all' &&
            copyDisplay(slot.width)[width] !== 'none',
        );
        expect(drawn, `${section} at ${width}`).toEqual([{ section, width }]);
      }
    }
  });

  it("gives each copy its own test ids, the width after the section's (e2e helpers.ts writes the same)", () => {
    expect(copyTestId('market-rules', 'md')).toBe('market-rules-md');
    expect(copyTestId('market-rules', 'base')).toBe('market-rules-base');
    expect(perWidth((width) => copyTestId('market-background', width))).toEqual({
      md: 'market-background-md',
      base: 'market-background-base',
    });
  });

  it('is the order the detail renders: MarketDetail iterates the slots, once, filling a record per kind', () => {
    // Without a DOM the page cannot be rendered here, so this reads the component's source: the
    // sections come out of one `DETAIL_SLOTS.map` over records that must name every key, not out
    // of JSX written in its own order beside a list nobody reads; and no CSS `order` moves one
    // on screen away from its place in the DOM. The DOM order itself is pinned by market.spec.ts
    // (`expectInOrder`, which reads the document order as well as the boxes).
    const source = readFileSync(path.join(SRC, 'app/markets/[slug]/market-detail.tsx'), 'utf8');
    expect(source.match(/DETAIL_SLOTS\.map\(/g)).toHaveLength(1);
    expect(source).toContain('Record<SharedSection, ReactNode>');
    expect(source).toContain('Record<CopiedSection, Record<DetailWidth, ReactNode>>');
    expect(source).not.toMatch(/\border=\{/);
  });

  it('draws 토론 as its posts now, no longer a 준비 중 slot (#47, ADR-0075)', () => {
    // ADR-0067 left 토론 its title and 준비 중; #47 fills the slot with the section of this market's
    // posts, which reads them by the market's id — and the server's `now`, which its 판정 이의 note
    // times the deadline from (#175).
    const source = readFileSync(path.join(SRC, 'app/markets/[slug]/market-detail.tsx'), 'utf8');
    expect(source).toContain('discussion: <MarketDiscussion marketId={marketId} now={now} />');
    expect(source).not.toContain('copy.marketDiscussion');
  });

  it('draws 내 거래 and 내 대기 주문 as the account’s own now, no longer 준비 중 slots (#123, ADR-0141)', () => {
    // The last two 준비 중 slots: 내 대기 주문 under 내 포지션, 내 거래 under 최근 체결 for a member.
    // Each is its own card with the slot's test id (components/orders), read in the browser only.
    const source = readFileSync(path.join(SRC, 'app/markets/[slug]/market-detail.tsx'), 'utf8');
    expect(source).not.toContain('ComingSoonSection');
    expect(source).not.toContain('copy.comingSoon');
    expect(source).toContain('<MarketMyOpenOrders marketId={marketId} />');
    expect(source).toContain('{member && <MyMarketTrades marketId={marketId} />}');
    for (const [file, slot] of [
      ['components/orders/pending-orders.tsx', 'market-my-open-orders'],
      ['components/orders/my-market-trades.tsx', 'market-my-trades'],
    ] as const) {
      const card = readFileSync(path.join(SRC, file), 'utf8');
      expect(card, slot).toContain(`<Card.Root data-testid="${slot}">`);
      expect(card, slot).not.toContain('copy.comingSoon');
    }
  });

  it('draws 호가창 as the public book now, no longer a 준비 중 slot (#122, ADR-0138)', () => {
    // The book section is its own card with the slot's test id and title (order-book.tsx); the
    // detail hands it the market's id, the live row for the close's re-read and the server's `now`.
    const source = readFileSync(path.join(SRC, 'app/markets/[slug]/market-detail.tsx'), 'utf8');
    expect(source).toContain('<OrderBookSection marketId={marketId} market={market} now={now} />');
    expect(source).not.toContain('testId="market-order-book"');
    expect(source).not.toContain('title={copy.marketOrderBook}');
    expect(source).toContain(
      "<MarketActivity marketId={marketId} market={data} now={now} member={viewer === 'member'} />",
    );
  });

  it('draws the public judging record from the live market in each responsive slot (#24)', () => {
    const source = readFileSync(path.join(SRC, 'app/markets/[slug]/market-detail.tsx'), 'utf8');
    const judging = source.slice(
      source.indexOf('judging: perWidth('),
      source.indexOf('\n  };', source.indexOf('judging: perWidth(')),
    );
    expect(judging).toMatch(/<MarketJudgingRecord\s+market=\{data\}/);
    expect(judging).toContain("testId={copyTestId('market-judging-record', width)}");
    expect(judging).not.toContain('ComingSoonSection');
  });
});

describe('the judging record anchor (#124, ADR-0143 결정 11-8)', () => {
  it('is the address 정산 줄 opens, on the market’s slug', () => {
    expect(JUDGING_RECORD_ANCHOR).toBe('judging-record');
    expect(judgingRecordPath('rate-cut-2026')).toBe('/markets/rate-cut-2026#judging-record');
  });

  it('scrolls to the copy this width draws, never the one in a hidden wrapper', () => {
    const md = { name: 'md', drawn: false };
    const base = { name: 'base', drawn: true };
    // DOM order is md first (`DETAIL_SLOTS`); below md that copy has no box.
    expect(drawnAnchor([md, base])).toBe(base);
    expect(
      drawnAnchor([
        { ...md, drawn: true },
        { ...base, drawn: false },
      ])?.name,
    ).toBe('md');
    expect(drawnAnchor([md, { ...base, drawn: false }])).toBeUndefined();
    expect(drawnAnchor([])).toBeUndefined();
  });

  it('is a data-anchor on each copy, never an id, and the detail scrolls once the row is there', () => {
    const record = readFileSync(
      path.join(SRC, 'components/market/market-judging-record.tsx'),
      'utf8',
    );
    expect(record).toContain('data-anchor={JUDGING_RECORD_ANCHOR}');
    // Two copies are in the document: an id would name the first, which may not be drawn.
    expect(record).not.toMatch(/\bid=\{?["'`]?judging-record/);
    expect(record).not.toContain('id={JUDGING_RECORD_ANCHOR}');
    const detail = readFileSync(path.join(SRC, 'app/markets/[slug]/market-detail.tsx'), 'utf8');
    expect(detail).toContain('useJudgingRecordAnchor(data !== undefined);');
    expect(detail).toContain(
      'if (!ready || window.location.hash !== `#${JUDGING_RECORD_ANCHOR}`) return;',
    );
    // The scroll itself is lib/market-detail.ts' (`scrollToJudgingRecord`), which the 결과 줄's
    // 판정 정정 mark and the recap's 판정 기록 보기 share (#144).
    expect(detail).toContain('scrollToJudgingRecord();');
    const lib = readFileSync(path.join(SRC, 'lib/market-detail.ts'), 'utf8');
    expect(lib).toContain("drawnAnchor(copies)?.element.scrollIntoView({ block: 'start' });");
  });
});

describe('the mobile 호가·거래 내역 switch', () => {
  it('has the two views in N02 §4 order and opens on 호가', () => {
    expect(DETAIL_VIEWS).toEqual(['book', 'history']);
    expect(DEFAULT_DETAIL_VIEW).toBe('book');
    expect(DETAIL_VIEW_ITEMS).toEqual([
      { value: 'book', label: copy.marketDetailViewBook },
      { value: 'history', label: copy.marketTradeHistory },
    ]);
    expect(DETAIL_VIEW_ITEMS.map((item) => item.label)).toEqual(['호가', '거래 내역']);
  });

  it("keeps N02 §4's short '호가' on the switch while the slot under it is titled 호가창", () => {
    // Owner decision 2026-10-17: the slots take the decision's own words, '호가창' and '공개 판정
    // 기록'; the switch's options are separate keys and did not change with them.
    expect(copy.marketOrderBook).toBe('호가창');
    expect(copy.marketJudgingRecord).toBe('공개 판정 기록');
    expect(copy.marketDetailViewBook).not.toBe(copy.marketOrderBook);
  });

  it("reads the switch's answer, and nothing it does not have", () => {
    expect(detailViewOf('book')).toBe('book');
    expect(detailViewOf('history')).toBe('history');
    for (const value of [null, '', 'Book', 'fills', 'mine']) {
      expect(detailViewOf(value), String(value)).toBeUndefined();
    }
  });

  it('displays only the chosen panel below md and both from md up', () => {
    expect(viewDisplay('book', 'book')).toEqual({ base: 'block', md: 'block' });
    expect(viewDisplay('book', 'history', 'flex')).toEqual({ base: 'none', md: 'flex' });
    expect(viewDisplay('history', 'history', 'flex')).toEqual({ base: 'flex', md: 'flex' });
    expect(viewDisplay('history', 'book')).toEqual({ base: 'none', md: 'block' });
    // Exactly one panel is drawn below md whatever is chosen, and never none of them.
    for (const chosen of DETAIL_VIEWS) {
      const drawn = DETAIL_VIEWS.filter((panel) => viewDisplay(chosen, panel).base !== 'none');
      expect(drawn).toEqual([chosen]);
    }
  });
});

describe('personalAreaView (ADR-0061 decision 1, item 18; owner decision 2026-10-17)', () => {
  it('is a member, who gets 내 포지션, 내 거래 and 내 대기 주문, once the session names one', () => {
    expect(personalAreaView({ isPending: false, signedIn: true })).toBe('member');
  });

  it('is a visitor, who gets the one sign-in prompt in their place, once the session is nobody', () => {
    expect(personalAreaView({ isPending: false, signedIn: false })).toBe('visitor');
  });

  it('is unknown while the session is — the server render and hydration — so nothing is drawn', () => {
    // `useSession` is pending through both, so the HTML holds neither a personal area nor the
    // prompt, for anybody.
    expect(personalAreaView({ isPending: true, signedIn: true })).toBe('unknown');
    expect(personalAreaView({ isPending: true, signedIn: false })).toBe('unknown');
  });

  it("says plainly what signing in shows: this market's own position, open orders and trades", () => {
    expect(copy.marketPersonalSignedOut).toBe(
      '로그인하면 이 시장의 내 포지션·대기 주문·거래를 볼 수 있습니다.',
    );
  });
});

describe('showsOrderArea (ADR-0048), delta24h and the 5-minute re-read (ADR-0139)', () => {
  it('is an open market only: every other status explains itself with the status notice', () => {
    for (const status of MARKET_STATUSES) {
      expect(showsOrderArea(status), status).toBe(status === 'open');
      // The 24시간 badge is 거래 중's alone (ADR-0135 결정 1의 5): not paused, not ended.
      expect(delta24h({ status, lastPrice: 63, lastPrice24hAgo: 61 }), status).toBe(
        status === 'open' ? 2 : null,
      );
    }
    // The row not loaded yet: no order area to promise, no badge.
    expect(showsOrderArea(undefined)).toBe(false);
    expect(LIVE_REFRESH_MS).toBe(5 * 60_000);
    // The detail re-reads its row on a fixed timer while 거래 중 (the component is not run here):
    // pin the call site. Not a `refetchInterval` — a tick's write re-arms that (#64 review), and
    // the row observer keeps `marketQueryOptions`' own settlement poll like every other screen.
    const source = readFileSync(path.join(SRC, 'app/markets/[slug]/market-detail.tsx'), 'utf8');
    expect(source).toContain('useMarket(marketId);');
    expect(source).toContain("useMarketBaselineRefresh(marketId, market.data?.status === 'open')");
    expect(source).not.toMatch(/refetchInterval|useMarket\(marketId, /);
    // A falling market reads negative; no baseline (no fill 24 hours back), no price or no move
    // is no badge — never a move from the open's 50%.
    expect(delta24h({ status: 'open', lastPrice: 58, lastPrice24hAgo: 61 })).toBe(-3);
    expect(delta24h({ status: 'open', lastPrice: 63, lastPrice24hAgo: null })).toBeNull();
    expect(delta24h({ status: 'open', lastPrice: null, lastPrice24hAgo: null })).toBeNull();
    expect(delta24h({ status: 'open', lastPrice: 61, lastPrice24hAgo: 61 })).toBeNull();
  });
});

describe('marketRefreshNotice (#78)', () => {
  it('says the market is not public any more when its refresh answers NOT_FOUND', () => {
    // A scheduled market sent back to a draft (ADR-0099): the refetch after its `market:status`.
    expect(
      marketRefreshNotice(new ApiError(404, { code: 'NOT_FOUND', message: 'x' } as never)),
    ).toBe(copy.marketNoLongerPublic);
    expect(marketRefreshNotice(new ApiError(503, undefined))).toBe(copy.marketRefreshFailed);
    expect(marketRefreshNotice(new TypeError('fetch failed'))).toBe(copy.marketRefreshFailed);
    expect(copy.marketNoLongerPublic).not.toContain(copy.marketStatusDraft);
  });
});

describe('statusNotice (PLAN 11.3, #174)', () => {
  it('says something for every public status but 거래 중, and nothing for the admin-only two', () => {
    // An open market's state is its countdown; a draft or one in review never reaches the route.
    for (const status of MARKET_STATUSES) {
      const notice = statusNotice({
        status,
        judgementDelayed: false,
        disputeUnderReview: false,
        resolvedResult: null,
      });
      const expected =
        (PUBLIC_MARKET_STATUSES as readonly string[]).includes(status) && status !== 'open';
      expect(notice !== undefined, status).toBe(expected);
    }
    // One sentence per status: no two read alike.
    const messages = PUBLIC_MARKET_STATUSES.filter((status) => status !== 'open').map(
      (status) =>
        statusNotice({
          status,
          judgementDelayed: false,
          disputeUnderReview: false,
          resolvedResult: null,
        })?.message,
    );
    expect(new Set(messages).size).toBe(messages.length);
  });

  it('warns where trading is stopped before the end, and says where the payout went once settled', () => {
    expect(
      statusNotice({
        status: 'paused',
        judgementDelayed: false,
        disputeUnderReview: false,
        resolvedResult: null,
      }),
    ).toEqual({
      tone: 'warning',
      message: copy.marketPausedNotice,
    });
    expect(
      statusNotice({
        status: 'closed',
        judgementDelayed: false,
        disputeUnderReview: false,
        resolvedResult: null,
      })?.tone,
    ).toBe('warning');
    // The 정산 sentence the old `resolved` notice carried is the payout's, now `settling`'s.
    expect(
      statusNotice({
        status: 'settling',
        judgementDelayed: false,
        disputeUnderReview: false,
        resolvedResult: 'YES',
      })?.message,
    ).toBe(copy.marketSettlingNotice);
    expect(
      statusNotice({
        status: 'settled',
        judgementDelayed: false,
        disputeUnderReview: false,
        resolvedResult: 'YES',
      }),
    ).toEqual({
      tone: 'success',
      message: copy.marketSettledNotice,
      detail: copy.marketSettledPayout,
    });
    expect(
      statusNotice({
        status: 'settled',
        judgementDelayed: false,
        disputeUnderReview: false,
        resolvedResult: 'NO',
      })?.detail,
    ).toBe(copy.marketSettledPayout);
  });

  it('says the payout followed the original result once a 판정 정정 is confirmed (#144, 144-5)', () => {
    // The 결과 줄 above shows the corrected result: the winning-side sentence keyed on either
    // result would be false — YES→NO is not "NO contracts were paid 100", VOID→YES paid no
    // 100 Coin per YES contract, YES→VOID paid no 50 Coin per contract.
    const settled = (
      resolvedResult: 'YES' | 'NO' | 'VOID',
      correction: { originalResult: 'YES' | 'NO' | 'VOID' } | null,
    ) =>
      statusNotice({
        status: 'settled',
        judgementDelayed: false,
        disputeUnderReview: false,
        resolvedResult,
        judgingRecord: { correction },
      });
    for (const [paid, label] of [
      ['YES', copy.yes],
      ['NO', copy.no],
      ['VOID', copy.marketResultVoid],
    ] as const) {
      const notice = settled(paid, { originalResult: paid });
      expect(notice?.tone, paid).toBe('success');
      expect(notice?.message, paid).toBe(copy.marketSettledNotice);
      expect(notice?.detail, paid).toBe(copy.marketSettledCorrected.replace('{paid}', label));
      expect(notice?.detail, paid).not.toContain('{paid}');
      expect(notice?.detail, paid).not.toContain('정답인 계약은 100 Coin씩');
      expect(notice?.detail, paid).not.toContain('50 Coin씩');
      expect(notice?.detail, paid).toContain('회수하지 않습니다');
    }
    expect(settled('YES', { originalResult: 'YES' })?.detail).toBe(
      '원래 결과(YES)로 지급했고, 지급한 Coin은 회수하지 않습니다. 판정 정정은 판정 기록에서 볼 수 있습니다.',
    );
    // No correction: today's sentences.
    expect(settled('NO', null)?.detail).toBe(copy.marketSettledPayout);
    expect(settled('VOID', null)?.detail).toBe(copy.marketSettledPayoutVoid);
  });

  it('never claims 100 Coin for a 무효 result, which has no winning side', () => {
    const notice = statusNotice({
      status: 'settled',
      judgementDelayed: false,
      disputeUnderReview: false,
      resolvedResult: 'VOID',
    });
    expect(notice?.detail).toBe(copy.marketSettledPayoutVoid);
    expect(notice?.detail).not.toContain('100');
    // Only a settled market carries the second line, whatever its result.
    for (const status of MARKET_STATUSES.filter((s) => s !== 'settled')) {
      expect(
        statusNotice({
          status,
          judgementDelayed: false,
          disputeUnderReview: false,
          resolvedResult: 'VOID',
        })?.detail,
        status,
      ).toBeUndefined();
    }
  });

  it("says '판정 지연' for a closed market past its scheduled judgement, never that it means NO (#22)", () => {
    const notice = statusNotice({
      status: 'closed',
      judgementDelayed: true,
      disputeUnderReview: false,
      resolvedResult: null,
    });
    expect(notice).toEqual({ tone: 'warning', message: copy.marketJudgementDelayedNotice });
    expect(notice?.message).not.toBe(copy.marketClosedNotice);
    for (const word of ['NO', '환불', '원금']) expect(notice?.message).not.toContain(word);
    // Only a closed market: a flag read before a later status moved the row says nothing then
    // (a 잠정 결과's delay is its own line, below).
    for (const status of MARKET_STATUSES.filter((s) => s !== 'closed' && s !== 'provisional')) {
      expect(
        statusNotice({
          status,
          judgementDelayed: true,
          disputeUnderReview: false,
          resolvedResult: null,
        }),
        status,
      ).toEqual(
        statusNotice({
          status,
          judgementDelayed: false,
          disputeUnderReview: false,
          resolvedResult: null,
        }),
      );
    }
  });

  it('keeps the 잠정 결과 sentence and adds why it waits while a 판정 이의 holds it (#175)', () => {
    const base = { status: 'provisional' as const, resolvedResult: 'NO' as const };
    expect(statusNotice({ ...base, judgementDelayed: false, disputeUnderReview: false })).toEqual({
      tone: 'info',
      message: copy.marketProvisionalNotice,
    });
    // '이의 검토 중' before the deadline.
    expect(statusNotice({ ...base, judgementDelayed: false, disputeUnderReview: true })).toEqual({
      tone: 'info',
      message: copy.marketProvisionalNotice,
      detail: copy.marketProvisionalUnderReview,
    });
    // '판정 지연' past it (owner answer 2026-11-03): still the 잠정 결과, now a warning.
    const late = statusNotice({ ...base, judgementDelayed: true, disputeUnderReview: true });
    expect(late).toEqual({
      tone: 'warning',
      message: copy.marketProvisionalNotice,
      detail: copy.marketProvisionalDelayed,
    });
    // '판정 지연' past it with no dispute holding it: a correction waits for its approval (#176,
    // ADR-0105, decision 3 '#176 정정 대기') — the judgement reviewed again, no dispute named.
    expect(statusNotice({ ...base, judgementDelayed: true, disputeUnderReview: false })).toEqual({
      tone: 'warning',
      message: copy.marketProvisionalNotice,
      detail: copy.marketProvisionalDelayedCorrection,
    });
    expect(copy.marketProvisionalDelayedCorrection).not.toContain('이의를 검토');
    // Never the CLOSED market's delay sentence, nor a promise of a result, a refund or a payout —
    // nor that a correction changes the result: it may be rejected.
    expect(late?.message).not.toBe(copy.marketJudgementDelayedNotice);
    for (const text of [
      copy.marketProvisionalUnderReview,
      copy.marketProvisionalDelayed,
      copy.marketProvisionalDelayedCorrection,
    ]) {
      expect(text).not.toMatch(/NO|YES|환불|원금|지급|정정/);
    }
    // A cached flag says nothing once the market moved on: a confirmed market reads its own.
    expect(
      statusNotice({
        ...base,
        status: 'resolved',
        judgementDelayed: true,
        disputeUnderReview: true,
      }),
    ).toEqual({ tone: 'info', message: copy.marketResolvedNotice });
  });

  it('names a cancelled market as one with no result, and promises nothing about a refund', () => {
    const notice = statusNotice({
      status: 'cancelled',
      judgementDelayed: false,
      disputeUnderReview: false,
      resolvedResult: null,
    });
    expect(notice?.message).toBe(copy.marketCancelledNotice);
    expect(notice?.message).not.toContain('환불');
    expect(notice?.detail).toBeUndefined();
  });
});

describe('the 판정 지연 기록 on the detail (#142, ADR-0106)', () => {
  const delay = {
    reason: '출처의 발표가 늦어지고 있습니다.',
    nextReviewAt: '2026-12-02T01:00:00.000Z',
    nextReviewPassed: false,
  };

  it('is shown while the market reads 판정 지연, CLOSED or PROVISIONAL, and never otherwise', () => {
    const base = { judgementDelayed: true, disputeUnderReview: false, judgementDelay: delay };
    expect(shownJudgementDelay({ ...base, status: 'closed' })).toBe(delay);
    expect(shownJudgementDelay({ ...base, status: 'provisional', disputeUnderReview: true })).toBe(
      delay,
    );
    // A row the socket moved on, its flag reset (`applyStatus`): no record stands on it.
    expect(shownJudgementDelay({ ...base, status: 'closed', judgementDelayed: false })).toBeNull();
    for (const status of MARKET_STATUSES.filter((s) => s !== 'closed' && s !== 'provisional')) {
      expect(shownJudgementDelay({ ...base, status }), status).toBeNull();
    }
    expect(shownJudgementDelay({ ...base, status: 'closed', judgementDelay: null })).toBeNull();
  });

  it('waits for the next review time while the API read it ahead, and for nothing after', () => {
    expect(nextReviewWaitAt(delay)).toBe(delay.nextReviewAt);
    // 갱신 대기 already: nothing left to wait for; no record, nothing either.
    expect(nextReviewWaitAt({ ...delay, nextReviewPassed: true })).toBeNull();
    expect(nextReviewWaitAt(null)).toBeNull();
  });

  it('keeps the notice’s own sentence, with or without a record', () => {
    // The rows are the detail's (`StatusNotice`); the sentence never says a late result is NO.
    const delayed = {
      status: 'closed',
      judgementDelayed: true,
      disputeUnderReview: false,
      resolvedResult: null,
    } as const;
    expect(statusNotice(delayed)).toEqual({
      tone: 'warning',
      message: copy.marketJudgementDelayedNotice,
    });
  });
});

describe('the mobile order sheet (the #122 row in ADR-0061 decision 3)', () => {
  it("closes at Chakra's md, the width that hides the bar and draws the order column", () => {
    // The condition `hideFrom="md"` and `hideBelow="md"` compile to — 48rem, 768px — written the
    // way `matchMedia` takes it (no `@media`).
    expect(MD_UP_MEDIA_QUERY).toBe('screen and (min-width: 48rem)');
  });

  it('has two entry points, YES 매수 then NO 매수, whose words carry no price', () => {
    expect(ORDER_ENTRY_CONTRACTS).toEqual(['YES', 'NO']);
    expect(ORDER_ENTRY_CONTRACTS.map(orderEntryLabel)).toEqual(['YES 매수', 'NO 매수']);
    for (const contract of ORDER_ENTRY_CONTRACTS) {
      // The words are the server's HTML: the price is a slot of its own (`orderEntryPrice`).
      expect(orderEntryLabel(contract)).not.toMatch(/\d|%|Coin/);
    }
  });

  it("prices an entry point with the contract's best ask, or 호가 없음 (ADR-0135 D2, #66)", () => {
    // A whole-Coin price as the book writes it, never a probability or 100 − a bid.
    expect(orderEntryPrice(63)).toBe('63.00 Coin');
    expect(orderEntryPrice(1)).toBe('1.00 Coin');
    expect(orderEntryPrice(99)).toBe('99.00 Coin');
    expect(orderEntryPrice(null)).toBe(copy.marketBookEmpty);
    // The book not known yet: the slot stays blank.
    expect(orderEntryPrice(undefined)).toBeUndefined();
  });

  it('names the gap’s reason where the price stands, not 호가 없음 (ADR-0140 결정 2-23)', () => {
    // A book that answers with a reason has empty sides: they are not merely unquoted.
    expect(orderEntryPrice(null, 'closed')).toBe(copy.orderClosedShortClosed);
    expect(orderEntryPrice(null, 'paused')).toBe(copy.orderClosedShortPaused);
    expect(orderEntryPrice(null, 'not_open_yet')).toBe(copy.orderClosedShortNotOpenYet);
    // The close passed on the clock before the book said so: the reason, whatever the book holds.
    expect(orderEntryPrice(63, 'closed')).toBe(copy.orderClosedShortClosed);
    expect(orderEntryPrice(undefined, 'closed')).toBe(copy.orderClosedShortClosed);
    expect(orderEntryPrice(null, null)).toBe(copy.marketBookEmpty);
  });

  it('holds the order panel for a visitor and a member alike, and waits while the session is unknown', () => {
    // ADR-0135 D3: a visitor types and reads a quote too, and is asked to sign in at 주문 확인.
    expect(orderSheetBody('visitor')).toBe('panel');
    expect(orderSheetBody('member')).toBe('panel');
    // Nothing until the session answers, so nobody is shown one panel and then another.
    expect(orderSheetBody('unknown')).toBe('pending');
  });

  it('starts closed with no contract, and opens on whichever entry point was pressed', () => {
    expect(INITIAL_ORDER_SHEET).toEqual({ open: false, contract: null });
    expect(openOrderSheet('YES')).toEqual({ open: true, contract: 'YES' });
    expect(openOrderSheet('NO')).toEqual({ open: true, contract: 'NO' });
  });

  it('keeps the focus out of the band the bar and the tab bar cover (WCAG 2.2 SC 2.4.11)', () => {
    // 46 + 69 = the two bars, measured edge to edge by market.spec.ts, and 4 for the outside focus
    // ring (2px at a 2px offset); the home-indicator inset both bars stand on is added in CSS.
    expect(BOTTOM_TABS_HEIGHT_PX + ORDER_ENTRY_BAR_HEIGHT_PX).toBe(115);
    expect(ORDER_ENTRY_SCROLL_PADDING).toBe('calc(119px + env(safe-area-inset-bottom))');
  });

  it('sticks the md-and-up order column where it stands and fits it in the window (결정 2-24)', () => {
    // The header (107) and the page's md top padding (40): no jump as the page starts to scroll.
    expect(ORDER_COLUMN_TOP).toBe('147px');
    // Top + height = the window less 16px, so the card's bottom edge is on the first screen.
    expect(ORDER_COLUMN_MAX_H).toBe('calc(100dvh - 163px)');
    // The padding it counts is the page's own.
    const page = readFileSync(path.join(SRC, 'app/markets/[slug]/page.tsx'), 'utf8');
    expect(DETAIL_TOP_PADDING_MD_PX).toBe(40);
    expect(page).toContain("py={{ base: '6', md: '10' }}");
    const detail = readFileSync(path.join(SRC, 'app/markets/[slug]/market-detail.tsx'), 'utf8');
    expect(detail).toContain('top={ORDER_COLUMN_TOP}');
    expect(detail).toContain('maxH={ORDER_COLUMN_MAX_H}');
  });

  it('remembers the contract through a close, and the next press replaces it', () => {
    const closed = closeOrderSheet(openOrderSheet('NO'));
    expect(closed).toEqual({ open: false, contract: 'NO' });
    expect(openOrderSheet('YES')).toEqual({ open: true, contract: 'YES' });
    // Closing a closed sheet changes nothing.
    expect(closeOrderSheet(closed)).toEqual(closed);
    expect(closeOrderSheet(INITIAL_ORDER_SHEET)).toEqual(INITIAL_ORDER_SHEET);
  });
});

/**
 * The window ADR-0135 결과 4 names between `close_at` and the worker's close, and a ledger hold
 * (ADR-0138's reason on the book): an open market keeps its order area with the input off.
 */
describe('orderInputClosedReason (#66, ADR-0140)', () => {
  const book = (marketRejectReason: 'closed' | 'paused' | 'not_open_yet' | null) => ({
    marketRejectReason,
  });

  it("takes the book's reason on an open market", () => {
    expect(orderInputClosedReason('open', book('paused'), false)).toBe('paused');
    expect(orderInputClosedReason('open', book('closed'), false)).toBe('closed');
  });

  it('says 마감 at the close instant, ahead of the book read a second later', () => {
    expect(orderInputClosedReason('open', book(null), true)).toBe('closed');
    expect(orderInputClosedReason('open', undefined, true)).toBe('closed');
  });

  it('is null on an open market before its close with a book that takes orders', () => {
    expect(orderInputClosedReason('open', book(null), false)).toBeNull();
    expect(orderInputClosedReason('open', undefined, false)).toBeNull();
  });

  it('is null where there is no order area at all: the status notice speaks there (D1)', () => {
    expect(orderInputClosedReason('paused', book('paused'), true)).toBeNull();
    expect(orderInputClosedReason('closed', book('closed'), true)).toBeNull();
    expect(orderInputClosedReason(undefined, undefined, true)).toBeNull();
  });
});

describe('backgroundText (배경)', () => {
  it('is the description as written, line breaks kept', () => {
    expect(backgroundText('첫 줄\n둘째 줄')).toBe('첫 줄\n둘째 줄');
    expect(backgroundText('  앞뒤 공백  ')).toBe('  앞뒤 공백  ');
  });

  it('is nothing for a market without one, blank and whitespace-only included', () => {
    for (const description of [null, '', ' ', '\n\t ']) {
      expect(backgroundText(description), JSON.stringify(description)).toBeNull();
    }
  });
});

describe('ruleText (규칙 항목, #23)', () => {
  it('is the text as written, line breaks kept, and nothing while it is blank', () => {
    expect(ruleText('첫 줄\n둘째 줄')).toBe('첫 줄\n둘째 줄');
    for (const text of ['', ' ', '\n\t ']) {
      expect(ruleText(text), JSON.stringify(text)).toBeNull();
    }
  });
});

describe('sourceView (ADR-0093 decision 3 #23 출처 주소)', () => {
  it('links the name to an http(s) address, trimmed', () => {
    expect(sourceView({ name: '한국은행', url: 'https://www.bok.or.kr' })).toEqual({
      text: '한국은행',
      href: 'https://www.bok.or.kr',
    });
    expect(sourceView({ name: ' 통계청 ', url: ' http://kostat.go.kr/a?b=1 ' })).toEqual({
      text: '통계청',
      href: 'http://kostat.go.kr/a?b=1',
    });
    // The API's own scheme check is case-blind (`market_sources`' CHECK as well).
    expect(sourceView({ name: '기상청', url: 'HTTPS://WWW.KMA.GO.KR' })?.href).toBe(
      'HTTPS://WWW.KMA.GO.KR',
    );
  });

  it('keeps the name as text with no address, or one that is not http(s)', () => {
    for (const url of ['', '   ', 'ftp://example.com', 'javascript:alert(1)', 'www.example.com']) {
      expect(sourceView({ name: '출처', url }), url).toEqual({ text: '출처', href: null });
    }
  });

  it('shows the address as text when there is no name, and nothing for no source', () => {
    expect(sourceView({ name: '', url: 'https://example.com' })).toEqual({
      text: 'https://example.com',
      href: null,
    });
    expect(sourceView({ name: ' ', url: ' ' })).toBeNull();
    expect(sourceView(null)).toBeNull();
  });
});

describe('longDelayText (장기 지연 기한, #172 item 10)', () => {
  it('counts the days from the scheduled judgement, and is nothing while unset', () => {
    expect(longDelayText(14)).toBe('예정 판정 시각에서 14일 뒤');
    expect(longDelayText(1)).toBe('예정 판정 시각에서 1일 뒤');
    expect(longDelayText(365)).toBe('예정 판정 시각에서 365일 뒤');
    expect(longDelayText(null)).toBeNull();
  });

  it('is followed by the instant itself, after a separator that is no sentence of its own (#22)', () => {
    // The row reads '… 14일 뒤 · <instant>' (rules-section.tsx); the separator carries no word.
    expect(LONG_DELAY_SEPARATOR.trim()).toBe('·');
  });
});

describe('showsScheduledOpen (예정 개장 시각, #22)', () => {
  it('is before the open only: a draft in the preview, one in review, a scheduled market', () => {
    for (const status of MARKET_STATUSES) {
      expect(showsScheduledOpen(status), status).toBe(
        status === 'draft' || status === 'review' || status === 'scheduled',
      );
    }
  });
});

describe('voidPayoutText (무효 지급, #173 item 9)', () => {
  it('reads the amounts from the contract terms, 50/50 today', () => {
    expect(voidPayoutText()).toBe(
      `무효로 판정되면 YES 계약은 계약마다 ${formatCoin(CONTRACT_TERMS.voidPayoutYesCoin)}, NO 계약은 계약마다 ${formatCoin(CONTRACT_TERMS.voidPayoutNoCoin)}을 지급합니다. 모든 시장에 같은 규칙입니다.`,
    );
    expect(voidPayoutText()).toContain('YES 계약은 계약마다 50 Coin, NO 계약은 계약마다 50 Coin을');
    // Other terms, other line: the amounts are never written into the copy.
    const other = voidPayoutText({ voidPayoutYesCoin: 40, voidPayoutNoCoin: 60 });
    expect(other).toContain('YES 계약은 계약마다 40 Coin, NO 계약은 계약마다 60 Coin을');
  });

  it('promises no refund (N03 §6)', () => {
    for (const word of ['환불', '원금', '돌려']) expect(voidPayoutText()).not.toContain(word);
  });
});

describe('complementReading (ADR-0061 decision 1, item 2; its own line, owner decision 2026-10-17)', () => {
  it('is NO as the complement of the same last fill, so YES and NO add up to 100', () => {
    expect(complementReading(63)).toBe(`${copy.no} 37%`);
    for (const price of [1, 50, 99]) {
      const reading = complementReading(price);
      expect(reading).toBe(`${copy.no} ${String(100 - price)}%`);
    }
  });

  it('is nothing before the first fill, when the header says 체결 없음 once', () => {
    expect(complementReading(null)).toBeNull();
  });
});
