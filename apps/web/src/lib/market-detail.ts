import { type MarketStatus, type Outcome } from '@buddha/shared';
import { copy } from '@/copy';
import { system } from '@/theme/system';
import { formatNoPrice } from './market-admin';
import { BOTTOM_TABS_HEIGHT_PX, ORDER_ENTRY_BAR_HEIGHT_PX } from './nav';

/**
 * 시장 상세의 배치 틀 (#122, ADR-0067): which section goes where at each width, what the mobile
 * 호가·거래 내역 switch shows, who sees the personal areas or the one sign-in prompt in their place,
 * and what the mobile order sheet holds. Pure functions, kept out of
 * `app/markets/[slug]/market-detail.tsx` so the node test runner can reach them (vitest runs with
 * no DOM here); the component only lays them out.
 *
 * The order is the owner's (ADR-0061 decision 1, item 16): N02 §4's list — 질문·배경·규칙·출처·마감,
 * 가격 차트, YES/NO 호가, 최근 체결, 주문 패널, 내 포지션·대기 주문, 토론, 관련 시장 — and below md
 * N02 §4's own exception for the first screen: 요약 and the chart, then 호가·거래 내역 to switch
 * between. Where the list leaves a gap (the public judging record, 내 거래) the owner placed it from
 * this PR's screenshots (owner decisions 2026-10-17, ADR-0067 decision 2).
 */

/**
 * The detail's sections in the order the DOM holds them and md and up draws them: N02 §4's list.
 * `MarketDetail` renders its sections by iterating this list (a section-to-node record it has to
 * fill for every key), so this is the order on the page and not a description of it — moving a key
 * here moves the section. The order panel is not one of them — it is the right column from md up
 * and a sheet below it.
 *
 * - `summary`: the header — category trail, status, countdown, 관심 등록, the question, YES·NO,
 *   거래량, 참여자 and the status notice. It is the mobile first screen's '요약' as well.
 * - `background`: 배경 (`Market.description`), only when the market has one.
 * - `rules`: 규칙·출처·마감. 예정 판정일 has no data before #22 and so no slot.
 * - `judging`: 공개 판정 기록 (#24), right after the rules it applies, on every public status
 *   (owner decision 2026-10-17).
 * - `chart`: 가격 차트.
 * - `activity`: 호가창 (#179), then 최근 체결 and 내 거래 — the mobile switch's two views.
 * - `position`: 내 포지션, and 내 대기 주문 (#123) under it, for a signed-in reader — or, for a
 *   signed-out visitor, the one sign-in prompt that stands for all the personal areas
 *   (`personalAreaView`).
 * - `discussion`: 토론 (#47). 관련 시장 (#65) comes after it.
 */
export const DETAIL_SECTIONS = [
  'summary',
  'background',
  'rules',
  'judging',
  'chart',
  'activity',
  'position',
  'discussion',
] as const;
export type DetailSection = (typeof DETAIL_SECTIONS)[number];

/**
 * Below md the first screen is 요약 and the chart, and the 호가·거래 내역 switch follows them (N02 §4):
 * these three are drawn ahead of the rest, in this order, and everything else keeps the DOM order
 * after them. From md up nothing is moved. A lifted section is one element that carries its own
 * `order={sectionOrder(...)}` — the three here are.
 */
const MOBILE_FIRST: readonly DetailSection[] = ['summary', 'chart', 'activity'];

/**
 * A section's CSS `order` in the detail's flex column, per breakpoint: the lifted three take
 * −3, −2 and −1 below md, ahead of everyone else's 0, and every section is 0 from md up, so the DOM
 * order is the desktop order. Only the lifted sections need the prop; for the rest it is 0 anyway.
 *
 * The DOM keeps N02 §4's order rather than the mobile one because the moved sections hold the same
 * focus stops in the same relative order either way — 배경, 규칙 and 판정 기록 have none — so the
 * keyboard order matches what is drawn at both widths.
 */
export function sectionOrder(section: DetailSection): { base: number; md: number } {
  const lifted = MOBILE_FIRST.indexOf(section);
  return { base: lifted < 0 ? 0 : lifted - MOBILE_FIRST.length, md: 0 };
}

/** The order the sections are drawn in at a width: a stable sort of the DOM order by `order`. */
export function drawnOrder(width: 'base' | 'md'): DetailSection[] {
  return DETAIL_SECTIONS.map((section, index) => ({ section, index }))
    .sort(
      (a, b) =>
        sectionOrder(a.section)[width] - sectionOrder(b.section)[width] || a.index - b.index,
    )
    .map(({ section }) => section);
}

/** The two views of the mobile switch (N02 §4 '호가·거래 내역을 전환'). */
export const DETAIL_VIEWS = ['book', 'history'] as const;
export type DetailView = (typeof DETAIL_VIEWS)[number];

/** The view the switch opens on: 호가, the first of the two N02 §4 names. */
export const DEFAULT_DETAIL_VIEW: DetailView = 'book';

/**
 * The switch's options, in N02 §4's order. `SegmentGroup.Items` renders them as radios. Their
 * labels are N02 §4's own words for the two views, '호가' and '거래 내역' — not the section titles
 * under them: the 호가 panel's slot is titled '호가창' (owner decision 2026-10-17), and the switch
 * keeps the short name.
 */
export const DETAIL_VIEW_ITEMS: { value: DetailView; label: string }[] = [
  { value: 'book', label: copy.marketDetailViewBook },
  { value: 'history', label: copy.marketTradeHistory },
];

/** The switch's answer as a view, or `undefined` for a value it does not have. */
export function detailViewOf(value: string | null): DetailView | undefined {
  return DETAIL_VIEWS.find((view) => view === value);
}

/**
 * Whether a view's panel is drawn, per breakpoint: below md only the chosen one, from md up both
 * (the switch is not drawn there, and 호가 and 최근 체결 stand one under the other). The value is a
 * CSS `display`, so both panels are always in the DOM — and in the server's HTML — and switching
 * neither mounts nor fetches anything.
 */
export function viewDisplay(
  chosen: DetailView,
  panel: DetailView,
  shown: 'block' | 'flex' = 'block',
): { base: 'none' | 'block' | 'flex'; md: 'block' | 'flex' } {
  return { base: chosen === panel ? shown : 'none', md: shown };
}

/**
 * Who is reading, as far as the detail's personal parts care:
 *
 * - `unknown`: the session is not known yet, which is always the case on the server and through
 *   hydration (`useSession`). Nothing personal is drawn — neither the areas nor the prompt — so
 *   the detail's HTML is the same for every visitor (AC 2).
 * - `member`: signed in. The personal areas — 내 포지션, 내 거래 and 내 대기 주문 — are drawn
 *   (ADR-0061 decision 1, item 18; #122 '내 포지션·대기 주문 영역은 로그인한 본인에게만').
 * - `visitor`: signed out. None of the areas, and ONE sign-in prompt where 내 포지션 · 내 대기 주문
 *   would stand, which speaks for all three (owner decision 2026-10-17, '로그인 안내 하나'). 내
 *   거래's place in 거래 내역 stays empty: a second prompt there would only repeat the first.
 */
export type PersonalAreaView = 'unknown' | 'member' | 'visitor';

export function personalAreaView(session: {
  isPending: boolean;
  signedIn: boolean;
}): PersonalAreaView {
  if (session.isPending) return 'unknown';
  return session.signedIn ? 'member' : 'visitor';
}

/**
 * Whether the order area exists at all — the desktop column, the mobile YES·NO 매수 bar and its
 * sheet: on an open market only (ADR-0048 decision 5 and result 6). Any other status explains
 * itself with the status notice, and a `market:status` that closes the market takes the three
 * away with it. `undefined` is the row not loaded yet.
 */
export function showsOrderArea(status: MarketStatus | undefined): boolean {
  return status === 'open';
}

/**
 * Chakra's `md` and up as a `matchMedia` query: the width from which `hideFrom="md"` hides the
 * 매수 bar and `hideBelow="md"` draws the order column. The mobile order sheet closes when the
 * viewport reaches it (order-entry-bar.tsx). Read off the app's own system, so it is the condition
 * those two props compile to and cannot drift from them.
 */
export const MD_UP_MEDIA_QUERY = system.breakpoints.up('md').replace(/^@media\s+/, '');

/**
 * How far Chakra's outside focus ring reaches past a control's box: 2px wide at a 2px offset
 * (`focusVisibleRing="outside"`, the buttons' and the radios' ring).
 */
const FOCUS_RING_EXTENT_PX = 4;

/**
 * The page's `scroll-padding-bottom` below md while an open market's 매수 bar is drawn: the band the
 * bar and the tab bar under it cover — their two heights and the home-indicator inset both stand
 * on — plus the reach of a focus ring (WCAG 2.2 SC 2.4.11, Focus Not Obscured).
 *
 * A browser scrolls a newly focused control into view only when it lies outside the scrollport,
 * and the two bars are overlays, which do not count; so without this a control resting in the
 * band took the focus with no scroll, its ring drawn under the bar. With it the band is outside
 * the scrollport's optimal viewing region, so focusing such a control scrolls it above the bar,
 * the way the browser scrolls one that is off screen.
 */
export const ORDER_ENTRY_SCROLL_PADDING = `calc(${String(
  BOTTOM_TABS_HEIGHT_PX + ORDER_ENTRY_BAR_HEIGHT_PX + FOCUS_RING_EXTENT_PX,
)}px + env(safe-area-inset-bottom))`;

/** The two entry points of the mobile order sheet, in the order the bar draws them. */
export const ORDER_ENTRY_CONTRACTS: readonly Outcome[] = ['YES', 'NO'];

/**
 * An entry point's label and the sheet's title for it: 'YES 매수' / 'NO 매수'. No price — the
 * owner's #122 row in ADR-0061 decision 3; what a contract costs is #66's, from the order book
 * (N02 §5).
 */
export function orderEntryLabel(contract: Outcome): string {
  return `${contract === 'YES' ? copy.yes : copy.no} ${copy.buy}`;
}

/**
 * What the mobile order sheet holds under its title, by who pressed 'YES 매수' or 'NO 매수':
 *
 * - `login` for a signed-out visitor: a sign-in prompt that comes back to this market, since an
 *   order is placed signed in (N02 §2; owner decision 2026-10-17, '시트에 로그인 안내').
 * - `preparing` for a member: 거래 준비 중, the one line the desktop's order column says, until the
 *   order panel (#66; ADR-0048).
 * - `pending` while the session is still unknown: a neutral placeholder rather than either line,
 *   so a visitor who presses before the session has answered is never told 거래 준비 중 and then,
 *   a moment later, to sign in instead (ADR-0067 decision 4). The press itself needs hydration,
 *   so this is a short window after it, not the server's render — the sheet is never in the HTML.
 */
export type OrderSheetBody = 'pending' | 'preparing' | 'login';

export function orderSheetBody(viewer: PersonalAreaView): OrderSheetBody {
  if (viewer === 'unknown') return 'pending';
  return viewer === 'member' ? 'preparing' : 'login';
}

/**
 * The mobile order sheet: whether it is open, and the contract its entry point named. The
 * contract outlives the close, so the title does not change under the closing animation and the
 * order panel (#66) will open on the contract that was pressed.
 */
export interface OrderSheetState {
  open: boolean;
  /** `null` until an entry point is pressed for the first time. */
  contract: Outcome | null;
}

export const INITIAL_ORDER_SHEET: OrderSheetState = { open: false, contract: null };

/** A press of 'YES 매수' or 'NO 매수': the sheet opens on that contract, whatever it held before. */
export function openOrderSheet(contract: Outcome): OrderSheetState {
  return { open: true, contract };
}

/** The close button, Escape or a press outside: closed, still remembering the contract. */
export function closeOrderSheet(state: OrderSheetState): OrderSheetState {
  return { ...state, open: false };
}

/**
 * 배경's text, or `null` for a market that has none — then there is no 배경 section at all, since
 * an empty card would only say an admin left a field blank. Blank and whitespace-only count as
 * none: the API sends an unset description as `null`, and a cleared one may arrive as `''`. The
 * text is returned as it was written, for the `pre-wrap` block to keep its lines.
 */
export function backgroundText(description: string | null): string | null {
  return description === null || description.trim() === '' ? null : description;
}

/**
 * The header's NO reading, on its own line under the YES one (ADR-0061 decision 1, item 2; owner
 * decision 2026-10-17, 'NO를 아래 줄로'): the display complement of the same last fill, "NO 37%"
 * for a 63% market, so the two always add up to 100 — never a price to buy NO at (N02 §5). `null`
 * before the first fill, when the header says 체결 없음 once and has no second line.
 */
export function complementReading(lastPrice: number | null): string | null {
  return lastPrice === null ? null : formatNoPrice(lastPrice);
}
