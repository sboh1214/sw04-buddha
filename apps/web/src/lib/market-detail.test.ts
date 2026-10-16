import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MARKET_STATUSES } from '@buddha/shared';
import { describe, expect, it } from 'vitest';
import { copy } from '@/copy';
import { SRC } from '../test/screen-text';
import { BOTTOM_TABS_HEIGHT_PX, ORDER_ENTRY_BAR_HEIGHT_PX } from './nav';
import {
  DEFAULT_DETAIL_VIEW,
  DETAIL_SECTIONS,
  DETAIL_VIEWS,
  DETAIL_VIEW_ITEMS,
  INITIAL_ORDER_SHEET,
  MD_UP_MEDIA_QUERY,
  ORDER_ENTRY_CONTRACTS,
  ORDER_ENTRY_SCROLL_PADDING,
  backgroundText,
  closeOrderSheet,
  complementReading,
  detailViewOf,
  drawnOrder,
  openOrderSheet,
  orderEntryLabel,
  orderSheetBody,
  personalAreaView,
  sectionOrder,
  showsOrderArea,
  viewDisplay,
} from './market-detail';

describe('the detail sections (#122, ADR-0061 decision 1, item 16)', () => {
  it("is N02 §4's list, and md and up draws it unmoved", () => {
    // 질문·배경·규칙·출처·마감(·판정 기록), 가격 차트, 호가·최근 체결, 내 포지션·대기 주문, 토론.
    expect(DETAIL_SECTIONS).toEqual([
      'summary',
      'background',
      'rules',
      'judging',
      'chart',
      'activity',
      'position',
      'discussion',
    ]);
    expect(drawnOrder('md')).toEqual([...DETAIL_SECTIONS]);
    for (const section of DETAIL_SECTIONS) expect(sectionOrder(section).md).toBe(0);
  });

  it('is the order the detail renders: MarketDetail iterates this list, once, for every key', () => {
    // Without a DOM the page cannot be rendered here, so this reads the component's source: the
    // sections come out of one `DETAIL_SECTIONS.map` over a record that must name every key, not
    // out of JSX written in its own order beside a list nobody reads. The DOM order itself is
    // pinned by market.spec.ts (`expectTopToBottom`).
    const source = readFileSync(path.join(SRC, 'app/markets/[slug]/market-detail.tsx'), 'utf8');
    expect(source.match(/DETAIL_SECTIONS\.map\(/g)).toHaveLength(1);
    expect(source).toContain('Record<DetailSection, ReactNode>');
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
    ]);
  });

  it('moves only the three lifted sections, so the others need no order prop', () => {
    const moved = DETAIL_SECTIONS.filter((section) => sectionOrder(section).base !== 0);
    expect(moved).toEqual(['summary', 'chart', 'activity']);
    expect(moved.map((section) => sectionOrder(section).base)).toEqual([-3, -2, -1]);
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
