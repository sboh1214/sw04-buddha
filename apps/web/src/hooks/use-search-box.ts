'use client';

import { useEffect, useState } from 'react';
import { type SearchBoxOwner, searchBoxOwner } from '@/lib/market-search';

/**
 * The last account a search box has seen known in this tab (`useSearchBoxTurn`): where a box
 * drawn while nobody is known starts from. Module state lives as long as the tab, as the browser
 * QueryClient does (lib/query-client.ts); only an effect writes it, so the server — where effects
 * never run — always reads `undefined`, and so does a box drawn on a tab's first load.
 */
let lastKnownInTab: string | undefined;

/**
 * The turn of a search box drawn for `accountId` (the `Me` on screen, `useMe().data?.id`), which
 * keys its field (`searchBoxKey`, ADR-0091, owner decision 2026-10-26 «첫 답 전에 친 글자는
 * 남김»): it stays through `GET /me`'s first answer — a term typed before it is kept, and is the
 * tab's first account's — and moves on whenever the account known turns into another, so a draft
 * typed for A is gone before B's screen is drawn (`searchBoxOwner`).
 *
 * Tab-wide, not the box's alone: a box drawn while nobody is known — the search screen opened
 * between SessionCacheGuard's reset and B's `GET /me`, the header's mobile form opened then —
 * starts as the last account the tab knew, so B's answer clears what was typed in it as it does
 * in the header's box, which has been drawn since the tab opened. Only the tab's first account is
 * ever 'the first answer'.
 *
 * The owner is adjusted during render, React's way of keeping state in step with a value (the
 * admin screens' `useHeldForOperator`): the render that draws B's `Me` draws the box again in
 * the same commit, so its submit — which records for B — never meets A's draft, not even for one
 * frame.
 */
export function useSearchBoxTurn(accountId: string | undefined): number {
  const [owner, setOwner] = useState<SearchBoxOwner>(() => ({
    accountId: lastKnownInTab,
    turn: 0,
  }));
  const current = searchBoxOwner(owner, accountId);
  if (current !== owner) setOwner(current);
  useEffect(() => {
    if (accountId !== undefined) lastKnownInTab = accountId;
  }, [accountId]);
  return current.turn;
}
