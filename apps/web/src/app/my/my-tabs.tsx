'use client';

import { HStack, Link as ChakraLink } from '@chakra-ui/react';
import NextLink from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { copy } from '@/copy';
import { MY_TABS, isMyTabCurrent } from '@/lib/my';

/**
 * MY's tab bar (#16): the eight tabs on every breakpoint, as the header's pill items are drawn
 * (nav.tsx `PrimaryLinks`) — the current one is `aria-current="page"` as well as the
 * `surface.hover` wash, never the fill alone (PLAN 11.2); which one is current is
 * `isMyTabCurrent` (lib/my.ts), where it is tested.
 *
 * It scrolls sideways where the eight do not fit, with no visible scrollbar, and the 4px of
 * padding pulled back with a matching negative margin gives the focus ring room inside the
 * scroll container the way the header's category row does. On a phone the later tabs start out
 * of view, so the current one is scrolled into the strip whenever the page changes.
 */
export function MyTabs() {
  const pathname = usePathname();
  const navRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // `nearest` on both axes: the strip moves sideways only as far as it must, and the page
    // itself does not move when the strip is already on screen.
    navRef.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [pathname]);

  return (
    <HStack
      ref={navRef}
      as="nav"
      aria-label={copy.myMenu}
      gap="1"
      p="1"
      m="-1"
      overflowX="auto"
      scrollbarWidth="none"
      css={{ '&::-webkit-scrollbar': { display: 'none' } }}
      data-testid="my-tabs"
    >
      {MY_TABS.map((tab) => {
        const current = isMyTabCurrent(pathname, tab.href);
        return (
          <ChakraLink
            key={tab.key}
            asChild
            h="36px"
            px="4"
            flexShrink="0"
            whiteSpace="nowrap"
            borderRadius="pill"
            textStyle="emphasisMd"
            color={current ? 'fg' : 'fg.muted'}
            textDecoration="none"
            bg={current ? 'surface.hover' : undefined}
            _hover={{ bg: 'surface.hover', color: 'fg', textDecoration: 'none' }}
            data-testid={`my-tab-${tab.key}`}
          >
            <NextLink href={tab.href} aria-current={current ? 'page' : undefined}>
              {tab.label}
            </NextLink>
          </ChakraLink>
        );
      })}
    </HStack>
  );
}
