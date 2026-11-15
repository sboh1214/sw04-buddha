import {
  type ContractTerms,
  type MarketResult,
  type MarketStatus,
  type MarketStatusRejectReason,
  type Outcome,
  CONTRACT_TERMS,
  formatCoin,
} from '@buddha/shared';
import { copy } from '@/copy';
import { system } from '@/theme/system';
import { type Market, type MarketJudgementDelay, isApiError } from './api';
import { formatNoPrice, formatPricePerContract } from './market-admin';
import { readsDisputeUnderReview, readsJudgementDelayed } from './market-status';
import { BOTTOM_TABS_HEIGHT_PX, HEADER_HEIGHT_PX, ORDER_ENTRY_BAR_HEIGHT_PX } from './nav';

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
 * that can be: they start no request of their own (배경 and 규칙 read the cached `['market', id]`
 * row) and hold no state that matters, so a second copy costs a few nodes and its content can never
 * disagree with the first. The one state either holds is the 규칙 copy's 규칙 버전 card (#80): each
 * earlier version's 전문 is a native disclosure, open or shut per copy — harmless, since only one
 * copy is shown at a width and both read the same row.
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
 *   조건, 장기 지연 기한, 지연·취소·무효 처리), the fixed VOID payout line, then the market's times
 *   (#22: 예정 개장 시각 before the open, 거래 마감·발표 예정·예정 판정 시각) and its 판정 기준 시간대.
 *   The times are rules too (ADR-0093 decision 2 #172 item 7), so they need no slot of their own.
 *   Under them, once the market has opened, the 규칙 버전 card (#80, ADR-0101): the current version
 *   and every earlier one, its reason, its changes and its 전문.
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
 * The notice over a detail whose refresh failed while a row is drawn: the market is not public any
 * more when the API answers NOT_FOUND — sent back to a draft from 개장 예정 (#78, ADR-0099), whose
 * `market:status` the screen does not apply (`applyStatus`) and which its refetch then meets — and
 * otherwise the row is simply the last one read.
 */
export function marketRefreshNotice(error: unknown): string {
  return isApiError(error, 'NOT_FOUND') ? copy.marketNoLongerPublic : copy.marketRefreshFailed;
}

/**
 * Whether the order area exists at all — the desktop column, the mobile YES·NO 매수 bar and its
 * sheet: on an open market only (ADR-0048 decision 5 and result 6). Any other status explains
 * itself with the status notice, and a `market:status` that closes the market takes the three
 * away with it. `undefined` is the row not loaded yet. A scheduled, paused or ended market shows
 * none (ADR-0135 D1); an open one past its close or under a ledger hold keeps it with its input off
 * (`orderInputClosedReason`, #66).
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
 * about what a later issue brings (a pause's reason and times #24 — #114 keeps them admin-only) —
 * and no notice of a correction (#176, ADR-0105: the new result and deadline read as any; its
 * previous versions and reason are #24's). 개장 예정 promises no
 * open even since the scheduled open opens it (#21, ADR-0100): the time can move, and a close
 * passed first keeps it shut. `open`, `draft` and `review` are absent on purpose: an open market's
 * state is its countdown, and a draft or a market in review never reaches the detail route — the
 * API answers NOT_FOUND for both, so the page 404s before the detail renders.
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
 *
 * A closed market whose scheduled judgement has passed (`judgementDelayed`, #22, ADR-0098) says
 * so, as its badge reads '판정 지연' (`marketStatusLabel`): still no trading, and no result yet —
 * never that a late result means NO. An operator's 판정 지연 기록 (#142, ADR-0106) adds its reason
 * and next review time under it as rows (`shownJudgementDelay`, drawn by the detail's
 * `StatusNotice`), a 판정 지연 잠정 결과 too; the sentence stays the same with or without one.
 *
 * A 잠정 결과 keeps its own sentence and adds why it is not confirmed yet while a 판정 이의 holds it
 * (#175, ADR-0104; #173 item 12): under review before its 이의 기한 ('이의 검토 중'), and past it
 * still not confirmed ('판정 지연', owner answer 2026-11-03) — never what the review will decide,
 * nor any payout. Past it with no dispute holding it, a 판정 지연 is a correction waiting for its
 * approval (#176, ADR-0105, decision 3 '#176 정정 대기': `isJudgementDelayed`'s `correctionPending`,
 * which the public row carries as the flags alone): the line says the judgement is being reviewed
 * again, never that the result will change — the correction may be rejected. The deadline row and
 * the submission link are the detail's (`StatusNotice`).
 */
export function statusNotice(market: {
  status: MarketStatus;
  judgementDelayed: boolean;
  disputeUnderReview: boolean;
  resolvedResult: MarketResult | null;
}): StatusNotice | undefined {
  if (market.status === 'closed' && readsJudgementDelayed(market)) {
    return { tone: 'warning', message: copy.marketJudgementDelayedNotice };
  }
  const notice = STATUS_NOTICE[market.status];
  if (notice === undefined) return undefined;
  if (market.status === 'provisional') {
    if (readsJudgementDelayed(market)) {
      return {
        ...notice,
        tone: 'warning',
        detail: readsDisputeUnderReview(market)
          ? copy.marketProvisionalDelayed
          : copy.marketProvisionalDelayedCorrection,
      };
    }
    if (readsDisputeUnderReview(market)) {
      return { ...notice, detail: copy.marketProvisionalUnderReview };
    }
    return notice;
  }
  if (market.status !== 'settled' || market.resolvedResult === null) return notice;
  return {
    ...notice,
    detail:
      market.resolvedResult === 'VOID' ? copy.marketSettledPayoutVoid : copy.marketSettledPayout,
  };
}

/**
 * The 판정 지연 기록 the detail's 상태별 안내 shows (#142, ADR-0106; ADR-0093 decision 3 '#142 지연
 * 사유', #173 items 11·13): the market's current record — its one public sentence and its next
 * review time, nobody's name and no record time — while the market reads '판정 지연'
 * (`readsJudgementDelayed`), CLOSED or PROVISIONAL alike; null otherwise. The API sends one only
 * then; gating on the flag too keeps a row the socket moved to another status (`applyStatus`
 * resets both) from pairing a CLOSED market's record with its 잠정 결과.
 */
export function shownJudgementDelay(
  market: Pick<Market, 'status' | 'judgementDelayed' | 'disputeUnderReview' | 'judgementDelay'>,
): MarketJudgementDelay | null {
  return readsJudgementDelayed(market) ? market.judgementDelay : null;
}

/**
 * The next review time a detail waits for to mark '갱신 대기' by itself (owner answer 2026-11-03
 * (2)): the shown record's while the API read it ahead (`nextReviewPassed` false), else null —
 * nothing left to wait for. Passing it creates nothing (#173 item 11): the reason stays, the time
 * reads as passed, and no result comes of it. `useInstantReached` waits for it.
 */
export function nextReviewWaitAt(delay: MarketJudgementDelay | null): string | null {
  return delay === null || delay.nextReviewPassed ? null : delay.nextReviewAt;
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

/**
 * The page's own top padding from md up (`app/markets/[slug]/page.tsx`, `py={{ md: '10' }}`):
 * where the order column starts below the header before the page scrolls.
 */
export const DETAIL_TOP_PADDING_MD_PX = 40;

/** The space the order column keeps above the bottom of the window. */
const ORDER_COLUMN_BOTTOM_GAP_PX = 16;

/**
 * The md-and-up order column's sticky top and its height (#66, ADR-0140 결정 2-24). It sticks
 * where it already stands unscrolled — the header and the page's top padding — so it never moves
 * when the page starts to scroll, and it is no taller than the window under that, less a 16px gap:
 * the card's bottom edge and 확인's sticky buttons stay on the first screen. The column stuck 24px
 * higher (header + 16px) with a height counted from there, so unscrolled it reached 8px past the
 * window's bottom.
 */
export const ORDER_COLUMN_TOP = `${String(HEADER_HEIGHT_PX + DETAIL_TOP_PADDING_MD_PX)}px`;
export const ORDER_COLUMN_MAX_H = `calc(100dvh - ${String(
  HEADER_HEIGHT_PX + DETAIL_TOP_PADDING_MD_PX + ORDER_COLUMN_BOTTOM_GAP_PX,
)}px)`;

/** The two entry points of the mobile order sheet, in the order the bar draws them. */
export const ORDER_ENTRY_CONTRACTS: readonly Outcome[] = ['YES', 'NO'];

/**
 * An entry point's words: 'YES 매수' / 'NO 매수' (ADR-0067), the sheet's title for it too. Its price
 * (D2, #66) is drawn beside the words in a slot of its own (`orderEntryPrice`), so the server's
 * HTML and the first render say the words alone and the price arrives without moving them.
 */
export function orderEntryLabel(contract: Outcome): string {
  return `${contract === 'YES' ? copy.yes : copy.no} ${copy.buy}`;
}

/**
 * An entry point's price (ADR-0135 D2, #66), and the order panel's contract buttons': the
 * contract's real best price from the public book as '63.00 Coin', or '호가 없음' when that side is
 * empty (N02 §5) — never 100 − a bid. In the gap (결정 2-16: the market trades but the book or the
 * quote names a reason, or the close has passed) the reason's short name instead — '마감', '일시
 * 중단', '개장 전' — as the gap's line says, not '호가 없음' (ADR-0140 결정 2-23). Otherwise undefined
 * while the book is not known, which leaves the slot blank.
 */
export function orderEntryPrice(
  bestCoin: number | null | undefined,
  closed: MarketStatusRejectReason | null = null,
): string | undefined {
  if (closed !== null) return inputClosedShort(closed);
  if (bestCoin === undefined) return undefined;
  return bestCoin === null ? copy.marketBookEmpty : formatPricePerContract(bestCoin * 100);
}

/**
 * What the mobile order sheet holds under its title: the order panel (#66) — a visitor's too,
 * who may type and quote and is asked to sign in at 주문 확인 (ADR-0135 D3) — or, while the
 * session is still unknown, a neutral placeholder, so nobody is shown one panel and then another.
 * The press itself needs hydration, so this is a short window after it, not the server's render —
 * the sheet is never in the HTML.
 */
export type OrderSheetBody = 'pending' | 'panel';

export function orderSheetBody(viewer: PersonalAreaView): OrderSheetBody {
  return viewer === 'unknown' ? 'pending' : 'panel';
}

/**
 * Why an open market's order panel takes no input now, or null: the window ADR-0135 결과 4 names
 * between `close_at` and the worker's close ('마감'), and a ledger hold ('일시 중단'), which the
 * book's reason says (ADR-0138) and the close's own instant says first (`closeReached`, a timer on
 * the server's clock: the book is read again a second later). The order area itself is the
 * status's (`showsOrderArea`, D1); the server refuses those orders with the same reason.
 */
export function orderInputClosedReason(
  status: MarketStatus | undefined,
  book: { marketRejectReason: MarketStatusRejectReason | null } | undefined,
  closeReached: boolean,
): MarketStatusRejectReason | null {
  if (!showsOrderArea(status)) return null;
  if (book?.marketRejectReason != null) return book.marketRejectReason;
  return closeReached ? 'closed' : null;
}

/**
 * The mobile order sheet: whether it is open, and the contract its entry point named. The
 * contract outlives the close, so the title does not change under the closing animation; the order
 * panel (#66) opens on the contract that was pressed.
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
 * not set ('—'). With a scheduled judgement the row adds the instant itself after
 * LONG_DELAY_SEPARATOR (`longDelayDeadline`, #22, ADR-0098), so the reader adds no days.
 */
export function longDelayText(days: number | null): string | null {
  return days === null
    ? null
    : `${copy.rulesLongDelayBefore} ${String(days)}${copy.rulesLongDelayTail}`;
}

/**
 * Between 장기 지연 기한's words and its instant: '예정 판정 시각에서 14일 뒤 · 2026. 12. 15. 오전
 * 10:00' — the instant being `longDelayDeadline(scheduledJudgementAt, longDelayDays)`, the one
 * the admin 판정 panel's long-delay warning (#142) and #145's list act on, so the shown one cannot
 * differ.
 */
export const LONG_DELAY_SEPARATOR = ' · ';

/**
 * Whether 규칙 has the 예정 개장 시각 row (#22, ADR-0098): before the open only — a draft in the
 * admin preview, a market in review, a SCHEDULED one in public. From the open on, the market's own
 * open time is history, not a rule a reader trades by, and the actual one is `openAt`.
 */
export function showsScheduledOpen(status: MarketStatus): boolean {
  return status === 'draft' || status === 'review' || status === 'scheduled';
}

/**
 * The fixed 무효 지급 line under 지연·취소·무효 처리 (#23 AC 6, #173 item 9): what one YES and one NO
 * contract each pay on VOID. One rule for every market, so no market enters it (ADR-0093 result 1);
 * the amounts are the approved contract values' (`CONTRACT_TERMS`, ADR-0107 결정 1 #177 1항), the
 * terms the market maker prices with, so the rule a reader is shown and the bot's prices cannot
 * disagree. It is a rule, never a refund (N03 §6).
 */
export function voidPayoutText(
  terms: Pick<ContractTerms, 'voidPayoutYesCoin' | 'voidPayoutNoCoin'> = CONTRACT_TERMS,
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

/**
 * The detail badge's move (ADR-0135 결정 1의 5, ADR-0139): 시장가격 now minus 시장가격 24 hours
 * before the row was read (`lastPrice24hAgo`), in whole percentage points, on a market 거래 중
 * (`open`) only — not a paused one, whose screen name is not 거래 중. `null`, and no badge, with
 * no price, with no fill by then (never the open's 50%) or with no move.
 */
export function delta24h(
  market: Pick<Market, 'status' | 'lastPrice' | 'lastPrice24hAgo'>,
): number | null {
  if (market.status !== 'open') return null;
  if (market.lastPrice === null || market.lastPrice24hAgo === null) return null;
  const delta = market.lastPrice - market.lastPrice24hAgo;
  return delta === 0 ? null : delta;
}

/**
 * The short name of the gap's reason (결정 2-16), where a price would stand — the contract
 * buttons and the mobile entry buttons: '개장 전'·'일시 중단'·'마감', the 거절 reasons' own names,
 * rather than '호가 없음', which would say the book is merely empty (ADR-0140 결정 2-23).
 */
export function inputClosedShort(reason: MarketStatusRejectReason): string {
  switch (reason) {
    case 'not_open_yet':
      return copy.orderClosedShortNotOpenYet;
    case 'paused':
      return copy.orderClosedShortPaused;
    case 'closed':
      return copy.orderClosedShortClosed;
  }
}
