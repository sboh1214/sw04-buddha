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
  VisuallyHidden,
} from '@chakra-ui/react';
import { formatP, parsePAmount } from '@buddha/shared';
import type { Route } from 'next';
import NextLink from 'next/link';
import { useState } from 'react';
import { copy } from '@/copy';
import { type MarketSummary } from '@/lib/api';
import { parentCategorySlug } from '@/lib/category-tree';
import { MARKET_STATUS_LABEL, MARKET_STATUS_PALETTE } from '@/lib/market-admin';
import { type OutcomeRow, outcomeRows } from '@/lib/market-card';
import { CategoryIcon } from './category-icon';
import { CountdownBadge } from './countdown-badge';
import { MarketSparkline } from './market-sparkline';

/**
 * One market in the home grid (PLAN 11.4 MarketCard, PLAN 11.1's Polymarket note), drawn as
 * Kalshi's tile (ADR-0041, measured off kalshi.com): a header — the category's icon and name
 * over the question and its countdown — then one row per outcome, 예 and 아니오, each a label
 * over a hairline bar, the "맞히면 투입 대비 1.59x" figure and a pill with the percentage, and a
 * footer with the 거래량 on the left and the sparkline on the right. The whole card is a link
 * to the detail.
 *
 * The two rows take `row.first` and `row.second` — Kalshi's green and blue — and not the `yes`
 * and `no` palettes the detail screen paints. The pair is what Kalshi draws on every tile, and
 * it can be borrowed without borrowing a meaning: each row is labelled 예 or 아니오 in words, the
 * pill is named "예 63%" (PLAN 11.2, colour never alone), and the bar's length repeats the number
 * beside it, so the colour is decoration on a reading the text already gives. theme/system.ts
 * says the same at the token, and why neither bar is measured for WCAG 1.4.11.
 *
 * The probability is plain text, never `RollingNumber`. AC 1 requires a card to UPDATE within a
 * second, not to animate; PLAN 11.1-1 says a card shows "63%" only; and the rolling markup
 * would cost ten spans per digit in every card of the server's HTML for a page nobody stares
 * at. The socket writes the list cache, this text re-renders, and that is the whole of AC 1
 * here.
 *
 * `market` is a `MarketSummary` rather than the list's `MarketListItem`, and the sparkline is a
 * separate optional prop, so the admin's 카드 미리보기 (Q-M3-6) can render the REAL card from a
 * draft that has no history at all — the preview must show what a visitor will see, not a
 * lookalike that drifts from it.
 *
 * `LinkBox`/`LinkOverlay` rather than an anchor wrapped round the card: the accessible name of
 * the link is then the question alone, while the whole card stays clickable. An anchor around
 * everything would announce the category, the price, the volume and the countdown as one name.
 * The tile also holds links of its own INSIDE the box — the category header goes to that leaf's
 * list, each pill to the detail — and they work because Chakra's `LinkBox` raises every nested
 * `a[href]` that is not the overlay to `position: relative; z-index: 1`, above the overlay's
 * `::before` that covers the card. A click on a pill hits the pill; a click anywhere else hits
 * the overlay. `interactive` below drops every one of those links for the admin 미리보기 — a
 * card that is not a link must not RENDER one, however thoroughly its clicks are cancelled.
 *
 * The question is clamped to one line (`lineClamp="1"`): Kalshi truncates, and it is what keeps
 * every tile in a row the same height so the rows and the footers line up across the grid. The
 * accessible name of the overlay is the full question — the clamp is paint, not content — and
 * the detail page shows all of it.
 *
 * The sparkline sits in the footer's right slot, where Kalshi prints a market count ("27
 * markets") that has no counterpart here — a market is one question, not a series — and PLAN
 * 11.4 asks for the 24-hour trace on the card. The slot is the same size either way, so the
 * footer keeps Kalshi's 28px line.
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
 * here would cut the focus ring off a pill on the card's edge.
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
 * Kalshi's outcome pill (36px, `rounded-x50`, the green outline): the one style for the link a
 * visitor clicks and the `<span>` the 미리보기 shows, so the preview is a picture of the real pill.
 * The outline is `brand.border`, not `row.first`: a component boundary owes WCAG 1.4.11 its 3:1,
 * which light `row.first` does not pay and light `brand.border` (600) does (theme/system.ts).
 */
const PILL = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  h: '36px',
  minW: '80px',
  px: '2',
  borderRadius: 'pill',
  borderWidth: '1px',
  borderColor: 'brand.border',
  textStyle: 'emphasisMd',
  color: 'fg',
} satisfies BoxProps;

export interface MarketCardProps {
  market: MarketSummary;
  /**
   * `MarketListItem.sparkline` — oldest-first hourly pYesBp. Absent for a draft preview, and
   * `[]` for a market with no tick at all; both render as an empty box of the same height.
   */
  sparkline?: number[];
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
  'data-testid'?: string;
}

export function MarketCard({
  market,
  sparkline,
  now,
  interactive = true,
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
   * restyled. The category header and the pills below follow the same rule.
   */
  const title = (
    <Heading as="h2" textStyle="title" lineClamp="1" color="fg">
      {market.title}
    </Heading>
  );
  /**
   * The tile at the head of the card shows the glyph of the market's TOP-LEVEL category, which
   * the leaf inherits, and `parentCategorySlug` resolves it from the seeded tree so the server's
   * HTML already has the right glyph. A slug the tree does not know (the preview's `''` before
   * a category is chosen) falls back to itself and draws the neutral glyph.
   */
  const iconSlug = parentCategorySlug(market.category.slug) ?? market.category.slug;
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
  // shell's rounded stroke without an `overflow: hidden` on the shell, which would clip the
  // pill's focus ring.
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
              {MARKET_STATUS_LABEL[market.status]}
            </Badge>
          )}
        </HStack>

        <Stack gap="2px">
          {interactive ? (
            <LinkOverlay asChild>
              <NextLink href={href}>{title}</NextLink>
            </LinkOverlay>
          ) : (
            title
          )}
          <CountdownBadge market={market} now={now} variant="text" />
        </Stack>
      </Stack>

      {/*
        Kalshi's row grid, copied cell for cell: the label over its bar in the first column, an
        empty second column, and the multiple with the pill in the third. Three columns rather
        than two so the empty cell keeps the pills of every row on one right edge whatever the
        multiple's width.
      */}
      <Grid templateColumns="1fr auto auto" columnGap="1" rowGap="6px" w="100%">
        {outcomeRows(market.lastPrice).map((row) => (
          <OutcomeRowCells key={row.key} row={row} href={href} interactive={interactive} />
        ))}
      </Grid>

      <Flex justify="space-between" align="center" minH="28px">
        <Text as="span" textStyle="bodyXs" color="fg">
          {copy.marketVolume} {formatP(parsePAmount(market.volumeP))}
        </Text>
        {sparkline === undefined ? null : <MarketSparkline points={sparkline} />}
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
 * One outcome row's three grid cells (a fragment, so the parent `Grid` places them). The
 * reading "예 63%" is announced ONCE per row, and which element carries it depends on which one
 * is a real object in the accessibility tree:
 *
 * - Interactive, the pill is a link, and a link's `aria-label` is its name — so the pill says
 *   "예 63%" and the bar is `aria-hidden`. The bar cannot be the carrier here without a second
 *   reading, and the pill cannot be hidden: a focusable element inside `aria-hidden` is a
 *   violation in its own right.
 * - In the 미리보기 the pill is a `<span>`, and `aria-label` on a generic element is prohibited
 *   by ARIA 1.2 and dropped by browsers, so a name there would be silently lost. The bar — a
 *   labelled `progressbar` with the same string — is the carrier instead, and the span is the
 *   one hidden.
 *
 * The bar keeps its `role="progressbar"` and value attributes in both modes rather than growing
 * them only in the preview: `aria-hidden` removes it from the tree entirely, so the role costs
 * nothing when hidden, and one markup for the bar is one less thing for the two modes to drift
 * on.
 */
function OutcomeRowCells({
  row,
  href,
  interactive,
}: {
  row: OutcomeRow;
  href: Route;
  interactive: boolean;
}) {
  const percentText = `${String(row.percent)}%`;
  const testId = row.key === 'yes' ? 'market-card-probability' : 'market-card-probability-no';
  return (
    <>
      <Stack gap="2px" minW="0">
        <Text as="span" textStyle="bodyMd" truncate>
          {row.label}
        </Text>
        <Box
          role="progressbar"
          aria-valuenow={row.percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={row.accessibleName}
          aria-hidden={interactive ? 'true' : undefined}
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
      </Stack>
      <Box />
      <HStack gap="6px">
        <Text as="span" textStyle="emphasisSm" color="fg.muted" minW="18px" textAlign="right">
          {/*
            The figure alone is "1.59x", which says nothing to a listener; the sr-only prefix
            makes it "맞히면 투입 대비 1.59x" — the sentence PLAN 11.1-2 wants everywhere, in the
            vocabulary Appendix A allows.
          */}
          <VisuallyHidden>{copy.payoutMultiple} </VisuallyHidden>
          {row.multiple}
        </Text>
        {interactive ? (
          // The hover tint only where the pill goes somewhere, for the reason the shell gives.
          <Box
            asChild
            {...PILL}
            transition="background-color 0.15s"
            _hover={{ bg: 'row.firstTint' }}
          >
            <NextLink href={href} aria-label={row.accessibleName} data-testid={testId}>
              {percentText}
            </NextLink>
          </Box>
        ) : (
          <Box as="span" aria-hidden="true" {...PILL} data-testid={testId}>
            {percentText}
          </Box>
        )}
      </HStack>
    </>
  );
}
