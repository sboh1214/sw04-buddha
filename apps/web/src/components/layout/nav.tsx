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
import Form from 'next/form';
import NextLink from 'next/link';
import { useState } from 'react';
import { AuthButtons } from '@/components/auth/auth-buttons';
import { ColorModeButton } from '@/components/ui/color-mode';
import { copy } from '@/copy';
import { useCategories } from '@/hooks/use-markets';

/**
 * Top navigation (PLAN 11.4): 로고 · 검색 · 카테고리 · 잔고 칩 · 프로필 메뉴. The balance chip and
 * the profile menu are `AuthButtons`, unchanged since M1 — the chip is what AC 3 watches after a
 * trade, and it stays live because `use-trade` writes `['me']` from the trade answer and the
 * socket's `user:balance` writes it again.
 *
 * The whole header is a client component now: the search box holds the open/closed state of its
 * mobile form and the category row reads `useCategories()`. It still renders into the server HTML
 * like every other client component, so nothing about the SSR first paint changes.
 */
export function Nav() {
  // The mobile row already carries the logo, the balance chip and the profile menu, so search
  // collapses to an icon that opens the same form under it. It deliberately does not reach into
  // the home screen's own search box: that box lives in a file this component does not own, and a
  // header whose search only works on `/` would be worse than one that works everywhere.
  const [searchOpen, setSearchOpen] = useState(false);

  return (
    <Box as="header" borderBottomWidth="1px" bg="bg" position="sticky" top="0" zIndex="sticky">
      <Container maxW="6xl" py="3">
        <HStack justify="space-between" gap="3">
          <Heading as="h1" size="lg" letterSpacing="tight">
            <NextLink href="/">{copy.appName}</NextLink>
          </Heading>
          <Box hideBelow="md" flex="1" maxW="sm">
            <SearchForm testId="nav-search" />
          </Box>
          <HStack gap="2">
            <IconButton
              hideFrom="md"
              variant="ghost"
              size="sm"
              aria-label={copy.searchLabel}
              aria-expanded={searchOpen}
              data-testid="nav-search-toggle"
              onClick={() => {
                setSearchOpen((open) => !open);
              }}
            >
              <SearchIcon />
            </IconButton>
            <ColorModeButton display={{ base: 'none', md: 'inline-flex' }} />
            <AuthButtons />
          </HStack>
        </HStack>
        {searchOpen && (
          <Box hideFrom="md" pt="3">
            <SearchForm
              testId="nav-search-mobile"
              autoFocus
              onSubmitted={() => {
                setSearchOpen(false);
              }}
            />
          </Box>
        )}
        <CategoryLinks />
      </Container>
    </Box>
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
 * not even be looking at. Narrowing a category or a sort is the home screen's own search box.
 *
 * `prefetch={false}`: this header is on every route, and the home page is `force-dynamic`, so the
 * default action prefetch would ask the server for it from every page the visitor opens.
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
        endElement={
          <IconButton type="submit" variant="ghost" size="xs" aria-label={copy.searchSubmit}>
            <SearchIcon />
          </IconButton>
        }
      >
        <Input
          name="q"
          type="search"
          size="sm"
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
 * The category shortcut row (PLAN 11.4), md and up.
 *
 * `useSearchParams` is deliberately NOT read to mark the active category: this header renders on
 * every route from the root layout, and a `useSearchParams` there forces every statically
 * prerendered page (`/login`, `/signup`, …) into a Suspense boundary or fails `next build`. The
 * current filter is shown by the home screen's own tab row, which owns the URL.
 *
 * A failed `GET /categories` renders the 전체 link alone — a header must not shout about a list it
 * only offers as a shortcut. Each href is a UrlObject rather than a template literal: `href` takes
 * one without a `Route` cast, and Next encodes the slug.
 *
 * Labelled 시장, not 카테고리: the home screen's own tab row is the navigation landmark named
 * 카테고리, and two landmarks with one name tell a screen-reader user nothing about which is which.
 */
function CategoryLinks() {
  const { data: categories, isPending } = useCategories();

  return (
    <HStack
      as="nav"
      aria-label={copy.navMarkets}
      hideBelow="md"
      gap="4"
      pt="2"
      overflowX="auto"
      data-testid="nav-categories"
    >
      <ChakraLink
        asChild
        fontSize="sm"
        color="fg.muted"
        whiteSpace="nowrap"
        _hover={{ color: 'fg' }}
        data-testid="nav-category-all"
      >
        <NextLink href="/">{copy.marketsAll}</NextLink>
      </ChakraLink>
      {isPending ? (
        <Skeleton height="4" width="48" />
      ) : (
        categories?.map((category) => (
          <ChakraLink
            key={category.slug}
            asChild
            fontSize="sm"
            color="fg.muted"
            whiteSpace="nowrap"
            _hover={{ color: 'fg' }}
            data-testid={`nav-category-${category.slug}`}
          >
            <NextLink href={{ pathname: '/', query: { category: category.slug } }}>
              {category.nameKo}
            </NextLink>
          </ChakraLink>
        ))
      )}
    </HStack>
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
