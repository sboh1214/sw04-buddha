'use client';

import {
  Badge,
  Box,
  type BoxProps,
  Flex,
  Grid,
  HStack,
  Heading,
  LinkBox,
  LinkOverlay,
  Stack,
  Text,
} from '@chakra-ui/react';
import type { Route } from 'next';
import NextLink from 'next/link';
import { useState } from 'react';
import { useFormatDateTime } from '@/components/time-zone/time-zone-provider';
import { copy } from '@/copy';
import { useCategories } from '@/hooks/use-categories';
import { type MarketSummary } from '@/lib/api';
import { cardIconSlug } from '@/lib/category-tree';
import { MARKET_STATUS_PALETTE } from '@/lib/market-admin';
import {
  type OutcomeRow,
  closeLineKind,
  lastFillLine,
  opensAtLine,
  outcomeRows,
  participantsText,
} from '@/lib/market-card';
import { marketStatusLabel } from '@/lib/market-status';
import { CategoryIcon } from './category-icon';
import { CountdownBadge } from './countdown-badge';

/**
 * One market in the home grid (PLAN 11.4 MarketCard, PLAN 11.1's Polymarket note), drawn as
 * Kalshi's tile (ADR-0041, measured off kalshi.com): a header — the category's icon and name
 * over the question and its countdown — then one row per outcome, YES and NO, each a label
 * over a hairline bar and its percentage as plain text, and a footer with the 참여자 count. The
 * whole card is a link to the detail. A market with no fill yet has no price (N02 §5): the two
 * rows stay, with no bar and '—' in each reading, and 체결 없음 once beside them (owner decision
 * #125, ADR-0048). No initial setting is drawn as a price, and the tile keeps its shape at the
 * first fill.
 *
 * What the card leaves out is decided too (ADR-0061 decision 1, ADR-0062): no payout multiple
 * beside a row (O-21 in ADR-0047), no 거래량 and no price trend line — the volume is the detail
 * header's and the admin's, and the trend is the detail chart's. The NO reading is the display
 * complement of YES (ADR-0061 decision 1, item 2), never a price to buy at, and both readings
 * are plain text rather than ADR-0041's outlined pill — Kalshi's buy button — so neither looks
 * like a control (owner decision 2026-10-16, ADR-0062).
 *
 * The two rows take `row.first` and `row.second` — Kalshi's green and blue — and not the `yes`
 * and `no` palettes the detail screen paints. The pair is what Kalshi draws on every tile, and
 * it can be borrowed without borrowing a meaning: each row is labelled YES or NO in words, the
 * bar is named "YES 63%" (PLAN 11.2, colour never alone), and the bar's length repeats the number
 * beside it, so the colour is decoration on a reading the text already gives. theme/system.ts
 * says the same at the token, and why neither bar is measured for WCAG 1.4.11.
 *
 * The probability is plain text, never `RollingNumber`. AC 1 requires a card to UPDATE within a
 * second, not to animate; PLAN 11.1-1 says a card shows "63%" only; and the rolling markup
 * would cost ten spans per digit in every card of the server's HTML for a page nobody stares
 * at. The socket writes the list cache, this text re-renders, and that is the whole of AC 1
 * here.
 *
 * `market` is a `MarketSummary`, the row `GET /markets` answers, so the admin's 카드 미리보기
 * (Q-M3-6) renders the REAL card from a draft that has no history at all — the preview must
 * show what a visitor will see, not a lookalike that drifts from it.
 *
 * `LinkBox`/`LinkOverlay` rather than an anchor wrapped round the card: the accessible name of
 * the link is then the question alone, while the whole card stays clickable. An anchor around
 * everything would announce the category, the price, the countdown and the 참여자 as one name.
 * The tile also holds one link of its own INSIDE the box — the category header goes to that
 * leaf's list — and it works because Chakra's `LinkBox` raises every nested `a[href]` that is
 * not the overlay to `position: relative; z-index: 1`, above the overlay's `::before` that covers
 * the card. The readings are NOT links: they used to open the detail's trade panel on their
 * outcome (`?outcome=`), and with no panel to open (#125) such a link would be a third tab stop to
 * the same URL. A click on a reading falls through to the overlay. `interactive` below drops every link
 * for the admin 미리보기 — a card that is not a link must not RENDER one, however thoroughly its
 * clicks are cancelled.
 *
 * The question is clamped to one line (`lineClamp="1"`): Kalshi truncates, and it is what keeps
 * every tile in a row the same height so the rows and the footers line up across the grid. The
 * accessible name of the overlay is the full question — the clamp is paint, not content — a
 * `title` attribute shows the rest on hover, and the detail page shows all of it (A-UI-4).
 *
 * The footer is one line, Kalshi's 28px: '참여자 N' on the left (`participantsText`, the detail
 * header's spelling — the count as it is, 0 included, ADR-0061 decision 1, item 4) where Kalshi
 * prints its volume. Its right slot, where Kalshi counts a series' markets, holds '최근 체결 <절대
 * 시각>' (#61, ADR-0136; ADR-0135 decision 1 item 1): when the price was set, in every status —
 * an ended card keeps its price and its time, and draws no result (ADR-0135 A2) — and empty
 * before the first fill. The line is there for every market, so every tile in a row keeps the
 * same height. Too long for one line — a zone marker such as ' (GMT-4)' in a narrow column — the
 * time folds under the count, right-aligned, rather than being cut.
 *
 * The line under the question is the countdown (`CountdownBadge`), as it is in every status. A
 * 개장 예정 market puts '예정 개장 <절대 시각>' before it on the same line (ADR-0135 A3), by its
 * status alone (`opensAtLine`), and a market cancelled before it opened (`closeLineKind`) leaves
 * the line empty at its height, as it had no trading to close. Every absolute time on the card is
 * one line in the zone in effect (`useFormatDateTime`, ADR-0063): the 판정 기준 시간대 is the
 * detail's rules area's (owner answer 2026-11-16, ADR-0136).
 *
 * The picture is a Chakra `Image` — a plain `<img>`, inside `CategoryIcon` — and never
 * `next/image`: `next.config.ts` declares no `images` block, so the optimizer answers 400 for
 * the off-origin URLs an admin types, and `output: 'standalone'` does not bundle the `sharp` it
 * wants either. The trade is that a broken URL has to be handled here, which is what
 * `failedImage` below is for.
 */

/**
 * The tile's outer stroke, shared by the two shells in `MarketCard` so the 미리보기 cannot drift from the
 * real card by a radius. No `overflow: hidden`: the fill inside inherits the radius, and a clip
 * here would cut off a focus ring drawn on the card's edge.
 */
const SHELL = {
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  borderRadius: 'card',
  borderWidth: '1px',
  borderColor: 'border.subtle',
} satisfies BoxProps;

/**
 * Kalshi's tile grid (ADR-0041) for a list of these cards: as many 360px-minimum columns as the
 * column fits, from md up; one column below. `auto-fill` rather than a breakpoint ladder because
 * the column's width depends on whether the 180px sidebar is beside it, which no breakpoint
 * knows. The home grid and MY's 관심 시장 (#89) both lay their cards out on it, and so does the
 * detail's 관련 시장 (#65), straight under its heading. There the column is about one tile wide —
 * at md the detail's section column is about 368px, less again where a scrollbar takes its
 * width — so a track is never wider than its grid (`min(360px, 100%)`): one tile as wide as the
 * column rather than one that runs out of it. Wherever the column holds a 360px tile the track is
 * 360px, as it always was.
 */
export const MARKET_GRID_COLUMNS = {
  base: '1fr',
  md: 'repeat(auto-fill, minmax(min(360px, 100%), 1fr))',
};

/** What a reading paints before the first fill (N02 §5): no number, not a 0 or a 50. */
const EMPTY = '—';

/**
 * The box of the '·' between '예정 개장 <시각>' and the countdown on a 개장 예정 card's close line:
 * the old `columnGap` of 8px on each side of the dot, as one fixed width, because the row is
 * pulled left by exactly this much to clip the dot that starts a line.
 */
const CLOSE_LINE_SEPARATOR = '20px';

/** The close line's '·' — decoration only, so a reader hears the two pieces and no dot. */
function CloseLineSeparator() {
  return (
    <Text
      as="span"
      textStyle="bodyXs"
      color="fg.muted"
      w={CLOSE_LINE_SEPARATOR}
      flexShrink="0"
      textAlign="center"
      aria-hidden="true"
    >
      ·
    </Text>
  );
}

/**
 * An outcome's reading: the percentage as plain emphasised text, right-aligned, with no outline
 * and no fill. ADR-0041 drew Kalshi's outcome pill here (36px, green outline), which on Kalshi is
 * the buy button; the owner chose (2026-10-16, ADR-0062) that the card's YES and NO must not look
 * like a control or a price to buy at — NO is only the display complement of YES (ADR-0061
 * decision 1, item 2). The pill's 36px row height and 80px column stay, so the rows, the 체결 없음
 * column and the tile keep their measurements.
 */
const READING = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  h: '36px',
  minW: '80px',
  textStyle: 'emphasisMd',
  color: 'fg',
} satisfies BoxProps;

export interface MarketCardProps {
  market: MarketSummary;
  /**
   * The instant the countdown measures against, from the caller's server render. Omitted, the
   * badge shows the absolute close time until it has mounted (countdown-badge.tsx).
   */
  now?: number;
  /**
   * False in the admin 미리보기 (Q-M3-6), which draws a market that has no page yet: an unsaved
   * draft's `/markets/[slug]` is a 404, and following it from 수정 would abandon what is typed.
   * The title is then plain text and the card is NOT a link.
   *
   * Cancelling the click on the way up — what the preview used to do — was not enough. A
   * default-prevented anchor still holds a tab stop and still announces as a link named after
   * the market, so a keyboard or screen-reader admin reached a control whose activation does
   * nothing; and `click` is not `auxclick`, so a middle-click opened the href in a new tab
   * regardless. `aria-disabled` + `tabIndex={-1}` was rejected for the same reason: it leaves
   * `role=link` in the reader's links list and the href live.
   */
  interactive?: boolean;
  /**
   * The title's heading level: the rank of the list the card sits in, one below its heading. The
   * home grid's cards are `h2`s beside the page's `h2` headline; MY's 관심 시장 (#89) lists them
   * under a section's `h3`, inside the layout's `h2` MY, so there they are `h4` — an `h2` there
   * would rank each card above its own section and file every later section under the last card
   * for anyone moving by headings (the page outline is one convention, A-M4-31).
   */
  titleAs?: 'h2' | 'h3' | 'h4';
  'data-testid'?: string;
}

export function MarketCard({
  market,
  now,
  interactive = true,
  titleAs = 'h2',
  'data-testid': testId,
}: MarketCardProps) {
  /**
   * The URL that failed, not a boolean: a card whose image is replaced (an admin edit arriving
   * over the socket, or the preview being typed into) then tries the new one instead of staying
   * broken, and no effect is needed to reset it.
   */
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const imageUrl = market.imageUrl;
  /**
   * `typedRoutes` only accepts an inline template literal once `/markets/[slug]` exists in the
   * generated route map, and the route directory lands with the detail screen; a `string` with
   * the cast the repo already uses for `redirect(nextPath as Route)` is correct either way.
   */
  const href = `/markets/${market.slug}` as Route;
  /**
   * One element, two parents: the overlay anchor is the ONLY difference between the real card's
   * title and the 미리보기's, and two copies of this `Heading` would drift the moment either was
   * restyled. The category header below follows the same rule.
   */
  const title = (
    // `title` on the heading is what the 미리보기 shows on hover; in the real card the overlay's
    // `::before` covers the tile and is the element the pointer is over, so the overlay anchor
    // below carries the same attribute — one string, two hosts, because the hit target differs.
    <Heading as={titleAs} textStyle="title" lineClamp="1" color="fg" title={market.title}>
      {market.title}
    </Heading>
  );
  /**
   * The tile at the head of the card shows the glyph of the market's TOP-LEVEL category, which
   * the leaf inherits (`cardIconSlug`): a seeded category from the seeded tree, so the server's
   * HTML already has the right glyph, and a leaf an admin added under a seeded parent from the
   * public category list once it has come (#61, ADR-0136) — one shared query on every screen, the
   * header's row too. Until then, and for a slug the list does not hold (the preview's `''` before
   * a category is chosen, a hidden category), the slug answers itself: the neutral glyph.
   */
  const { data: categories } = useCategories();
  const iconSlug = cardIconSlug(market.category.slug, categories);
  const formatDateTime = useFormatDateTime();
  const opensAt = opensAtLine(market);
  const lastFillAt = lastFillLine(market);
  const categoryHeader = (
    <>
      <CategoryIcon
        slug={iconSlug}
        // A dead URL falls back to the glyph rather than a broken image: the tile is the same
        // 28px either way, so nothing reflows a second after it painted.
        imageUrl={imageUrl === failedImage ? null : imageUrl}
        onImageError={() => {
          setFailedImage(imageUrl);
        }}
        size={28}
      />
      <Text as="span" textStyle="overline" color="fg.muted" truncate minW="0">
        {market.category.nameKo}
      </Text>
    </>
  );

  // The whole tile is one column with three bands — header, rows, footer — pushed apart by
  // `justifyContent="space-between"` so the footer sits on the bottom edge of every card in a
  // row whatever the header above it took. `borderRadius="inherit"` keeps the fill inside the
  // shell's rounded stroke without an `overflow: hidden` on the shell, which would clip a
  // focus ring on the card's edge.
  const body = (
    <Stack
      bg="surface.card"
      pt="4"
      px="4"
      pb="3"
      gap="4"
      justify="space-between"
      flex="1"
      h="100%"
      minH="232px"
      borderRadius="inherit"
    >
      <Stack gap="2">
        <HStack justify="space-between" gap="2">
          {interactive ? (
            // `prefetch={false}`: `/` is force-dynamic, and a prefetch there renders a whole
            // filtered list for a link that may never be clicked (market-filters.tsx). A
            // UrlObject rather than a template literal so `href` takes it without a `Route`
            // cast and Next encodes the slug.
            <HStack asChild gap="3" minW="0" _hover={{ opacity: 0.75 }} transition="opacity 0.15s">
              <NextLink
                href={{ pathname: '/', query: { category: market.category.slug } }}
                prefetch={false}
              >
                {categoryHeader}
              </NextLink>
            </HStack>
          ) : (
            <HStack gap="3" minW="0">
              {categoryHeader}
            </HStack>
          )}
          {/* An open market's state is the countdown below; anything else is worth naming. */}
          {market.status !== 'open' && (
            <Badge
              colorPalette={MARKET_STATUS_PALETTE[market.status]}
              variant="subtle"
              flexShrink="0"
            >
              {marketStatusLabel(market)}
            </Badge>
          )}
        </HStack>

        <Stack gap="2px">
          {interactive ? (
            <LinkOverlay asChild>
              <NextLink href={href} title={market.title}>
                {title}
              </NextLink>
            </LinkOverlay>
          ) : (
            title
          )}
          {closeLineKind(market) === 'blank' ? (
            // Cancelled before it opened (#20): no trading to close, so no 마감됨 under the 취소
            // badge — and the line's 18px stay, so the tile keeps its rows where they were.
            <Box h="18px" aria-hidden="true" />
          ) : (
            // Only a 개장 예정 card has more than the countdown on this line: '예정 개장 <시각> · 마감
            // …'. A line too long for the tile folds between the two pieces, never inside the time
            // (`nowrap`), and the '·' never hangs at a line's end or starts one: each piece carries
            // its own leading '·' in a fixed `CLOSE_LINE_SEPARATOR` box, the row is pulled that
            // far to the left, and the wrapper's `overflow: hidden` clips the '·' of whichever
            // piece starts a line — so it shows only between two pieces on the same line.
            // One tree for every card that has the line, the 예정 개장 piece a hole when absent:
            // the countdown keeps its place, so a 개장 예정 card that opens under the visitor
            // (`market:status`) keeps the SAME CountdownBadge, with its server-clock anchor —
            // a remount would anchor to `now`, which a list's later renders no longer pass.
            <Box overflow="hidden" minH="18px" data-testid="market-card-close-line">
              <Flex wrap="wrap" rowGap="0" ms={`-${CLOSE_LINE_SEPARATOR}`}>
                {opensAt !== null && (
                  <Flex as="span" key="opens-at">
                    <CloseLineSeparator />
                    <Text
                      as="span"
                      textStyle="bodyXs"
                      color="fg.muted"
                      whiteSpace="nowrap"
                      data-testid="market-card-opens-at"
                    >
                      {`${copy.marketScheduledOpenAt} ${formatDateTime(opensAt)}`}
                    </Text>
                  </Flex>
                )}
                <Flex as="span" key="countdown">
                  <CloseLineSeparator />
                  <CountdownBadge market={market} now={now} variant="text" />
                </Flex>
              </Flex>
            </Box>
          )}
        </Stack>
      </Stack>

      {/*
        Kalshi's row grid: the label over its bar in the first column, the reading in the third,
        and between them a column that is empty while there is a price. With no fill it says
        체결 없음 once, across both rows and beside the two '—' readings, so the readings of both rows
        stay on one right edge either way; it is last in the DOM so a reader hears YES, NO, then
        체결 없음.
      */}
      <Grid templateColumns="1fr auto auto" columnGap="1" rowGap="6px" w="100%">
        {outcomeRows(market.lastPrice).map((row) => (
          <OutcomeRowCells key={row.key} row={row} />
        ))}
        {market.lastPrice === null && (
          <Text
            as="span"
            gridColumn="2"
            gridRow="1 / span 2"
            alignSelf="center"
            px="1"
            whiteSpace="nowrap"
            textStyle="emphasisSm"
            color="fg.muted"
            data-testid="market-card-no-fills"
          >
            {copy.noFills}
          </Text>
        )}
      </Grid>

      <Flex align="center" justify="space-between" wrap="wrap" columnGap="3" minH="28px">
        {/* `participantsText` writes it in the detail header's spelling. One line, so the label
            and its number never part. */}
        <Text
          as="span"
          textStyle="bodyXs"
          color="fg"
          whiteSpace="nowrap"
          data-testid="market-card-traders"
        >
          {participantsText(market)}
        </Text>
        {/* Its own box, not inside the count's, and one line: folded under the count, it keeps to
            the right edge (`ms="auto"`). */}
        {lastFillAt !== null && (
          <Text
            as="span"
            textStyle="bodyXs"
            color="fg.muted"
            whiteSpace="nowrap"
            ms="auto"
            data-testid="market-card-last-fill"
          >
            {`${copy.marketLastFillAt} ${formatDateTime(lastFillAt)}`}
          </Text>
        )}
      </Flex>
    </Stack>
  );

  const shellTestId = testId ?? `market-card-${market.id}`;

  // `LinkBox` only where the card actually goes somewhere; the 미리보기 is a plain `<article>`
  // with the same stroke and no hover, no press and no pointer cursor, because each of those
  // would promise a click it does not have. The pressed state is Kalshi's `scale(0.95)`, and
  // `_motionReduce` — Chakra for `@media (prefers-reduced-motion: reduce)` — turns the
  // transform off for a visitor who asked for no motion (the border transition stays; a colour
  // fade is not motion).
  return interactive ? (
    <LinkBox
      as="article"
      {...SHELL}
      cursor="pointer"
      transition="border-color 0.15s, transform 0.15s"
      _hover={{ borderColor: 'border.emphasized' }}
      _active={{ transform: 'scale(0.95)' }}
      _motionReduce={{ transition: 'border-color 0.15s', _active: { transform: 'none' } }}
      data-testid={shellTestId}
    >
      {body}
    </LinkBox>
  ) : (
    <Box as="article" {...SHELL} data-testid={shellTestId}>
      {body}
    </Box>
  );
}

/**
 * One outcome row's grid cells (a fragment, so the parent `Grid` places them). The reading
 * "YES 63%" is announced ONCE per row, by the bar: a labelled `progressbar` with that string.
 * The reading is a `<span>`, and `aria-label` on a generic element is prohibited by ARIA 1.2 and
 * dropped by browsers, so the reading is the one hidden — it paints the same number the bar
 * already names.
 *
 * The reading paints a percent, never a Coin price, and is not a control: YES is the last fill and
 * NO only its display complement (ADR-0061 decision 1, item 2), and neither is a price anyone
 * can buy at. A click on it falls through to the card's overlay like a click anywhere else.
 *
 * With no reading there is no bar to label: the row is its label and a '—', and the card's
 * one 체결 없음 says why. The row then has no empty middle cell either — the 체결 없음 holds that
 * column for both rows by explicit placement, and an auto-placed empty cell would skip past it
 * and push the reading onto the next row.
 */
function OutcomeRowCells({ row }: { row: OutcomeRow }) {
  const { reading } = row;
  const percentText = reading === null ? EMPTY : `${String(reading.percent)}%`;
  const testId = row.key === 'yes' ? 'market-card-probability' : 'market-card-probability-no';
  return (
    <>
      <Stack gap="2px" minW="0">
        <Text as="span" textStyle="bodyMd" truncate>
          {row.label}
        </Text>
        {reading === null ? (
          // The bar's 2px, kept so the label sits where it will once there is a price.
          <Box h="2px" />
        ) : (
          <Box
            role="progressbar"
            aria-valuenow={reading.percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={reading.accessibleName}
            h="2px"
            w="100%"
            borderRadius="pill"
            overflow="hidden"
          >
            <Box
              h="100%"
              w={percentText}
              // Kalshi's floor: a 1% market still shows a sliver of colour, not an empty track.
              minW="4px"
              bg={row.accent}
              borderRadius="pill"
              // The bar eases to a new price on a socket tick; a visitor who asked for no motion
              // sees it jump.
              transition="width 0.3s"
              _motionReduce={{ transition: 'none' }}
            />
          </Box>
        )}
      </Stack>
      {reading !== null && <Box />}
      <Box as="span" aria-hidden="true" {...READING} justifySelf="end" data-testid={testId}>
        {percentText}
      </Box>
    </>
  );
}
