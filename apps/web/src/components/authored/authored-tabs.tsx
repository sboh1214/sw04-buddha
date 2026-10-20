'use client';

import { Tabs } from '@chakra-ui/react';
import { useSearchParams } from 'next/navigation';
import { type ReactNode } from 'react';
import {
  AUTHORED_TABS,
  AUTHORED_TAB_PARAM,
  type AuthoredTab,
  authoredTabOf,
  authoredTabSearch,
} from '@/lib/authored';

/**
 * The 글 and 댓글 tabs (#51, ADR-0080; #37-14 and decision 4 #51: «글·댓글 탭»), on a profile and
 * on MY '내 글' alike: ARIA tabs, 글 first and picked unless the address says `?tab=comments`.
 *
 * The tab picked is kept in the address — written with the browser's own `history.replaceState`,
 * which Next folds into its router (`useSearchParams` follows it) without asking the server for
 * the page again — so Back from a post page opened on the 댓글 tab lands on that tab, and no entry
 * is added to the history for a tab switch. A panel mounts the first time its tab is picked
 * (`lazyMount`), so a list is read only once somebody looks at it, and stays mounted after.
 */
export function AuthoredTabs({
  label,
  testId,
  panels,
}: {
  /** The tab list's accessible name, from `copy`. */
  label: string;
  testId: string;
  panels: Record<AuthoredTab, ReactNode>;
}) {
  const searchParams = useSearchParams();
  const tab = authoredTabOf(searchParams.get(AUTHORED_TAB_PARAM));
  const pick = (next: AuthoredTab) => {
    if (next === tab) return;
    const { pathname, search, hash } = window.location;
    window.history.replaceState(null, '', `${pathname}${authoredTabSearch(search, next)}${hash}`);
  };
  return (
    <Tabs.Root
      value={tab}
      onValueChange={(details) => pick(authoredTabOf(details.value))}
      lazyMount
      variant="line"
      data-testid={testId}
    >
      <Tabs.List aria-label={label}>
        {AUTHORED_TABS.map((item) => (
          <Tabs.Trigger key={item.key} value={item.key} data-testid={`${testId}-tab-${item.key}`}>
            {item.label}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      {AUTHORED_TABS.map((item) => (
        <Tabs.Content key={item.key} value={item.key} pt="4">
          {panels[item.key]}
        </Tabs.Content>
      ))}
    </Tabs.Root>
  );
}
