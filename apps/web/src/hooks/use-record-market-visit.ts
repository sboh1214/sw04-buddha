'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { useMe } from '@/hooks/use-me';
import { ApiError, type Me, type RecordMarketVisitBody, api, isForAnotherAccount } from '@/lib/api';
import { needsOnboarding } from '@/lib/onboarding';
import { useSession } from '@/lib/use-session';

/**
 * 방문 기록 (#151, ADR-0170; owner answers 151-3, 151-4, ADR-0167 결정 6): the market detail tells
 * the API, once per open, that the signed-in member opened it — `POST /me/market-visits`, the
 * market in the body. The server keeps one row per account, market and Korean date and decides
 * who is not recorded (an admin by the grant records, an operating account — 151-3, 96-10); the
 * client filters no role and remembers no date (a "sent today" note would read the browser's
 * clock and could skip a real next-day open near midnight).
 *
 * Sent from the browser, never from the server render or a GET: the detail's server render
 * carries no cookie by design, and its background re-reads (focus, the baseline timer, the
 * settlement poll, socket restarts) would fake later opens (RFC 9110, ADR-0169 결정 9).
 */

/**
 * The body of one open's record, or undefined when nothing is sent: no signed-in account, `GET
 * /me` not answered yet (the gate renders the page on a hard load until it has — never send on a
 * guess), or an account the onboarding gate sends away from this page (`needsOnboarding`, the
 * gate's own predicate: a page the gate replaces is not an open, and the route would refuse it
 * as ONBOARDING_REQUIRED — 151-4's basis is the notice the consent step carries). The account
 * named is the `Me` the screen was drawn from, never the session's (ADR-0091), as every write's
 * `expectedAccountId` is.
 */
export function marketVisitToRecord({
  isLoggedIn,
  me,
  pathname,
  marketId,
}: {
  isLoggedIn: boolean;
  me: Me | undefined;
  pathname: string;
  marketId: string;
}): RecordMarketVisitBody | undefined {
  if (!isLoggedIn || me === undefined) return undefined;
  if (needsOnboarding(pathname, me.onboarding)) return undefined;
  return { expectedAccountId: me.id, marketId };
}

/** What one open is told apart by: the account on screen and the market. */
export function marketVisitKey(body: RecordMarketVisitBody): string {
  return `${body.expectedAccountId} ${body.marketId}`;
}

/**
 * What an effect run of one mount sends: the body when there is an account to name
 * (`marketVisitToRecord`) and this mount has not sent for that account and market yet
 * (`sentKey`, the last key it sent), else undefined. A key that comes back after another (A,
 * then B, then A in the same mount) is a new open and is sent again.
 */
export function marketVisitToSend(
  sentKey: string | undefined,
  accountId: string | undefined,
  marketId: string,
): RecordMarketVisitBody | undefined {
  if (accountId === undefined) return undefined;
  const body: RecordMarketVisitBody = { expectedAccountId: accountId, marketId };
  return marketVisitKey(body) === sentKey ? undefined : body;
}

/**
 * `POST /api/v1/me/market-visits`. The answer is 204 with no body, so the result is read off the
 * status rather than `unwrap` (which takes a missing body for a failure): a refusal is thrown as
 * the ApiError every other write throws, so another account's is told apart.
 */
async function postVisit(body: RecordMarketVisitBody): Promise<void> {
  const result = await api.POST('/api/v1/me/market-visits', { body });
  if (!result.response.ok) throw new ApiError(result.response.status, result.error?.error);
}

/**
 * Sends one open's record. Never thrown and never retried, nothing on screen: the page is the
 * member's whatever the record does — a 401, ONBOARDING_REQUIRED, a 404 (the market left public
 * view), a 429 or the network failing is a missing row in a service-wide count, not a failed
 * page. A refusal as another account (another tab signed in as somebody else: the stale `me.id`
 * got 403 and no row was written for either account) asks for the session again
 * (`onSessionChanged`), so SessionCacheGuard puts the real account on screen — the
 * `recordSearch` precedent (ADR-0066).
 */
export async function recordMarketVisit(
  body: RecordMarketVisitBody,
  onSessionChanged: () => void,
  post: (body: RecordMarketVisitBody) => Promise<unknown> = postVisit,
): Promise<void> {
  try {
    await post(body);
  } catch (error) {
    if (isForAnotherAccount(error)) onSessionChanged();
  }
}

/**
 * Records the open of `marketId`'s detail for the signed-in member: once per mount and key
 * (account on screen, market), from an effect — so never during the server render or a Next
 * prefetch, where effects do not run. A re-render, a refetch of the market, `/me` or the session,
 * a focus, a socket event, a hash change (`#judging-record`) or `router.refresh` keeps the key
 * and sends nothing; a new mount (Back, a notification link, MY 이력's `#judging-record`, a
 * related market, a reload) or another market in the same mount is a new open. React StrictMode's
 * second effect run in development finds the key already sent (the ref survives it); the
 * server's primary key would merge it anyway (95-4).
 *
 * Called by `MarketDetail` alone (결정 6 "시장 상세만"): not the dispute screen, MY 이력, the
 * notification list or holdings (use-record-market-visit.test.ts pins the one importer).
 */
export function useRecordMarketVisit(marketId: string): void {
  const pathname = usePathname();
  const { data: me, isLoggedIn } = useMe();
  const { refetch } = useSession();
  // The account to name, or undefined while nothing is sent: a new `Me` object (a refetch of
  // `/me`) with the same id is not a new open, so the effect depends on the id alone.
  const accountId = marketVisitToRecord({ isLoggedIn, me, pathname, marketId })?.expectedAccountId;
  const sentRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    // Nothing when this mount already sent for this account and market: a new `refetch`, or
    // StrictMode's second run, is not a new open.
    const body = marketVisitToSend(sentRef.current, accountId, marketId);
    if (body === undefined) return;
    sentRef.current = marketVisitKey(body);
    void recordMarketVisit(body, () => void refetch());
  }, [accountId, marketId, refetch]);
}
