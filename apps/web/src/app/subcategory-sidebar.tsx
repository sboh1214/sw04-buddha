'use client';

import { Box, HStack, Skeleton, Stack, Text } from '@chakra-ui/react';
import NextLink from 'next/link';
import { CategoryIcon } from '@/components/market/category-icon';
import { copy } from '@/copy';
import { useCategories } from '@/hooks/use-markets';
import { type Category } from '@/lib/api';
import { groupCategories } from '@/lib/category-tree';
import { type SidebarLink, sidebarLinks } from '@/lib/home-view';
import { type HomeFilters } from '@/lib/market-keys';
import { HEADER_HEIGHT_PX } from '@/lib/nav';

/**
 * The sub-category sidebar (ADR-0041, Kalshi's category page): 전체 시장 and then the leaves of the
 * top-level category the URL names, 180px wide, stuck under the header on md and up. Nothing at
 * all when no category is selected — the header's row-2 nav is where a visitor picks one, and a
 * column of every leaf of every category would be the header again, vertically.
 *
 * The rows come from `sidebarLinks` (lib/home-view.ts), which is where the decisions live and
 * are tested: which slug the 전체 시장 row points at, which row is current, and that the sort and
 * the 관심 시장 view ride along on every row. This file only draws them.
 *
 * The categories arrive twice, exactly as in market-filters.tsx: as the server-read PROP, which
 * is what puts the sidebar in the first paint, and from `useCategories()` afterwards, which is
 * what keeps it fresh. It has to be a prop and not the `['categories']` cache entry, because `Nav`
 * renders above this page and builds that query first, which makes react-query defer its
 * hydration to an effect that never runs on the server (see app/page.tsx).
 *
 * Below md the same rows are a horizontally scrolling chip row over the grid instead
 * (`SubcategoryChips`, rendered by market-filters.tsx where the rows are already derived for the
 * headline). Two components rather than one responsive one because they sit in different places
 * in the page: the sidebar is a column BESIDE the list, the chips a row INSIDE its column.
 */

export interface SubcategorySidebarProps {
  /** Normalised once on the server; the current row is read from here. */
  filters: HomeFilters;
  /** Read by the server component for the first paint; absent if that read failed. */
  categories?: Category[];
}

/** Three placeholders of a row's height: enough to hold the column's width while it loads. */
const SKELETON_ROWS = [0, 1, 2];

export function SubcategorySidebar({ filters, categories: seeded }: SubcategorySidebarProps) {
  const categories = useCategories();
  // The query wins once it has an answer, so a client-side refresh moves the rows; until then
  // the server's own read stands, which is why there is no skeleton on a served page.
  const items = categories.data ?? seeded;
  const links = sidebarLinks(groupCategories(items ?? []), filters);

  if (filters.category === undefined) return null;
  // The skeleton is only for a render that has neither source yet — a client-side navigation
  // onto `/?category=…` before the query has answered. A slug the tree turns out not to know
  // (a retired category) renders nothing: there is no parent to list under.
  if (links.length === 0 && !(items === undefined && categories.isPending)) return null;

  return (
    <Box
      as="nav"
      aria-label={copy.marketSubcategories}
      // Sticky under the two-row header: its desktop height (`HEADER_HEIGHT_PX`, measured off
      // kalshi.com and built to that in nav.tsx) plus the page's own `pt="6"`, so the column's
      // top edge stays where it was laid out. `alignSelf` keeps the flex item from stretching to
      // the list's height, without which `position: sticky` has nothing to slide within.
      w="180px"
      flexShrink="0"
      position="sticky"
      top={`calc(${String(HEADER_HEIGHT_PX)}px + 24px)`}
      alignSelf="flex-start"
      hideBelow="md"
      data-testid="market-subcategories"
    >
      {links.length === 0 ? (
        <Stack gap="0">
          {SKELETON_ROWS.map((row) => (
            <Skeleton key={row} height="40px" borderRadius="row" />
          ))}
        </Stack>
      ) : (
        <Stack as="ul" gap="0" listStyleType="none" m="0" p="0">
          {links.map((link) => (
            <Box as="li" key={link.testId}>
              <SidebarRow link={link} />
            </Box>
          ))}
        </Stack>
      )}
    </Box>
  );
}

/**
 * One row: a real link (middle-click, Back and a pasted URL all keep working) styled as Kalshi's
 * sidebar item — 40px tall, an 8px radius, the 3% wash on hover, the 20px category glyph and the
 * name. The current row is `brand.fg` AND `aria-current="page"` (PLAN 11.2); the rest stay `fg`.
 *
 * `prefetch={false}`: every row points at this same force-dynamic route, so leaving the default
 * on would ask the server to render a whole filtered list for each row on the screen.
 */
function SidebarRow({ link }: { link: SidebarLink }) {
  return (
    <Box
      asChild
      display="flex"
      alignItems="center"
      gap="2"
      h="40px"
      px="3"
      borderRadius="row"
      textStyle="bodySm"
      color={link.active ? 'brand.fg' : 'fg'}
      _hover={{ bg: 'surface.hover' }}
      focusVisibleRing="outside"
    >
      <NextLink
        href={{ pathname: '/', query: link.query }}
        prefetch={false}
        aria-current={link.active ? 'page' : undefined}
        data-testid={link.testId}
      >
        <CategoryIcon slug={link.iconSlug} size={20} />
        <Text as="span" truncate>
          {link.label}
        </Text>
      </NextLink>
    </Box>
  );
}

/**
 * The same rows below md: a pill per row in a horizontally scrolling strip with no visible
 * scrollbar (the same treatment as the header's row 2), rendered above the grid by
 * market-filters.tsx inside its own `hideFrom="md"` box. Presentational — the caller hands it
 * the rows it already derived, so the two twins cannot disagree about which one is current.
 *
 * The test ids carry a `-mobile` suffix, as the header's search forms do (`nav-search` /
 * `nav-search-mobile`): the sidebar is still in the DOM behind `display: none` on a phone, so
 * a shared id would resolve to two elements and make every Playwright selector ambiguous.
 */
export function SubcategoryChips({ links }: { links: readonly SidebarLink[] }) {
  return (
    <Box
      as="nav"
      aria-label={copy.marketSubcategories}
      overflowX="auto"
      scrollbarWidth="none"
      css={{ '&::-webkit-scrollbar': { display: 'none' } }}
      // A scroll container clips its children's outlines: 4px of padding, pulled back with
      // matching negative margins so the strip does not move, gives a chip's 2px focus ring and
      // its 2px offset room on every side (the same trick the header's category row uses).
      p="1"
      m="-1"
      data-testid="market-subcategories-mobile"
    >
      <HStack gap="2" minW="max-content">
        {links.map((link) => (
          <Box
            key={link.testId}
            asChild
            display="inline-flex"
            alignItems="center"
            h="8"
            px="3"
            flexShrink="0"
            borderRadius="pill"
            borderWidth="1px"
            borderColor="border.emphasized"
            textStyle="emphasisSm"
            whiteSpace="nowrap"
            color={link.active ? 'brand.fg' : 'fg'}
            bg={link.active ? 'surface.hover' : 'transparent'}
            _hover={{ bg: 'surface.hover' }}
            focusVisibleRing="outside"
          >
            <NextLink
              href={{ pathname: '/', query: link.query }}
              prefetch={false}
              aria-current={link.active ? 'page' : undefined}
              data-testid={`${link.testId}-mobile`}
            >
              {link.label}
            </NextLink>
          </Box>
        ))}
      </HStack>
    </Box>
  );
}
