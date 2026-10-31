import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  MARKET_STATUSES,
  PROPOSED_CONTRACT_TERMS,
  PUBLIC_MARKET_STATUSES,
  formatCoin,
} from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { SRC } from '../test/screen-text';
import { BOTTOM_TABS_HEIGHT_PX, ORDER_ENTRY_BAR_HEIGHT_PX } from './nav';
import {
  DEFAULT_DETAIL_VIEW,
  DETAIL_SLOTS,
  DETAIL_VIEWS,
  DETAIL_VIEW_ITEMS,
  type DetailWidth,
  INITIAL_ORDER_SHEET,
  MD_UP_MEDIA_QUERY,
  ORDER_ENTRY_CONTRACTS,
  ORDER_ENTRY_SCROLL_PADDING,
  backgroundText,
  closeOrderSheet,
  complementReading,
  copyDisplay,
  copyTestId,
  detailViewOf,
  drawnOrder,
  longDelayText,
  openOrderSheet,
  orderEntryLabel,
  orderSheetBody,
  perWidth,
  personalAreaView,
  ruleText,
  showsOrderArea,
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
    // posts, which reads them by the market's id. The other 준비 중 slots are untouched.
    const source = readFileSync(path.join(SRC, 'app/markets/[slug]/market-detail.tsx'), 'utf8');
    expect(source).toContain('discussion: <MarketDiscussion marketId={marketId} />');
    expect(source).not.toContain('copy.marketDiscussion');
    for (const slot of ['market-order-book', 'market-my-trades', 'market-my-open-orders']) {
      expect(source, slot).toContain(`testId="${slot}"`);
    }
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

describe('showsOrderArea (ADR-0048)', () => {
  it('is an open market only: every other status explains itself with the status notice', () => {
    for (const status of MARKET_STATUSES) {
      expect(showsOrderArea(status), status).toBe(status === 'open');
    }
    // The row not loaded yet: no order area to promise.
    expect(showsOrderArea(undefined)).toBe(false);
  });
});

describe('statusNotice (PLAN 11.3, #174)', () => {
  it('says something for every public status but 거래 중, and nothing for the admin-only two', () => {
    // An open market's state is its countdown; a draft or one in review never reaches the route.
    for (const status of MARKET_STATUSES) {
      const notice = statusNotice({ status, resolvedResult: null });
      const expected =
        (PUBLIC_MARKET_STATUSES as readonly string[]).includes(status) && status !== 'open';
      expect(notice !== undefined, status).toBe(expected);
    }
    // One sentence per status: no two read alike.
    const messages = PUBLIC_MARKET_STATUSES.filter((status) => status !== 'open').map(
      (status) => statusNotice({ status, resolvedResult: null })?.message,
    );
    expect(new Set(messages).size).toBe(messages.length);
  });

  it('warns where trading is stopped before the end, and says where the payout went once settled', () => {
    expect(statusNotice({ status: 'paused', resolvedResult: null })).toEqual({
      tone: 'warning',
      message: copy.marketPausedNotice,
    });
    expect(statusNotice({ status: 'closed', resolvedResult: null })?.tone).toBe('warning');
    // The 정산 sentence the old `resolved` notice carried is the payout's, now `settling`'s.
    expect(statusNotice({ status: 'settling', resolvedResult: 'YES' })?.message).toBe(
      copy.marketSettlingNotice,
    );
    expect(statusNotice({ status: 'settled', resolvedResult: 'YES' })).toEqual({
      tone: 'success',
      message: copy.marketSettledNotice,
      detail: copy.marketSettledPayout,
    });
    expect(statusNotice({ status: 'settled', resolvedResult: 'NO' })?.detail).toBe(
      copy.marketSettledPayout,
    );
  });

  it('never claims 100 Coin for a 무효 result, which has no winning side', () => {
    const notice = statusNotice({ status: 'settled', resolvedResult: 'VOID' });
    expect(notice?.detail).toBe(copy.marketSettledPayoutVoid);
    expect(notice?.detail).not.toContain('100');
    // Only a settled market carries the second line, whatever its result.
    for (const status of MARKET_STATUSES.filter((s) => s !== 'settled')) {
      expect(statusNotice({ status, resolvedResult: 'VOID' })?.detail, status).toBeUndefined();
    }
  });

  it('names a cancelled market as one with no result, and promises nothing about a refund', () => {
    const notice = statusNotice({ status: 'cancelled', resolvedResult: null });
    expect(notice?.message).toBe(copy.marketCancelledNotice);
    expect(notice?.message).not.toContain('환불');
    expect(notice?.detail).toBeUndefined();
  });
});

describe('the mobile order sheet (the #122 row in ADR-0061 decision 3)', () => {
  it("closes at Chakra's md, the width that hides the bar and draws the order column", () => {
    // The condition `hideFrom="md"` and `hideBelow="md"` compile to — 48rem, 768px — written the
    // way `matchMedia` takes it (no `@media`).
    expect(MD_UP_MEDIA_QUERY).toBe('screen and (min-width: 48rem)');
  });

  it('has two entry points, YES 매수 then NO 매수, with no price on either', () => {
    expect(ORDER_ENTRY_CONTRACTS).toEqual(['YES', 'NO']);
    expect(ORDER_ENTRY_CONTRACTS.map(orderEntryLabel)).toEqual(['YES 매수', 'NO 매수']);
    for (const contract of ORDER_ENTRY_CONTRACTS) {
      // Neither a percent nor a Coin price nor a digit at all.
      expect(orderEntryLabel(contract)).not.toMatch(/\d|%|Coin/);
    }
  });

  it('asks a visitor to sign in, tells a member 거래 준비 중, and waits while the session is unknown', () => {
    // N02 §2: an order is placed signed in (owner decision 2026-10-17, '시트에 로그인 안내').
    expect(orderSheetBody('visitor')).toBe('login');
    expect(orderSheetBody('member')).toBe('preparing');
    // Neither line until the session answers, so nobody reads one and then the other.
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

  it('remembers the contract through a close, and the next press replaces it', () => {
    const closed = closeOrderSheet(openOrderSheet('NO'));
    expect(closed).toEqual({ open: false, contract: 'NO' });
    expect(openOrderSheet('YES')).toEqual({ open: true, contract: 'YES' });
    // Closing a closed sheet changes nothing.
    expect(closeOrderSheet(closed)).toEqual(closed);
    expect(closeOrderSheet(INITIAL_ORDER_SHEET)).toEqual(INITIAL_ORDER_SHEET);
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
});

describe('voidPayoutText (무효 지급, #173 item 9)', () => {
  it('reads the amounts from the contract terms, 50/50 today', () => {
    expect(voidPayoutText()).toBe(
      `무효로 판정되면 YES 계약은 계약마다 ${formatCoin(PROPOSED_CONTRACT_TERMS.voidPayoutYesCoin)}, NO 계약은 계약마다 ${formatCoin(PROPOSED_CONTRACT_TERMS.voidPayoutNoCoin)}을 지급합니다. 모든 시장에 같은 규칙입니다.`,
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
