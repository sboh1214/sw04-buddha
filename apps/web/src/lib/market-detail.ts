import {
  type ContractTerms,
  type MarketResult,
  type MarketStatus,
  type Outcome,
  PROPOSED_CONTRACT_TERMS,
  formatCoin,
} from '@buddha/shared';
import { copy } from '@/copy';
import { system } from '@/theme/system';
import { type Market } from './api';
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
 * The two widths the detail is laid out for, by Chakra's breakpoint names — the keys of a
 * responsive prop: `base` below md, `md` from md up.
 */
export type DetailWidth = 'base' | 'md';

/**
 * The sections the two widths draw in different places — 배경, 규칙 and 공개 판정 기록: from md up
 * they come before the chart (N02 §4's list), below md after the 호가·거래 내역 switch (N02 §4's
 * first screen). Each is in the DOM twice, once in each place (`DETAIL_SLOTS`). They are the ones
 * that can be: they hold no state, start no request of their own (배경 and 규칙 read the cached
 * `['market', id]` row) and have no focus stop, so a second copy costs a few nodes and can never
 * disagree with the first.
 */
export type CopiedSection = 'background' | 'rules' | 'judging';

/**
 * The sections both widths draw from one element in one DOM place. The ones that hold state or
 * fetch are here — the chart and its range, the switch and 최근 체결 (`activity`), 요약 with 관심
 * 등록, 내 포지션, 토론 with its query, 관련 시장 with its query and its cards' socket rooms — and are
 * mounted once: the two orders differ only in where the three copied sections stand around them.
 */
export type SharedSection =
  'summary' | 'chart' | 'activity' | 'position' | 'discussion' | 'related';

/**
 * The detail's sections. The order panel is not one of them — it is the right column from md up
 * and a sheet below it.
 *
 * - `summary`: the header — category trail, status, countdown, 관심 등록, the question, YES·NO,
 *   거래량, 참여자 and the status notice. It is the mobile first screen's '요약' as well.
 * - `background`: 배경 (`Market.description`), only when the market has one.
 * - `rules`: 규칙 — every rule item but 배경 (#23: YES·NO 조건, 사건 기한, 1차·대체 출처 and 전환
 *   조건, 장기 지연 기한, 지연·취소·무효 처리), the fixed VOID payout line and 마감. 예정 판정일 has
 *   no data before #22 and so no slot.
 * - `judging`: 공개 판정 기록 (#24), right after the rules it applies, on every public status
 *   (owner decision 2026-10-17).
 * - `chart`: 가격 차트.
 * - `activity`: 호가창 (#179), then 최근 체결 and 내 거래 — the mobile switch's two views.
 * - `position`: 내 포지션, and 내 대기 주문 (#123) under it, for a signed-in reader — or, for a
 *   signed-out visitor, the one sign-in prompt that stands for all the personal areas
 *   (`personalAreaView`).
 * - `discussion`: 토론 (#47, ADR-0075) — this market's posts as the community list's cards without
 *   their market line, newest first, every one of them in the detail a 더 보기 at a time, the count
 *   beside the heading and 글쓰기 always there (ADR-0069 decision 4 #47). Public, yet its posts are
 *   read in the browser only: the server's HTML holds its heading, 글쓰기 and its loading state,
 *   never a post (owner decision 2026-10-20).
 * - `related`: 관련 시장 (#65, ADR-0068), the last of N02 §4's list at both widths — the markets an
 *   admin linked to this one, as the home's cards in 추천 order, or a notice that there are none
 *   (ADR-0061 decision 1, item 19). Public (item 18), so it is in the server's HTML.
 */
export type DetailSection = SharedSection | CopiedSection;

/**
 * A place in the detail's column: a shared section, drawn at every width, or one width's copy of a
 * copied section, drawn at that width only (`copyDisplay`).
 */
export type DetailSlot =
  { section: SharedSection; width: 'all' } | { section: CopiedSection; width: DetailWidth };

/**
 * The detail's column in DOM order. `MarketDetail` renders its sections by iterating this list
 * (a node for every shared section and one per width for every copied one, both records it has
 * to fill), so this is the order on the page and not a description of it — moving a slot here
 * moves the section.
 *
 * Each width draws its own slots and the shared ones; the other width's copies are
 * `display: none` there, which takes them out of the accessibility tree as well as the layout. So
 * the order a width draws (`drawnOrder`) is the order its DOM holds what it draws: the order a
 * screen reader reads and the keyboard walks is the order on the screen at both widths
 * (WCAG 1.3.2). From md up that is N02 §4's list (ADR-0061 decision 1, item 16); below md it is
 * N02 §4's first screen — 요약 and the chart, then the 호가·거래 내역 switch — and then the rest
 * in the list's order.
 */
export const DETAIL_SLOTS: readonly DetailSlot[] = [
  { section: 'summary', width: 'all' },
  { section: 'background', width: 'md' },
  { section: 'rules', width: 'md' },
  { section: 'judging', width: 'md' },
  { section: 'chart', width: 'all' },
  { section: 'activity', width: 'all' },
  { section: 'background', width: 'base' },
  { section: 'rules', width: 'base' },
  { section: 'judging', width: 'base' },
  { section: 'position', width: 'all' },
  { section: 'discussion', width: 'all' },
  // 관련 시장 (#65, ADR-0068): N02 §4's last, after 토론 at both widths, so one shared slot.
  { section: 'related', width: 'all' },
];

/**
 * The sections a width draws, in the order it draws them — which is their DOM order, since a
 * width draws nothing out of it (see `DETAIL_SLOTS`).
 */
export function drawnOrder(width: DetailWidth): DetailSection[] {
  return DETAIL_SLOTS.filter((slot) => slot.width === 'all' || slot.width === width).map(
    (slot) => slot.section,
  );
}

/**
 * A copy's CSS `display` per breakpoint. At its own width `contents`: the wrapper draws no box, so
 * the section inside is the column's flex item exactly as a shared section is, and a 배경 that is
 * not there leaves no empty item — and no extra gap — behind. At the other width `none`, which
 * takes the copy out of the layout and of what a screen reader reads.
 */
export function copyDisplay(width: DetailWidth): Record<DetailWidth, 'contents' | 'none'> {
  return {
    base: width === 'base' ? 'contents' : 'none',
    md: width === 'md' ? 'contents' : 'none',
  };
}

/**
 * One value for each width, as a record: how `MarketDetail` builds 공개 판정 기록's two copies.
 * page.tsx writes 배경's and 규칙's out instead — this module loads the app's Chakra system
 * (`MD_UP_MEDIA_QUERY`), which fails to load in a server component.
 */
export function perWidth<T>(make: (width: DetailWidth) => T): Record<DetailWidth, T> {
  return { md: make('md'), base: make('base') };
}

/**
 * A copy's test id: the section's id with the width after it, `market-rules-md` and
 * `market-rules-base`, and the ids inside it built on that (`market-rules-base-close-at`). Both
 * copies are in the HTML, so a shared id would match twice and a test could read the copy that is
 * not drawn; this way each id names one copy, and a spec picks the one its width draws on purpose
 * (e2e helpers.ts `detailCopyTestId`, which writes the same scheme).
 */
export function copyTestId(testId: string, width: DetailWidth): string {
  return `${testId}-${width}`;
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
 * away with it. `undefined` is the row not loaded yet. Whether a scheduled or a paused market
 * shows one is asked with the orders themselves (#119·#66, ADR-0093 decision 5 '남은 것').
 */
export function showsOrderArea(status: MarketStatus | undefined): boolean {
  return status === 'open';
}

/** One 상태별 안내 (PLAN 11.3): its tone, its sentence, and the settled payout's second line. */
export interface StatusNotice {
  tone: 'info' | 'warning' | 'success';
  message: string;
  detail?: string;
}

/**
 * What a status other than 거래 중 leaves a reader able to do (PLAN 11.3), one notice per public
 * status (ADR-0093 decision 1, item 12), each saying only what is so in that status — nothing
 * about what a later issue brings (the scheduled open #21, a pause's reason #114, the dispute
 * #175). `open`, `draft` and `review` are absent on purpose: an open market's state is its
 * countdown, and a draft or a market in review never reaches the detail route — the API answers
 * NOT_FOUND for both, so the page 404s before the detail renders.
 *
 * The tone is a second, redundant channel: every notice says in words what it is, so nothing
 * here is carried by colour alone (PLAN 11.2, AC 6). `warning` where trading is stopped while the
 * market has not ended (paused, closed), `success` once the payout has landed, `info` for the rest.
 */
const STATUS_NOTICE: Partial<Record<MarketStatus, Omit<StatusNotice, 'detail'>>> = {
  scheduled: { tone: 'info', message: copy.marketScheduledNotice },
  paused: { tone: 'warning', message: copy.marketPausedNotice },
  closed: { tone: 'warning', message: copy.marketClosedNotice },
  provisional: { tone: 'info', message: copy.marketProvisionalNotice },
  // Confirmed, and the worker starts the payout at once (ADR-0093 decision 1, item 1): usually a
  // moment before a `market:status` moves it on to settling.
  resolved: { tone: 'info', message: copy.marketResolvedNotice },
  // The worker's settlement is running (ADR-0046): usually a few seconds before settled.
  settling: { tone: 'info', message: copy.marketSettlingNotice },
  settled: { tone: 'success', message: copy.marketSettledNotice },
  cancelled: { tone: 'info', message: copy.marketCancelledNotice },
};

/**
 * The detail's 상태별 안내 for a market, or `undefined` for none (`STATUS_NOTICE`). A settled one
 * adds the line that says where the Coin went: the payout is already in the balance (the worker's
 * finalize wrote it, PLAN 5.5), and 내 손익 is the 내 포지션 card below, not this notice. 100 Coin
 * per winning contract is a YES or NO result's alone; a 무효 one has no winning side, so its line
 * names only where 내 손익 is (VOID's own payout, 50/50, is #126's to state).
 */
export function statusNotice(market: {
  status: MarketStatus;
  resolvedResult: MarketResult | null;
}): StatusNotice | undefined {
  const notice = STATUS_NOTICE[market.status];
  if (notice === undefined) return undefined;
  if (market.status !== 'settled' || market.resolvedResult === null) return notice;
  return {
    ...notice,
    detail:
      market.resolvedResult === 'VOID' ? copy.marketSettledPayoutVoid : copy.marketSettledPayout,
  };
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
 * A rule text of 규칙 (#23: YES·NO 조건, 전환 조건, 지연·취소·무효 처리) as written, or `null` while
 * it is blank — a draft's, or a market's opened before #23 — which the section shows as '—'.
 */
export function ruleText(text: string): string | null {
  return text.trim() === '' ? null : text;
}

/** One source of a market's rules (#23), `Market.primarySource` and each of `fallbackSources`. */
export type RuleSource = Market['fallbackSources'][number];

/** How 규칙 draws a source: its text, a link to `href` when it has one. */
export interface SourceView {
  text: string;
  href: string | null;
}

/**
 * Whether `url` is an http(s) address — the API's own check on a source (`marketSourceSchema`),
 * restated as a second lock before it becomes an `href`. Not the admin form's `isHttpUrl`: that
 * file is admin code (excluded-features.test.ts), and this one is the public detail's.
 */
function isHttpAddress(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * A source as 규칙 draws it (#23, ADR-0093 decision 3 '#23 출처 주소': the name opens the address):
 * the name, linked to the address when that is an http(s) one; the name alone when the address is
 * blank or not one; the address alone, as text, when the name is blank. `null` for no source, or
 * one with neither — the section shows '—'. A half-filled source is a draft's, or one an admin set
 * on a market opened before #23: the open-items check names it, and the reader still sees it.
 */
export function sourceView(source: RuleSource | null): SourceView | null {
  if (source === null) return null;
  const name = source.name.trim();
  const url = source.url.trim();
  if (name !== '') return { text: name, href: isHttpAddress(url) ? url : null };
  return url === '' ? null : { text: url, href: null };
}

/**
 * 장기 지연 기한 as 규칙 words it: '예정 판정 시각에서 N일 뒤' (#172 item 10), or `null` while it is
 * not set ('—'). The instant itself needs #22's scheduled judgement time.
 */
export function longDelayText(days: number | null): string | null {
  return days === null
    ? null
    : `${copy.rulesLongDelayBefore} ${String(days)}${copy.rulesLongDelayTail}`;
}

/**
 * The fixed 무효 지급 line under 지연·취소·무효 처리 (#23 AC 6, #173 item 9): what one YES and one NO
 * contract each pay on VOID. One rule for every market, so no market enters it (ADR-0093 result 1);
 * the amounts are `PROPOSED_CONTRACT_TERMS`', the terms the market maker prices with, so the rule a
 * reader is shown and the bot's prices cannot disagree. It is a rule, never a refund (N03 §6).
 */
export function voidPayoutText(
  terms: Pick<ContractTerms, 'voidPayoutYesCoin' | 'voidPayoutNoCoin'> = PROPOSED_CONTRACT_TERMS,
): string {
  return (
    `${copy.rulesVoidPayoutYes} ${formatCoin(terms.voidPayoutYesCoin)}, ` +
    `${copy.rulesVoidPayoutNo} ${formatCoin(terms.voidPayoutNoCoin)}${copy.rulesVoidPayoutTail}`
  );
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
