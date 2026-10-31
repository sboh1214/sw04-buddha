'use client';

import {
  Alert,
  Badge,
  Box,
  Button,
  Card,
  DataList,
  Grid,
  HStack,
  SegmentGroup,
  Skeleton,
  Stack,
  Tag,
  Text,
} from '@chakra-ui/react';
import { formatCoin, isPreCloseMarketStatus, parseCoinAmount } from '@buddha/shared';
import NextLink from 'next/link';
import { Fragment, type ReactNode, useState } from 'react';
import { ComingSoonSection } from '@/components/market/coming-soon-section';
import { CountdownBadge } from '@/components/market/countdown-badge';
import { MyPosition } from '@/components/market/my-position';
import { OrderEntryBar } from '@/components/market/order-entry-bar';
import { ProbabilityChart } from '@/components/market/probability-chart';
import { ProbabilityDisplay } from '@/components/market/probability-display';
import { RecentFills } from '@/components/market/recent-fills';
import { SignInPrompt } from '@/components/market/sign-in-prompt';
import { WatchButton } from '@/components/market/watch-button';
import { copy } from '@/copy';
import { useMarketSocket } from '@/hooks/use-market-socket';
import { useCategories, useMarket, useMarketTicks } from '@/hooks/use-markets';
import { type Market } from '@/lib/api';
import { CATEGORY_TRAIL_SEPARATOR, categoryBreadcrumb } from '@/lib/category-label';
import {
  MARKET_RESULT_LABEL,
  MARKET_STATUS_LABEL,
  MARKET_STATUS_PALETTE,
} from '@/lib/market-admin';
import {
  type CopiedSection,
  DEFAULT_DETAIL_VIEW,
  DETAIL_SLOTS,
  DETAIL_VIEW_ITEMS,
  type DetailView,
  type DetailWidth,
  type PersonalAreaView,
  type SharedSection,
  copyDisplay,
  copyTestId,
  detailViewOf,
  perWidth,
  personalAreaView,
  showsOrderArea,
  statusNotice,
  viewDisplay,
} from '@/lib/market-detail';
import { HEADER_HEIGHT_PX } from '@/lib/nav';
import { type RecentMove, recentMove } from '@/lib/ticks';
import { useSession } from '@/lib/use-session';
import { MarketDiscussion } from './market-discussion';
import { MarketTags } from './market-tags';

/**
 * The live half of 시장 상세: everything that a `market:tick` or a `market:status` may change
 * while the page is open (PLAN 11.3, AC 1).
 *
 * It takes an id, not a row. The page seeded `['market', id]` and `['ticks', id, '1D']` into
 * the cache it dehydrated, so the first client render reads the server's own values out of
 * that cache — no second fetch, no skeleton beside hydrated content — and every later value
 * arrives through the same key, whether it comes from the socket or from a refetch. Nothing on
 * this screen holds a copy of the row.
 *
 * `useMarketSocket([marketId])` is the whole of the realtime wiring here: the provider owns
 * the connection and writes the caches through the reducers in `lib/market-live.ts`, so a
 * status transition moves the badge and the notice below without one line of event handling in
 * this file.
 *
 * The frame (#122, ADR-0067) is N02 §4's list in the owner's order (ADR-0061 decision 1, item 16;
 * approved from this PR's screenshots, owner decisions 2026-10-17): 요약 — the question with its
 * category, status, countdown, 관심 등록, YES·NO, 거래량 and 참여자, and at its end the links out:
 * the tags (#17) and the themes (#81) — then 배경, 규칙·출처·마감, 공개
 * 판정 기록, the chart, 호가창 with 최근 체결 and 내 거래, 내 포지션 and 내 대기 주문, 토론 (#47,
 * ADR-0075), and then 관련 시장 (#65, ADR-0068). The order at each width is
 * `lib/market-detail.ts`'s — the sections are rendered by iterating `DETAIL_SLOTS`, where 배경, 규칙
 * and 공개 판정 기록 have one copy for each width's place, so the DOM holds what each width draws in
 * the order it draws it — and this file builds each section and lays the two columns out.
 *
 * - From md up: two columns. The left one holds every section; the right one is the order panel,
 *   sticky under the header so it stays beside the chart and the 호가 while the page scrolls (N02
 *   §4 "차트·호가와 주문 패널을 병렬 배치"). There is no way to trade until the CLOB order panel lands
 *   (#119, #66; D13), so an open market's column holds the 거래 준비 중 notice (owner decision #125
 *   (a)). Any other status leaves the column empty: the status notice on the left already says
 *   what the market is (ADR-0048), and the left column keeps its width when a market closes under
 *   a reader.
 * - Below md: one column whose first screen is 요약 and the chart, then a switch between 호가 and
 *   거래 내역 (최근 체결 and 내 거래), then the rest (N02 §4). The order panel is a bottom sheet
 *   opened from a YES 매수 · NO 매수 bar on an open market (`OrderEntryBar`); a signed-out visitor
 *   finds a sign-in prompt in it instead of 거래 준비 중 (N02 §2).
 * - Sections whose content another issue brings — 호가창, 내 거래, 내 대기 주문, 공개 판정 기록 —
 *   are their title and 준비 중 (`ComingSoonSection`, the owner's #122 row). The personal areas —
 *   내 포지션, 내 거래 and 내 대기 주문 — are drawn for a signed-in reader only; a signed-out visitor
 *   gets one sign-in prompt where 내 포지션 · 내 대기 주문 stand, and neither is ever in the server's
 *   HTML (`personalAreaView`).
 */

/**
 * The two tracks from md up: every section, and the order panel. The panel's track is fixed so
 * the order panel (#66) has a known width to be built in, and the sections take the rest; at md
 * itself (768px, 720px inside the page's padding) that still leaves the chart its own column.
 * `minmax(0, …)` so a long question or a wide table cannot blow the sections out past their track
 * and take the order panel off screen with it.
 */
const DETAIL_COLUMNS = {
  base: 'minmax(0, 1fr)',
  md: 'minmax(0, 1fr) 320px',
  lg: 'minmax(0, 1fr) 360px',
};

export interface MarketDetailProps {
  /** The row's canonical lower-cased uuid — the key the page seeded and the socket writes. */
  marketId: string;
  /**
   * The instant the countdown measures its first render against: the API's own window end,
   * passed down from the page. Never read from the clock here — a `Date.now()` in a render body
   * is a different string on the server and in the browser's first render.
   */
  now?: number;
  /**
   * The question, 배경 and 규칙, rendered by the SERVER component and passed through. This file
   * only places them; it never renders them, so no branch of the ladder below — and no hydration
   * failure — can take the question or the rules out of the HTML that AC 2 reads. Each follows
   * the live row on its own (`LiveQuestionHeading`, `LiveBackgroundSection`, `LiveRulesSection`).
   * 배경 and 규칙 come as one copy per width, each built with that copy's test ids
   * (`copyTestId`): the two widths draw them in different places (`DETAIL_SLOTS`).
   */
  question: ReactNode;
  background: Record<DetailWidth, ReactNode>;
  rules: Record<DetailWidth, ReactNode>;
  /**
   * 관련 시장 (#65), rendered by the server component with the first page it read and placed here
   * as the last section, like the three above: the cards are public and in every visitor's HTML.
   * One node, not one per width: both widths draw it last (`DETAIL_SLOTS`), and it holds a query
   * and its cards' socket rooms, so it is mounted once.
   */
  related: ReactNode;
  /**
   * The themes this market is in (#81, ADR-0088): a line of links at the end of 요약, rendered by
   * the server component with the list it read. It renders nothing when there is none.
   */
  themes: ReactNode;
}

export function MarketDetail({
  marketId,
  now,
  question,
  background,
  rules,
  related,
  themes,
}: MarketDetailProps) {
  useMarketSocket([marketId]);
  const market = useMarket(marketId);
  // The same seeded series the chart draws (one key, one query, no second request). It is read
  // here for the delta badge only — see `recentDelta`.
  const series = useMarketTicks(marketId);
  const session = useSession();
  // `unknown` on the server and through hydration, so nothing that depends on who is reading — the
  // personal areas, their sign-in prompt, the sheet's body — differs between visitors' HTML.
  const viewer = personalAreaView({
    isPending: session.isPending,
    signedIn: session.data != null,
  });
  const data = market.data;
  // Read off the live row, so a `market:status` that closes the market takes the order column,
  // the 매수 bar and an open sheet away with it (ADR-0048).
  const orderArea = showsOrderArea(data?.status);

  // Every shared section by its key, and every copied one by its key and width: `DETAIL_SLOTS`,
  // iterated below, is the order they are rendered in. The records have to name a node for each
  // key, and the list alone decides where it goes.
  const sections: Record<SharedSection, ReactNode> = {
    summary: (
      <Stack gap="4" data-testid="market-summary">
        {/* A failed REFETCH keeps the row that is already drawn — the numbers on screen are
            simply the last ones that arrived, which is what the notice says. */}
        {data !== undefined && market.isRefetchError && (
          <Alert.Root status="warning" role="status" data-testid="market-detail-refresh-failed">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{copy.marketRefreshFailed}</Alert.Description>
            </Alert.Content>
          </Alert.Root>
        )}
        <Stack gap="3">
          {data !== undefined && <MarketHeaderRow market={data} now={now} />}
          {question}
        </Stack>
        {data === undefined ? (
          market.isLoadingError ? (
            <Stack gap="2" align="flex-start">
              <Alert.Root status="error" role="alert">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Description>{copy.errUnknown}</Alert.Description>
                </Alert.Content>
              </Alert.Root>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void market.refetch();
                }}
              >
                {copy.retry}
              </Button>
            </Stack>
          ) : (
            // A sibling skeleton, never a wrapper: `loading` defaults to true, so a Skeleton
            // AROUND the header would hide it for good.
            <Skeleton height="48" />
          )
        ) : (
          <>
            <MarketSummary market={data} move={recentMove(series.data?.points)} />
            <StatusNotice market={data} />
            {/* The '#이름' chips (#17), each its tag's search: the first of the two lines of links
                out at the end of 요약, the themes' after it (market-tags.tsx). */}
            <MarketTags tags={data.tags} />
          </>
        )}
        {themes}
      </Stack>
    ),
    chart: data !== undefined && (
      <Box minW="0">
        {/* `currentBp` and `currentTradeCount` come from ONE read of the row, so the chart can
            never draw one fill's price under another's claim. */}
        <ProbabilityChart
          marketId={marketId}
          label={data.title}
          currentBp={data.lastPrice === null ? null : data.lastPrice * 100}
          currentTradeCount={data.tradeCount}
        />
      </Box>
    ),
    activity: <MarketActivity marketId={marketId} member={viewer === 'member'} />,
    // 내 포지션 and 내 대기 주문: personal areas, so a signed-in reader's only (ADR-0061 decision 1,
    // item 18). A signed-out visitor gets ONE sign-in prompt in their place, which stands for 내
    // 거래 as well (owner decision 2026-10-17, '로그인 안내 하나'). Neither is in the server's HTML.
    position: (
      <PersonalArea viewer={viewer}>
        {/* Both readings follow the LIVE row rather than the positions list's own copy of it:
            `status` says which of the two position lists this account's rows moved to — a
            settled market's holder is in 정산 이력, and asking the open list would tell them
            they never participated — and `lastPrice` is what 현재가 and 평가손익 are marked
            to, so the card cannot disagree with the price above it. `undefined` while the row
            is unknown, which is each prop's documented default; the page seeds the cache
            before the first client render, so that is a fallback and not the path. */}
        <MyPosition marketId={marketId} status={data?.status} lastPrice={data?.lastPrice} />
        <ComingSoonSection title={copy.marketMyOpenOrders} testId="market-my-open-orders" />
      </PersonalArea>
    ),
    // 토론 (#47, ADR-0075): this market's posts as the community list's cards (without their
    // market line), newest first, every one of them a 더 보기 at a time, the count beside the
    // heading and 글쓰기 always there. Public, but read in the browser only — no post in the
    // server's HTML (market-discussion.tsx). One slot at both widths: it holds a query.
    discussion: <MarketDiscussion marketId={marketId} />,
    // 관련 시장 (#65, ADR-0068), after 토론: the last of N02 §4's list, at both widths. Public, so
    // the page renders it with the first page it read (related-markets.tsx).
    related,
  };
  // The sections each width draws in its own place, one copy per width. Only 공개 판정 기록 is
  // built here; 배경 and 규칙 are the server's, already one per width.
  const copies: Record<CopiedSection, Record<DetailWidth, ReactNode>> = {
    background,
    rules,
    // 공개 판정 기록 (#24) right after the rules it applies (N03 §8 lists the rules, the current
    // state, the result and the 출처 together), on every public status (owner decision
    // 2026-10-17).
    judging: perWidth((width) => (
      <ComingSoonSection
        title={copy.marketJudgingRecord}
        testId={copyTestId('market-judging-record', width)}
      />
    )),
  };

  return (
    <Box data-testid="market-detail">
      <Grid templateColumns={DETAIL_COLUMNS} gap={{ base: '6', md: '8' }}>
        {/* One flex column, in DOM order (`DETAIL_SLOTS`): each width draws its own copies and
            the shared sections, and never anything out of the order the DOM holds it in. A copy's
            wrapper is `display: contents` at its width, so the section in it is the flex item,
            and `none` at the other. Fragments keep each shared section's own element the item. */}
        <Stack gap="6" minW="0" data-testid="market-detail-sections">
          {DETAIL_SLOTS.map((slot) =>
            slot.width === 'all' ? (
              <Fragment key={slot.section}>{sections[slot.section]}</Fragment>
            ) : (
              <Box key={`${slot.section}-${slot.width}`} display={copyDisplay(slot.width)}>
                {copies[slot.section][slot.width]}
              </Box>
            ),
          )}
        </Stack>

        {orderArea ? <OrderArea /> : null}
      </Grid>
      {/* Last in the detail, so its sticky box rests under the last section and leaves with the
          detail (order-entry-bar.tsx). Below md only. */}
      {orderArea ? <OrderEntryBar viewer={viewer} /> : null}
    </Box>
  );
}

/**
 * 내 포지션 · 내 대기 주문's place in the column: the member's two areas (`children`), or for a
 * signed-out visitor the one sign-in prompt that stands for every personal area — this pair and 내
 * 거래 in 거래 내역 alike — and says plainly what signing in shows (owner decision 2026-10-17). It
 * comes back to this market. Nothing while the session is unknown, i.e. in the server's HTML and
 * through hydration, so the page is the same for every visitor; the prompt is a card like the
 * sections around it, with no heading of its own, since it names no one section.
 */
function PersonalArea({ viewer, children }: { viewer: PersonalAreaView; children: ReactNode }) {
  if (viewer === 'member') return <>{children}</>;
  if (viewer === 'unknown') return null;
  return (
    <Card.Root data-testid="market-personal-signed-out">
      <Card.Body>
        <SignInPrompt
          message={copy.marketPersonalSignedOut}
          data-testid="market-personal-signed-out-prompt"
        />
      </Card.Body>
    </Card.Root>
  );
}

/**
 * 호가 and 거래 내역 (N02 §4): from md up the 호가창 slot (#179) and, under it, 최근 체결 with 내 거래
 * (#121, signed-in only — a visitor's prompt is the one at 내 포지션's place); below md a switch
 * between the two, opening on 호가 (ADR-0061 decision 1, item 16: 거래 내역 is the market's recent
 * fills and the reader's own trades).
 *
 * Both panels are always rendered and the switch only decides which is displayed below md
 * (`viewDisplay`), so one DOM serves both widths: 최근 체결 is mounted once and never refetched by a
 * switch, the server's HTML is the same at every width, and no test id is drawn twice. The switch
 * is the chart's control (`SegmentGroup`, a radio group under a name) rather than ARIA tabs:
 * from md up the same two panels stand side by side under their own headings with no switch, and
 * a `tabpanel` there would point at tabs nobody can see.
 */
function MarketActivity({ marketId, member }: { marketId: string; member: boolean }) {
  const [view, setView] = useState<DetailView>(DEFAULT_DETAIL_VIEW);
  return (
    <Stack gap={{ base: '4', md: '6' }} minW="0" data-testid="market-activity">
      <SegmentGroup.Root
        hideFrom="md"
        size="md"
        w="full"
        value={view}
        onValueChange={(details) => {
          const next = detailViewOf(details.value);
          if (next !== undefined) setView(next);
        }}
        aria-label={copy.marketDetailViewLabel}
        data-testid="market-activity-switch"
      >
        <SegmentGroup.Indicator />
        <SegmentGroup.Items items={DETAIL_VIEW_ITEMS} flex="1" justifyContent="center" />
      </SegmentGroup.Root>
      <Box display={viewDisplay(view, 'book')} data-testid="market-activity-book">
        <ComingSoonSection title={copy.marketOrderBook} testId="market-order-book" />
      </Box>
      <Stack
        gap="6"
        display={viewDisplay(view, 'history', 'flex')}
        data-testid="market-activity-history"
      >
        <RecentFills marketId={marketId} />
        {member && <ComingSoonSection title={copy.marketMyTrades} testId="market-my-trades" />}
      </Stack>
    </Stack>
  );
}

/**
 * 주문 영역 of an open market from md up, while there is no order panel: one line, 거래 준비 중,
 * with no reason or date beside it (owner decisions #125, ADR-0048). The right column, sticky
 * under the two-row header. Below md the same place is the bottom sheet (`OrderEntryBar`), so
 * this column is not drawn there.
 */
function OrderArea() {
  return (
    <Box
      hideBelow="md"
      position="sticky"
      top={`calc(${String(HEADER_HEIGHT_PX)}px + 16px)`}
      alignSelf="start"
      data-testid="order-area"
    >
      <Card.Root>
        <Card.Body>
          <Alert.Root status="info" role="status">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description data-testid="order-area-notice">
                {copy.tradePreparing}
              </Alert.Description>
            </Alert.Content>
          </Alert.Root>
        </Card.Body>
      </Card.Root>
    </Box>
  );
}

/**
 * 요약's first row — 카테고리 · 상태 · 마감 카운트다운 · 관심 등록 — over the question.
 *
 * The status badge is rendered for every status, including 거래 중, because it is the one
 * reading that says what the server currently thinks this market is — and it is what a
 * `market:status` visibly moves. The countdown is rendered only while the market has not closed
 * (개장 예정, 거래 중, 거래 일시 중단: `isPreCloseMarketStatus`, #174): a settled market has
 * nothing to count down to, and its badge already says so. The two DO disagree for an open
 * market whose close time has passed (거래 중 + 마감됨), and that is the truth: the close job has
 * not run yet, so the row is still `open` (A-M3-31).
 *
 * The category tag writes the whole trail, 경제 › 주택, rather than the leaf alone (ADR-0041's
 * two-level tree): the row only carries the leaf's `{slug, nameKo}`, so the parent's name is
 * read off the `['categories']` query — the one the header's `Nav` already holds, so this is a
 * second observer of a query in flight, never a second request. Until it resolves (the server
 * render, the first client paint) `categoryBreadcrumb` answers the leaf name the row carries,
 * i.e. exactly what this tag said before the tree existed, so the HTML and the hydrating render
 * agree and nothing waits on the query. The tag is also the way back to that leaf's list, as
 * the card's category header is: `prefetch={false}` because `/` is force-dynamic and a
 * prefetch there is a whole filtered list rendered for a link that may never be clicked — the
 * rule every link into `/` in this app follows (the header's search form, the category rows).
 * A UrlObject rather than a template literal, so `href` takes it without a `Route` cast and
 * Next encodes the slug.
 */
function MarketHeaderRow({ market, now }: { market: Market; now?: number }) {
  const categories = useCategories();
  const trail = categoryBreadcrumb(
    categories.data,
    market.category.slug,
    market.category.nameKo,
  ).join(CATEGORY_TRAIL_SEPARATOR);
  return (
    <HStack gap="2" flexWrap="wrap">
      <Tag.Root size="sm" variant="surface" asChild>
        <NextLink
          href={{ pathname: '/', query: { category: market.category.slug } }}
          prefetch={false}
          data-testid="market-detail-category"
        >
          <Tag.Label>{trail}</Tag.Label>
        </NextLink>
      </Tag.Root>
      <Badge
        colorPalette={MARKET_STATUS_PALETTE[market.status]}
        variant="subtle"
        data-testid="market-status-badge"
      >
        {MARKET_STATUS_LABEL[market.status]}
      </Badge>
      {/* Until the market has closed — 개장 예정, 거래 중 and 거래 일시 중단, which closes on schedule
          (ADR-0093 decision 1, item 3) — the time left to the close; after it, the status says it. */}
      {isPreCloseMarketStatus(market.status) && <CountdownBadge market={market} now={now} />}
      {/* 관심 등록 (#89): the end of the first row, above the question, on every public status
          (ADR-0061 decision 3) — where ADR-0064 put it and the owner kept it from this PR's
          screenshots (owner decision 2026-10-17). Client-only state behind a placeholder, so this
          row's HTML is the same for every visitor (watch-button.tsx). */}
      <Box ms="auto">
        <WatchButton marketId={market.id} />
      </Box>
    </HStack>
  );
}

/**
 * 요약 under the question: YES and, on the line under it, its NO complement (ADR-0061 decision 1,
 * item 2; owner decision 2026-10-17), 거래량 and 참여자. With the row above and the question it is
 * the mobile first screen's '요약' (N02 §4).
 */
function MarketSummary({
  market,
  move,
}: {
  market: Market;
  /** The last move and its monotone identity, read off ONE point — see `recentMove`. */
  move: RecentMove | null;
}) {
  return (
    <Stack gap="3">
      <ProbabilityDisplay
        lastPrice={market.lastPrice}
        deltaPoints={move?.deltaPoints ?? null}
        moveId={move?.moveId}
      />

      <HStack gap="4" flexWrap="wrap" fontSize="sm" color="fg.muted">
        <Text whiteSpace="nowrap" data-testid="market-detail-volume">
          {copy.marketVolume} {formatCoin(parseCoinAmount(market.volumeCoin))}
        </Text>
        {/* Grouped by `formatCoin` everywhere else; a plain count is written out as it is, and
            deliberately not through `toLocaleString` — the server's ICU data and the
            browser's would then have to agree on this string. */}
        <Text data-testid="market-detail-traders">
          {copy.marketTraders} {String(market.traderCount)}
        </Text>
      </HStack>
    </Stack>
  );
}

/**
 * 상태별 안내 (PLAN 11.3), plus the one read-only fact a decided market carries: the 결과 —
 * YES·NO·무효 (`MARKET_RESULT_LABEL`), and no row while there is none (before a judgement, and on a
 * cancelled market). A settled market adds the line that says the payout has landed
 * (`statusNotice`). The dispute deadline of a provisional result is #175's, and the 판정 record
 * itself (note, evidence, instant) is #24's.
 *
 * `role="status"` rather than `role="alert"`: a market closing while someone reads it is worth
 * announcing, but it is not an emergency that should interrupt them mid-sentence.
 *
 * The 결과 row is deliberately NOT gated on the status: it is the market's answer and PLAN 11.3
 * asks for it on a settled screen as much as on a resolved one.
 */
function StatusNotice({ market }: { market: Market }) {
  const notice = statusNotice(market);
  if (notice === undefined) return null;
  return (
    <Alert.Root status={notice.tone} role="status" data-testid="market-status-notice">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Description>{notice.message}</Alert.Description>
        {notice.detail !== undefined && (
          <Alert.Description data-testid="market-status-notice-detail">
            {notice.detail}
          </Alert.Description>
        )}
        {market.resolvedResult !== null && (
          <DataList.Root orientation="horizontal" size="sm">
            <DataList.Item>
              <DataList.ItemLabel>{copy.marketResolvedResult}</DataList.ItemLabel>
              <DataList.ItemValue data-testid="market-detail-result">
                {MARKET_RESULT_LABEL[market.resolvedResult]}
              </DataList.ItemValue>
            </DataList.Item>
          </DataList.Root>
        )}
      </Alert.Content>
    </Alert.Root>
  );
}
