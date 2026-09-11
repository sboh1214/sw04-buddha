'use client';

import {
  Box,
  Container,
  HStack,
  Heading,
  IconButton,
  Input,
  InputGroup,
  Skeleton,
  Link as ChakraLink,
} from '@chakra-ui/react';
import type { Route } from 'next';
import Form from 'next/form';
import NextLink from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import type { UrlObject } from 'url';
import { AuthButtons } from '@/components/auth/auth-buttons';
import { ColorModeButton } from '@/components/ui/color-mode';
import { copy } from '@/copy';
import { useCategories } from '@/hooks/use-markets';
import { type CategoryNode, groupCategories } from '@/lib/category-tree';
import {
  type PrimaryNavKey,
  currentTopLevelSlug,
  isAllCategoriesCurrent,
  isPrimaryCurrent,
} from '@/lib/nav';

/**
 * Top navigation (PLAN 11.4, ADR-0041 Kalshi 형): two rows in one sticky header.
 *
 * Row 1: 로고 · 시장/랭킹/커뮤니티 · 검색 · 색상 모드 · 잔고 칩 · 프로필 메뉴. The balance chip and the
 * profile menu are `AuthButtons`, unchanged since M1 — the chip is what AC 3 watches after a
 * trade, and it stays live because `use-trade` writes `['me']` from the trade answer and the
 * socket's `user:balance` writes it again.
 *
 * Row 2: 전체 and the top-level market categories, on every breakpoint (it scrolls sideways where
 * it does not fit). It is Kalshi's category strip and the home screen's coarse filter in one:
 * the home screen's own sidebar then lists the leaves of whichever top-level category is chosen.
 *
 * The whole header is a client component: the search box holds the open/closed state of its
 * mobile form, row 1 reads `usePathname` and row 2 reads `useCategories()` and the URL's
 * `?category=`. It still renders into the server HTML like every other client component, so
 * nothing about the SSR first paint changes.
 *
 * Kalshi's measurements (from kalshi.com, 2026-09-11): a 1320px container with 24px side
 * padding; row 1 is 40px tall with 12px above and below; row 2 is 30px tall, and the header is
 * 107px with its bottom rule — the number `HEADER_HEIGHT_PX` (lib/nav.ts) records for the home
 * screen's sticky sidebar.
 */
export function Nav() {
  // The mobile row already carries the logo, the balance chip and the profile menu, so search
  // collapses to an icon that opens the same form under it. It deliberately does not reach into
  // the home screen's own search box: that box lives in a file this component does not own, and a
  // header whose search only works on `/` would be worse than one that works everywhere.
  const [searchOpen, setSearchOpen] = useState(false);

  return (
    <Box as="header" borderBottomWidth="1px" bg="bg" position="sticky" top="0" zIndex="sticky">
      {/* The 12px above row 1 is PADDING on the container, not a margin on the row: a margin
          there collapses through the header's top edge (nothing separates them), leaving the
          header 12px shorter than it is laid out to be and the sidebar's sticky offset wrong. */}
      <Container maxW="1320px" px="6" pt="3">
        <HStack h="40px" mb="3" gap="3" justify="space-between">
          <HStack gap="4" flexShrink="0">
            {/* 26px tall in brand green, Kalshi's wordmark. `letterSpacing="tight"` is what
                keeps the lowercase name reading as a mark rather than a word. */}
            <Heading
              as="h1"
              fontSize="22px"
              lineHeight="26px"
              letterSpacing="tight"
              color="brand.fg"
            >
              <NextLink href="/">{copy.appName}</NextLink>
            </Heading>
            <PrimaryLinks />
          </HStack>
          {/* `flex="1"` here and on the search wrapper: the field grows into whatever row 1 has
              left after the primary items and the buttons, up to Kalshi's 400px. */}
          <HStack gap="2" flex="1" justify="flex-end" minW="0">
            <Box hideBelow="md" flex="1" maxW="400px">
              <SearchForm testId="nav-search" />
            </Box>
            <IconButton
              hideFrom="md"
              variant="ghost"
              size="sm"
              borderRadius="pill"
              aria-label={copy.searchLabel}
              aria-expanded={searchOpen}
              data-testid="nav-search-toggle"
              onClick={() => {
                setSearchOpen((open) => !open);
              }}
            >
              <SearchIcon />
            </IconButton>
            {/* Wrapped rather than given `display`: the button's own props reach the `Button`
                only, and its client-only skeleton would otherwise show below md too. */}
            <Box hideBelow="md">
              <ColorModeButton />
            </Box>
            <AuthButtons />
          </HStack>
        </HStack>
        {searchOpen && (
          <Box hideFrom="md" pb="3">
            <SearchForm
              testId="nav-search-mobile"
              autoFocus
              onSubmitted={() => {
                setSearchOpen(false);
              }}
            />
          </Box>
        )}
        <CategoryNav />
      </Container>
    </Box>
  );
}

/**
 * Row 1's three destinations. Next 16 types `href`, so the list is declared as routes rather
 * than plain strings (the idiom at bottom-tabs.tsx); `/community` is `app/community/page.tsx`.
 */
const PRIMARY: { key: PrimaryNavKey; href: Route; label: string }[] = [
  { key: 'markets', href: '/', label: copy.navMarkets },
  { key: 'ranking', href: '/leaderboard', label: copy.navRanking },
  { key: 'community', href: '/community', label: copy.navCommunity },
];

/**
 * 시장 · 랭킹 · 커뮤니티 as Kalshi's pill items, md and up (below md the bottom tab bar is the
 * primary navigation, PLAN 11.4). The current item is `aria-current="page"` as well as the
 * `surface.hover` wash, so it is never signalled by the fill alone (PLAN 11.2); which item is
 * current is `isPrimaryCurrent` (lib/nav.ts), where it is tested.
 *
 * `usePathname` is safe in the root layout — it is `useSearchParams` that forces a static page
 * into a Suspense boundary (see `CategoryNav`).
 *
 * `textStyle="overlineLg"` for the weight and tracking Kalshi's items have; its uppercase
 * transform is a no-op on Korean and is left in so the one text style stays one text style.
 */
function PrimaryLinks() {
  const pathname = usePathname();

  return (
    <HStack as="nav" aria-label={copy.navPrimary} hideBelow="md" gap="1">
      {PRIMARY.map((item) => {
        const current = isPrimaryCurrent(pathname, item.key);
        return (
          <ChakraLink
            key={item.key}
            asChild
            h="36px"
            px="4"
            borderRadius="pill"
            textStyle="overlineLg"
            color="fg"
            textDecoration="none"
            bg={current ? 'surface.hover' : undefined}
            _hover={{ bg: 'surface.hover', textDecoration: 'none' }}
            data-testid={`nav-primary-${item.key}`}
          >
            <NextLink href={item.href} aria-current={current ? 'page' : undefined}>
              {item.label}
            </NextLink>
          </ChakraLink>
        );
      })}
    </HStack>
  );
}

/**
 * The search entry. A real `<form>` that navigates to `/?q=…` rather than an `onSubmit` handler
 * calling `router.push`: `next/form` submits the field as a search param, so the search works
 * with JavaScript disabled and the home page reads the term from the URL it already normalises
 * (`filtersFromSearchParams`) instead of from a second, client-only source of truth. A blank
 * term parses as "no search" there, so submitting an empty box lands on the unfiltered list.
 *
 * It posts a fresh `/?q=…` rather than amending the filters already in the URL: this header is on
 * every route, so its search is a way INTO the list, not a refinement of a list the visitor may
 * not even be looking at. It is also the ONLY search box since ADR-0041 — the home screen's own
 * form went with the Kalshi layout, and Kalshi has no search within a category either.
 *
 * `prefetch={false}`: this header is on every route, and the home page is `force-dynamic`, so the
 * default action prefetch would ask the server for it from every page the visitor opens.
 *
 * Styled as Kalshi's field: a 38px pill on `surface.input` with no visible stroke and the
 * magnifier at the LEFT. The magnifier IS the submit control rather than a decoration beside a
 * second button at the end — one glyph, as on kalshi.com, and Enter still submits because it is a
 * native `<form>`. It keeps `copy.searchSubmit` as its accessible name, so a screen reader still
 * finds a "검색" button in the form. `InputGroup` places a start element with
 * `pointerEvents: none` (right for a decorative glyph, wrong for a button), so that is overridden.
 *
 * `testId` is required, not defaulted, for the reason the trade panel takes a prefix: at <md the
 * desktop form is still mounted behind `display: none`, so while the mobile form is open both are
 * in the DOM and a shared id would make every Playwright selector ambiguous.
 */
function SearchForm({
  testId,
  autoFocus = false,
  onSubmitted,
}: {
  testId: string;
  autoFocus?: boolean;
  onSubmitted?: () => void;
}) {
  return (
    <Form action="/" prefetch={false} role="search" onSubmit={onSubmitted}>
      <InputGroup
        startElement={
          <IconButton
            type="submit"
            variant="ghost"
            size="xs"
            borderRadius="pill"
            color="fg.muted"
            aria-label={copy.searchSubmit}
          >
            <SearchIcon />
          </IconButton>
        }
        // 8px in from the pill's edge: the 32px button then ends at 40px and the text starts at
        // Kalshi's 44px (`ps` below), so the glyph sits where its magnifier sits.
        startElementProps={{ pointerEvents: 'auto', ps: '2', pe: '0' }}
      >
        <Input
          name="q"
          type="search"
          size="sm"
          // `subtle` is the variant with a transparent stroke; the fill is the theme's search
          // ground rather than the variant's `bg.muted`. The stroke stays in the box (at 0 alpha)
          // so the focus ring the variant paints on it still shows.
          variant="subtle"
          h="38px"
          ps="44px"
          borderRadius="pill"
          bg="surface.input"
          // The placeholder is not a label: it disappears on the first keystroke and screen
          // readers are not required to announce it (WCAG 3.3.2).
          aria-label={copy.searchLabel}
          placeholder={copy.searchPlaceholder}
          autoFocus={autoFocus}
          data-testid={testId}
        />
      </InputGroup>
    </Form>
  );
}

/**
 * Row 2 (PLAN 11.4, ADR-0041): 전체 and the top-level categories, on every breakpoint.
 *
 * The row has to know the URL's `?category=` to mark the current item, and the only honest
 * source for that is `useSearchParams` — the same param the home page normalises. But this
 * header renders on every route from the root layout, and a `useSearchParams` read during the
 * static prerender of `/login`, `/signup`, … bails the render out to the nearest Suspense
 * boundary (`next build` fails when there is none). So the read lives in `CurrentCategoryRow`
 * behind its own `<Suspense>`, and the fallback is the SAME row with nothing marked current.
 * A static page therefore prerenders the full row — the links, the skeleton, 전체 — and when the
 * boundary resolves in the browser it re-renders to an identical row (off `/` nothing is
 * current anyway), so nothing flashes and no static page turns dynamic. On `/`, which is
 * `force-dynamic`, the params are known at request time and the real row goes into the HTML.
 *
 * The categories query and the grouping are read ONCE here and handed to both branches of the
 * boundary, so the fallback and the real row cannot disagree about what they list.
 */
function CategoryNav() {
  const { data: categories, isPending } = useCategories();
  const tree = categories === undefined ? undefined : groupCategories(categories);

  return (
    <Suspense fallback={<CategoryRow tree={tree} isPending={isPending} />}>
      <CurrentCategoryRow tree={tree} isPending={isPending} />
    </Suspense>
  );
}

/** The row with its current item read from the URL; see `CategoryNav` for why it is separate. */
function CurrentCategoryRow({ tree, isPending }: { tree?: CategoryNode[]; isPending: boolean }) {
  const pathname = usePathname();
  const category = useSearchParams().get('category');

  return (
    <CategoryRow
      tree={tree}
      isPending={isPending}
      allCurrent={isAllCategoriesCurrent(pathname, category)}
      currentSlug={currentTopLevelSlug(pathname, tree ?? [], category)}
    />
  );
}

/**
 * The row itself: Kalshi's category strip. Items 16px apart, `emphasisMd`, resting dimmed and
 * lifting to full opacity under the pointer or when current — and the current one also carries
 * `aria-current="page"` (PLAN 11.2). Only the TOP level is listed: a leaf is picked in the home
 * screen's sidebar, and the strip marks the leaf's parent (lib/nav.ts).
 *
 * Kalshi rests its items at opacity 0.5, which puts 15px text at 3.95:1 on the light page —
 * under the 4.5:1 WCAG 1.4.3 asks of text and the theme file otherwise measures (AC 6). 0.55 is
 * the first step that clears it in both modes (light 4.74:1, dark 6.04:1 on `#0a0c0f`) and is
 * the resting value here; the difference from Kalshi's is not visible side by side.
 *
 * A failed `GET /categories` renders the 전체 link alone — a header must not shout about a list
 * it only offers as a shortcut. Each href is a UrlObject rather than a template literal: `href`
 * takes one without a `Route` cast, and Next encodes the slug. `prefetch={false}` on each, for
 * the reason the search form gives: the home route is `force-dynamic`.
 *
 * It scrolls sideways with no visible scrollbar (`scrollbarWidth` for Firefox, the
 * `::-webkit-scrollbar` rule for the rest). A scroll container clips its children's outlines,
 * which would cut the keyboard focus ring off the top and the left of the first item; the 4px
 * of padding pulled back with a matching negative margin keeps the row exactly where Kalshi's
 * measurements put it (30px + 8px below) while giving the 2px ring and its 2px offset room.
 *
 * Labelled 카테고리: the row-1 landmark is 주 메뉴 and the home screen's sidebar is 세부 분류
 * (`copy.marketSubcategories`), so no two navigation landmarks on a page share a name and a
 * screen-reader user's landmark list says which is which.
 */
function CategoryRow({
  tree,
  isPending,
  allCurrent = false,
  currentSlug,
}: {
  tree?: CategoryNode[];
  isPending: boolean;
  allCurrent?: boolean;
  currentSlug?: string;
}) {
  return (
    <HStack
      as="nav"
      aria-label={copy.marketCategories}
      gap="4"
      // 30px of row + 12px below (Kalshi's 8px plus the 4px that makes the header its measured
      // 107px, which the home screen's sticky sidebar offsets against), plus the 4px of focus
      // room above that `mt="-1"` gives back.
      h="46px"
      pt="1"
      pb="3"
      mt="-1"
      px="1"
      mx="-1"
      overflowX="auto"
      scrollbarWidth="none"
      css={{ '&::-webkit-scrollbar': { display: 'none' } }}
      data-testid="nav-categories"
    >
      <CategoryLink href="/" current={allCurrent} testId="nav-category-all">
        {copy.marketsAll}
      </CategoryLink>
      {isPending ? (
        <Skeleton height="4" width="48" />
      ) : (
        tree?.map((node) => (
          <CategoryLink
            key={node.category.slug}
            href={{ pathname: '/', query: { category: node.category.slug } }}
            current={node.category.slug === currentSlug}
            testId={`nav-category-${node.category.slug}`}
          >
            {node.category.nameKo}
          </CategoryLink>
        ))
      )}
    </HStack>
  );
}

/** One item of row 2. `flexShrink="0"`: a scroll row must not squeeze its items to fit. */
function CategoryLink({
  href,
  current,
  testId,
  children,
}: {
  href: Route | UrlObject;
  current: boolean;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <ChakraLink
      asChild
      textStyle="emphasisMd"
      py="1"
      color="fg"
      whiteSpace="nowrap"
      flexShrink="0"
      textDecoration="none"
      opacity={current ? 1 : 0.55}
      transition="opacity 0.2s"
      _hover={{ opacity: 1, textDecoration: 'none' }}
      data-testid={testId}
    >
      <NextLink href={href} prefetch={false} aria-current={current ? 'page' : undefined}>
        {children}
      </NextLink>
    </ChakraLink>
  );
}

/** Magnifier. The repo draws its own icons (components/ui/password-input.tsx); no icon package. */
function SearchIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.6-3.6" />
    </svg>
  );
}
