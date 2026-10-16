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
import { type ReactNode, Suspense, useState } from 'react';
import type { UrlObject } from 'url';
import { AuthButtons } from '@/components/auth/auth-buttons';
import { ColorModeButton } from '@/components/ui/color-mode';
import { copy } from '@/copy';
import { useCategories } from '@/hooks/use-markets';
import { type CategoryNode, groupCategories } from '@/lib/category-tree';
import {
  CATEGORY_ITEM_OPACITY,
  type UrlSearchParams,
  categoryLinkQuery,
  currentSearchTerm,
  currentTopLevelSlug,
  isAllCategoriesCurrent,
  isPrimaryCurrent,
  primaryNavItems,
  showsCategoryRow,
} from '@/lib/nav';
import { useSession } from '@/lib/use-session';

/**
 * Top navigation (PLAN 11.4, ADR-0041 Kalshi 형, #16): one sticky header, two rows on 시장 탐색.
 *
 * Row 1: 로고 · 시장 탐색/커뮤니티/MY · 검색 · 색상 모드 · 잔고 칩 (or 로그인/가입하기). The three
 * areas are N02 §2's top level, and the tab bar lists the same three below md (bottom-tabs.tsx).
 * The chip is `AuthButtons`; there is no profile menu — 관리자 and 로그아웃 are in MY (owner
 * decision 2026-10-13).
 *
 * Row 2: 전체 and the top-level market categories, on every breakpoint (it scrolls sideways where
 * it does not fit), on 시장 탐색 only (`showsCategoryRow`, owner decision 2026-10-13). It is
 * Kalshi's category strip and the home screen's coarse filter in one: the home screen's own
 * sidebar then lists the leaves of whichever top-level category is chosen.
 *
 * The whole header is a client component: the search box holds the open/closed state of its
 * mobile form, both rows read `usePathname` and row 2 reads `useCategories()` and the URL's query
 * (`?category=` for the current item, `?watchlist=1` and `?sort=` for where its items go). It
 * still renders into the server HTML like every other client component, and the pathname is
 * known on the server, so a route without row 2 is served without it. Nothing in it reads the
 * session before hydration (`useSession` is pending until then), so the server HTML of an
 * address is the same for every visitor.
 *
 * Kalshi's measurements (from kalshi.com, 2026-09-11): a 1320px container with 24px side
 * padding; row 1 is 40px tall with 12px above and below; row 2 is 30px tall, and the header is
 * 107px with its bottom rule — the number `HEADER_HEIGHT_PX` (lib/nav.ts) records for what sticks
 * under it on 시장 탐색. Without row 2 it is row 1 and the rule.
 */
export function Nav() {
  // The mobile row already carries the logo and the balance chip, so search collapses to an
  // icon that opens the same form under it — the one search box the app has since ADR-0041. It
  // finds markets only (N02 §2) and works from every route (owner decision 2026-10-13: it stays
  // in the header).
  const [searchOpen, setSearchOpen] = useState(false);
  const pathname = usePathname();

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
              <WithSearchTerm>
                {(term) => <SearchForm testId="nav-search" initialTerm={term} />}
              </WithSearchTerm>
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
            <WithSearchTerm>
              {(term) => (
                <SearchForm
                  testId="nav-search-mobile"
                  initialTerm={term}
                  autoFocus
                  onSubmitted={() => {
                    setSearchOpen(false);
                  }}
                />
              )}
            </WithSearchTerm>
          </Box>
        )}
        {showsCategoryRow(pathname) && <CategoryNav />}
      </Container>
    </Box>
  );
}

/**
 * 시장 탐색 · 커뮤니티 · MY as Kalshi's pill items, md and up (below md the bottom tab bar lists
 * the same areas, PLAN 11.4). The list and which item is current come from lib/nav.ts
 * (`primaryNavItems`, `isPrimaryCurrent`), where they are tested. The current item is
 * `aria-current="page"` as well as the `surface.hover` wash, so it is never signalled by the
 * fill alone (PLAN 11.2).
 *
 * MY joins once the session says someone is signed in (owner decision 2026-10-13). `useSession`
 * holds `isPending` through hydration (lib/use-session.ts), so the server HTML and the hydrating
 * render both list two items and MY appears after them, last, so neither of them moves.
 *
 * `usePathname` is safe in the root layout — it is `useSearchParams` that forces a static page
 * into a Suspense boundary (see `CategoryNav`).
 *
 * `textStyle="overlineLg"` for the weight and tracking Kalshi's items have; its uppercase
 * transform is a no-op on Korean and is left in so the one text style stays one text style.
 */
function PrimaryLinks() {
  const pathname = usePathname();
  const { data: session } = useSession();

  return (
    <HStack as="nav" aria-label={copy.navPrimary} hideBelow="md" gap="1">
      {primaryNavItems(session != null).map((item) => {
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
 * not even be looking at. It searches markets and nothing else — no user search (N02 §2·§3). It
 * is also the ONLY search box since ADR-0041 — the home screen's own form went with the Kalshi
 * layout, and Kalshi has no search within a category either.
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
 * `testId` is required, not defaulted: at <md the desktop form is still mounted behind
 * `display: none`, so while the mobile form is open both are in the DOM and a shared id would
 * make every Playwright selector ambiguous.
 *
 * The field is uncontrolled and KEYED on the term the URL carries (`initialTerm`, read by
 * `WithSearchTerm`), which is the whole of the reconciliation it needs — the same rule the home
 * screen's own box followed before ADR-0041 moved search up here. What is typed before Enter is
 * a draft, so it must survive a navigation the draft itself did not cause — picking a category
 * in row 2, changing the sort — and it must NOT survive one that replaced the term: Back out of
 * a search, or a second search. A `useState` seeded on mount could do neither, because a
 * search-param-only navigation re-renders this header without remounting it. Keying on the term
 * remounts the input exactly when the URL's term changes and leaves it alone otherwise — no
 * effect, and nothing that can fight the typing. Without it, `/?q=rain` opened cold showed an
 * empty box over a filtered list, and Back from a second search kept the newer word in the box
 * over the older list.
 */
function SearchForm({
  testId,
  initialTerm,
  autoFocus = false,
  onSubmitted,
}: {
  testId: string;
  /** The home list's current `q`, or `undefined` off `/` and when there is no search. */
  initialTerm?: string;
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
          key={initialTerm ?? ''}
          name="q"
          type="search"
          size="sm"
          defaultValue={initialTerm ?? ''}
          // `subtle` is the variant with a transparent stroke; the fill is the theme's search
          // ground rather than the variant's `bg.muted`. The stroke stays in the box (at 0 alpha)
          // so the focus ring the variant paints on it still shows.
          variant="subtle"
          h="38px"
          ps="44px"
          borderRadius="pill"
          bg="surface.input"
          // The placeholder is not a label: it disappears on the first keystroke and screen
          // readers are not required to announce it (WCAG 3.3.2). It is still text a visitor
          // reads, so it is `fg.muted` (6.60:1 light / 5.69:1 dark on `surface.input`) rather
          // than Chakra's default placeholder tint, which measures 4.14:1 there.
          _placeholder={{ color: 'fg.muted' }}
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
 * Hands `SearchForm` the term the home list is filtered on. `useSearchParams` in the root layout
 * has to sit behind a Suspense boundary (see `CategoryNav` for the whole argument), and the
 * fallback is the same form with no term: a static page prerenders the box empty, which is
 * right — off `/` there is no term to show (`currentSearchTerm`) — and `/` is dynamic, so its
 * HTML carries the real one. A render prop rather than a hook because the boundary is what
 * makes the read safe, and a hook cannot bring its own boundary.
 */
function WithSearchTerm({ children }: { children: (term: string | undefined) => ReactNode }) {
  return (
    <Suspense fallback={children(undefined)}>
      <SearchTermReader>{children}</SearchTermReader>
    </Suspense>
  );
}

function SearchTermReader({ children }: { children: (term: string | undefined) => ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  return children(currentSearchTerm(pathname, searchParams));
}

/**
 * Row 2 (PLAN 11.4, ADR-0041): 전체 and the top-level categories, on every breakpoint, on
 * 시장 탐색 only (`Nav`).
 *
 * The row has to know the URL's `?category=` to mark the current item, and the URL's view to
 * know where its items go (`categoryLinkQuery`: in the 관심 시장 view they keep it on, owner
 * decision 2026-10-16), and the only honest source for both is `useSearchParams` — the same
 * params the home page normalises. Both routes that draw the row (`/` and `/markets/[slug]`) are
 * `force-dynamic`, so the params are known at request time and the real row goes into the HTML.
 * The read still lives in `CurrentCategoryRow` behind its own `<Suspense>`, with the SAME row,
 * nothing marked current and the links of a URL with no query as the fallback: a
 * `useSearchParams` read in the root layout during a static prerender bails the render out to the
 * nearest Suspense boundary (`next build` fails when there is none), and the boundary keeps a
 * page that draws the row buildable however it is rendered — a prerendered row is the full row
 * (the links, the skeleton, 전체), and when the boundary resolves in the browser it re-renders to
 * an identical one (off `/` nothing is current and the links are the plain ones anyway), so
 * nothing flashes.
 *
 * The categories query and the grouping are read ONCE here and handed to both branches of the
 * boundary, so the fallback and the real row cannot disagree about what they list.
 */
function CategoryNav() {
  const { data: categories, isPending } = useCategories();
  const tree = categories === undefined ? undefined : groupCategories(categories);
  const pathname = usePathname();

  return (
    <Suspense
      fallback={
        <CategoryRow
          tree={tree}
          isPending={isPending}
          linkQuery={(slug) => categoryLinkQuery(pathname, NO_SEARCH_PARAMS, slug)}
        />
      }
    >
      <CurrentCategoryRow tree={tree} isPending={isPending} />
    </Suspense>
  );
}

/** The fallback's URL: no query at all, so no item is current and every link is a plain one. */
const NO_SEARCH_PARAMS: UrlSearchParams = new URLSearchParams();

/**
 * The row with its current item and its links read from the URL; see `CategoryNav` for why it is
 * separate.
 */
function CurrentCategoryRow({ tree, isPending }: { tree?: CategoryNode[]; isPending: boolean }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const category = searchParams.get('category');

  return (
    <CategoryRow
      tree={tree}
      isPending={isPending}
      allCurrent={isAllCategoriesCurrent(pathname, category)}
      currentSlug={currentTopLevelSlug(pathname, tree ?? [], category)}
      linkQuery={(slug) => categoryLinkQuery(pathname, searchParams, slug)}
    />
  );
}

/**
 * The row itself: Kalshi's category strip. Items 16px apart, `emphasisMd`, resting dimmed and
 * lifting to full opacity under the pointer or when current — and the current one also carries
 * `aria-current="page"` (PLAN 11.2). Only the TOP level is listed: a leaf is picked in the home
 * screen's sidebar, and the strip marks the leaf's parent (lib/nav.ts).
 *
 * The resting opacity is `CATEGORY_ITEM_OPACITY` (lib/nav.ts), a notch above Kalshi's 0.5 so
 * the dimmed text still reads at 4.5:1; the number and its measurement live there.
 *
 * A failed `GET /categories` renders the 전체 link alone — a header must not shout about a list
 * it only offers as a shortcut. Where each item goes is `linkQuery` (`categoryLinkQuery`,
 * lib/nav.ts, where it is tested): a fresh `?category=`, or in the 관심 시장 view the view moved to
 * that category. Each href is a UrlObject rather than a template literal: `href` takes one without
 * a `Route` cast, and Next encodes the slug. `prefetch={false}` on each, for the reason the search
 * form gives: the home route is `force-dynamic`.
 *
 * It scrolls sideways with no visible scrollbar (`scrollbarWidth` for Firefox, the
 * `::-webkit-scrollbar` rule for the rest). A scroll container clips its children's outlines,
 * which would cut the keyboard focus ring off the top and the left of the first item; the 4px
 * of padding pulled back with a matching negative margin keeps the row exactly where Kalshi's
 * measurements put it (30px, then 12px below — see `h`) while giving the 2px ring and its 2px
 * offset room.
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
  linkQuery,
}: {
  tree?: CategoryNode[];
  isPending: boolean;
  allCurrent?: boolean;
  currentSlug?: string;
  /** The query an item links to: a top-level slug, or `undefined` for 전체. */
  linkQuery: (slug: string | undefined) => Record<string, string>;
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
      <CategoryLink
        href={{ pathname: '/', query: linkQuery(undefined) }}
        current={allCurrent}
        testId="nav-category-all"
      >
        {copy.marketsAll}
      </CategoryLink>
      {isPending ? (
        <Skeleton height="4" width="48" />
      ) : (
        tree?.map((node) => (
          <CategoryLink
            key={node.category.slug}
            href={{ pathname: '/', query: linkQuery(node.category.slug) }}
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
      opacity={current ? 1 : CATEGORY_ITEM_OPACITY}
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
