import { HStack, Tag } from '@chakra-ui/react';
import type { Route } from 'next';
import NextLink from 'next/link';
import { copy } from '@/copy';
import { tagSearchPath } from '@/lib/market-search';

/**
 * The market's tags (#17, ADR-0093 decision 2 #172 item 2): one line at the end of 요약, before the
 * theme links, a '#이름' chip per tag in the order the operator entered them, each a link to that
 * tag's search (`tagSearchPath`: `/search?q=이름`, every public status). The '#' is drawn here and
 * never stored. Nothing at all for a market without tags — only a draft has none, and a draft has
 * no public detail.
 *
 * The same place and form as the theme links (market-themes.tsx, ADR-0088): the market's own facts
 * stay where ADR-0067 put them, and the ways out to other lists sit under them. No label beside
 * the chips — the '#' says what they are; the list is named for a screen reader instead. Cards
 * carry no tags (#172 item 2), so this is the one place a reader meets them.
 *
 * `prefetch={false}`: `/search` is force-dynamic, and a prefetch would be a whole search rendered
 * for a chip that may never be pressed (the rule every link into `/` and `/search` follows). The
 * search opened by its address is not recorded in the reader's recent searches (ADR-0066).
 */
export function MarketTags({ tags }: { tags: readonly string[] }) {
  if (tags.length === 0) return null;
  return (
    <HStack
      as="ul"
      listStyleType="none"
      gap="2"
      flexWrap="wrap"
      aria-label={copy.marketTags}
      data-testid="market-tags"
    >
      {tags.map((name, index) => (
        <li key={name}>
          <Tag.Root size="md" variant="subtle" maxW="full" asChild>
            <NextLink
              href={tagSearchPath(name) as Route}
              prefetch={false}
              data-testid={`market-tag-${String(index)}`}
            >
              <Tag.Label>{`#${name}`}</Tag.Label>
            </NextLink>
          </Tag.Root>
        </li>
      ))}
    </HStack>
  );
}
