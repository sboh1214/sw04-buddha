'use client';

import { Link as ChakraLink, HStack, Heading, Skeleton, Stack, Text } from '@chakra-ui/react';
import { parseCoinAmount } from '@buddha/shared';
import type { Route } from 'next';
import NextLink from 'next/link';
import { OrderHistoryList } from '@/components/history/order-history-list';
import { SettlementHistoryList } from '@/components/history/settlement-history-list';
import { SanctionBanner, WarningBanner } from '@/components/moderation/sanction-banner';
import { ProfileUnavailable } from '@/components/my/profile-unavailable';
import { AccountBlockLine } from '@/components/position/account-block-line';
import { CoinText } from '@/components/ui/coin-text';
import { copy } from '@/copy';
import { useMe } from '@/hooks/use-me';
import { useMyNotifications } from '@/hooks/use-notifications';
import { useLedger } from '@/hooks/use-wallet';
import { useWatchlist } from '@/hooks/use-watchlist';
import { MY_PREVIEW_ROWS, MY_TABS, MY_WALLET_PATH, type MyTabKey } from '@/lib/my';
import { readFailed } from '@/lib/query-client';
import { profilePath } from '@/lib/profile';
import {
  BalanceSummary,
  LivePendingOrders,
  LoadFailed,
  PositionsBody,
  Section,
  SessionEnded,
  useHoldings,
  useSellAccount,
  useSessionEnded,
} from './portfolio';
import { MyAuthoredPreview } from './posts/my-authored';
import { MyProposalsPreview } from './proposals/my-proposals';
import { NotificationsBody } from './notifications/my-notifications';
import { LedgerRow } from './wallet/ledger-list';
import { StartGrantPendingNotice } from './wallet/start-grant-notice';
import { WatchlistBody } from './watchlist/watchlist';

/**
 * The previews read the tab's unfiltered lists: one cache entry for both (ADR-0143 결정 11-12;
 * the wallet's too, ADR-0144 결정 2-10).
 */
const NO_HISTORY_FILTERS = {};

/** The summary's account restriction banner: the holdings' '매도' point at it (D13, #67). */
const SUMMARY_SANCTION_ID = 'my-sanction-banner';
/** An admin's account line above the holdings' preview (D13, #67). */
const SUMMARY_ACCOUNT_LINE_ID = 'my-preview-positions-account-blocked';

function tab(key: MyTabKey) {
  const found = MY_TABS.find((item) => item.key === key);
  if (found === undefined) throw new Error(`unknown MY tab ${key}`);
  return found;
}

/**
 * `/my`, MY's first screen (owner decision 2026-10-13): 잔고 요약 — the old portfolio's card —
 * and a preview of each tab, the first `MY_PREVIEW_ROWS` rows through the tab's own list body
 * with a 전체 보기 to the tab. 설정 has no rows to preview. The previews run in the tab bar's order
 * (MY_TABS, the owner's): 내 글 — rows since #51 (ADR-0080), the newest three posts and the newest
 * three comments — then 관심 시장 — rows since #89 (ADR-0064), the newest three watches as market
 * cards — then 알림 — rows since #53 (ADR-0157, 53-11 ②), the newest three notifications.
 *
 * 내 제안 (#77, ADR-0089) closes the summary: not a tab (ADR-0069 decision 4 #77 위치), so after
 * the tab bar's previews, its newest proposals with 전체 보기 to `/my/proposals`.
 *
 * The holdings are read once here and handed to every card that shows them, so the summary card
 * and the preview are drawn from one price and one list. 거래·정산 이력's preview keeps its two
 * halves (#124, ADR-0143 결정 11-12): 정산 이력 — the first `MY_PREVIEW_ROWS` settlement records — and
 * 주문 이력 — the first ended orders — each the tab's own list with no filter, under the tab's key,
 * cut on the screen; 체결 has no preview. The holdings'
 * preview is the first `MY_PREVIEW_ROWS` market groups (up to six contract rows, #67, ADR-0142),
 * and only those read their 매도 가능액. D13 says why their '매도' is off where the summary
 * already does: the account restriction's banner above, which the buttons point at; an admin,
 * who has no banner, gets the account line above the preview.
 *
 * Above them, the way to the member's own public profile (`ViewOwnProfileLink`, owner decision
 * 2026-10-21 answer 7), as from MY 설정's 프로필 card — and above that, while a writing or an
 * account restriction stands, its banner (`SanctionBanner`, ADR-0069 decision 4 #50; #185,
 * ADR-0082; #139, ADR-0085 — the account restriction's on MY 요약 and MY 설정 only, owner decision
 * 2026-10-23), and for the appeal window of a warning received, its banner (`WarningBanner`, owner
 * decision 2026-10-21 — the summary only).
 */
export function MySummary() {
  const ended = useSessionEnded();
  const me = useMe();
  const holdings = useHoldings(me.data?.id, MY_PREVIEW_ROWS);
  const block = useSellAccount((account) =>
    account === 'restricted'
      ? SUMMARY_SANCTION_ID
      : account === 'admin'
        ? SUMMARY_ACCOUNT_LINE_ID
        : undefined,
  );
  if (ended) return <SessionEnded />;

  const positions = tab('positions');
  const pending = tab('orders');
  const history = tab('history');
  return (
    <Stack gap="6">
      <SanctionBanner testId="my-sanction-banner" id={SUMMARY_SANCTION_ID} />
      <WarningBanner testId="my-warning-banner" />
      <ViewOwnProfileLink />
      <BalanceSummary holdings={holdings} />
      <Section title={positions.label} testId="my-preview-positions" href={positions.href}>
        {me.data === undefined ? (
          <ProfileUnavailable height="24" />
        ) : (
          <Stack gap="4">
            {/* An admin only: a restriction is the banner's to say (ADR-0142, R14). */}
            {block.account === 'admin' && (
              <AccountBlockLine
                id={SUMMARY_ACCOUNT_LINE_ID}
                account={block.account}
                restrictionEndsAt={null}
                testId="portfolio-account-blocked"
              />
            )}
            <PositionsBody
              holdings={holdings}
              sellAccount={block.sellAccount}
              limit={MY_PREVIEW_ROWS}
            />
          </Stack>
        )}
      </Section>
      <Section title={pending.label} testId="my-preview-orders" href={pending.href}>
        {/* The tab's live list under the same key, its first rows (#123, ADR-0141). */}
        <LivePendingOrders
          accountId={me.data?.id}
          testId="my-preview-orders"
          limit={MY_PREVIEW_ROWS}
        />
      </Section>
      <Section title={history.label} testId="my-preview-history" href={history.href}>
        <Stack gap="5">
          <Stack gap="3">
            <Heading as="h4" size="sm">
              {copy.portfolioSettled}
            </Heading>
            {me.data === undefined ? (
              <ProfileUnavailable height="24" />
            ) : (
              <SettlementHistoryList
                key={me.data.id}
                accountId={me.data.id}
                filters={NO_HISTORY_FILTERS}
                limit={MY_PREVIEW_ROWS}
                testId="my-preview-settlements"
              />
            )}
          </Stack>
          <Stack gap="3">
            <Heading as="h4" size="sm">
              {copy.portfolioOrders}
            </Heading>
            {me.data === undefined ? (
              <ProfileUnavailable height="24" />
            ) : (
              <OrderHistoryList
                key={me.data.id}
                accountId={me.data.id}
                filters={NO_HISTORY_FILTERS}
                limit={MY_PREVIEW_ROWS}
                testId="my-preview-order-history"
              />
            )}
          </Stack>
        </Stack>
      </Section>
      <WalletPreview />
      <PostsPreview />
      <WatchlistPreview />
      <NotificationsPreview />
      {/* 내 제안 (#77, ADR-0089): a MY sub-page, not a tab — linked from here (ADR-0069 decision
          4 #77 위치), after the tabs' previews since it is none of them. */}
      <MyProposalsPreview limit={MY_PREVIEW_ROWS} />
    </Stack>
  );
}

/**
 * '내 공개 프로필 보기' (#41, ADR-0078; owner decision 2026-10-21 answer 7: «MY 설정 + MY 요약»): the
 * page everyone sees of the account at `/u/<publicId>`, the same link as MY 설정's 프로필 card.
 * Drawn once `GET /me` has answered with the public id; nothing while it is read or when it failed
 * — 잔고 요약 below reports that failure, once.
 */
function ViewOwnProfileLink() {
  const { data: me } = useMe();
  if (!me) return null;
  return (
    <ChakraLink asChild alignSelf="flex-start" textStyle="bodySm" color="brand.fg">
      <NextLink href={profilePath(me.profile.publicId) as Route} data-testid="my-view-profile">
        {copy.viewOwnProfile}
      </NextLink>
    </ChakraLink>
  );
}

/**
 * 알림's preview (#53, ADR-0157; owner answer 53-11 ②): the tab's own body with its newest
 * `MY_PREVIEW_ROWS` notifications and the tab's 전체 보기 for the rest — no '모두 읽음' here, which
 * is the tab's. Pressing a row marks it read and opens it, as on the tab. Under the tab's key
 * (`notificationListKey`), so the two share one read. Its own component so its query lives only as
 * long as the summary does.
 */
function NotificationsPreview() {
  const accountId = useMe().data?.id;
  const notifications = useMyNotifications(accountId);
  const notificationsTab = tab('notifications');
  return (
    <Section
      title={notificationsTab.label}
      testId="my-preview-notifications"
      href={notificationsTab.href}
    >
      {accountId === undefined ? (
        <ProfileUnavailable height="24" />
      ) : (
        <NotificationsBody
          key={accountId}
          notifications={notifications}
          accountId={accountId}
          limit={MY_PREVIEW_ROWS}
          testId="my-preview-notifications"
        />
      )}
    </Section>
  );
}

/**
 * 내 글's preview (#51, ADR-0080): the tab's own two bodies with their first `MY_PREVIEW_ROWS` rows
 * each, and the tab's 전체 보기 for the rest. Its own component so its queries live only as long as
 * the summary does.
 */
function PostsPreview() {
  const postsTab = tab('posts');
  return (
    <Section title={postsTab.label} testId="my-preview-posts" href={postsTab.href}>
      <MyAuthoredPreview limit={MY_PREVIEW_ROWS} />
    </Section>
  );
}

/**
 * 관심 시장's preview (#89): the tab's own body with its first `MY_PREVIEW_ROWS` cards, and the
 * tab's 전체 보기 for the rest. Its own component so its query and its room joins live only as
 * long as the summary does.
 */
function WatchlistPreview() {
  const watchlist = useWatchlist();
  const watchlistTab = tab('watchlist');
  return (
    <Section title={watchlistTab.label} testId="my-preview-watchlist" href={watchlistTab.href}>
      <WatchlistBody watchlist={watchlist} limit={MY_PREVIEW_ROWS} />
    </Section>
  );
}

/**
 * 지갑's preview: the balance as the wallet's own card states it — with the wallet's notice while
 * the start Coin waits for its amount (`StartGrantPendingNotice`, owner decision 2026-10-18) — and
 * the newest ledger rows. A failed `GET /me` leaves the balance here a dash, and no notice.
 *
 * The rows are the wallet tab's own query (`useLedger`) — its unfiltered entry for the account
 * `GET /me` names (#69, ADR-0144 결정 2-10), so it reads once that account is known, and until then
 * the rows wait as #124's previews above do (`ProfileUnavailable`: a skeleton, then the profile's
 * error and its retry — a disabled query would otherwise stay pending) — drawn in the preview's
 * shape (`LedgerRow variant="preview"`: no total, no links, no reason). Its failure rung is
 * `readFailed`, not `isError`: a 더 보기 that failed on the wallet tab leaves that query in `error`
 * with its pages kept, and on `isError` this preview — which has no 더 보기 — swapped its rows for
 * an error on the way back, and through the refetch that follows (ADR-0075 5-18).
 */
function WalletPreview() {
  const me = useMe();
  const ledger = useLedger(NO_HISTORY_FILTERS, me.data?.id);
  const entries = (ledger.data?.pages[0]?.items ?? []).slice(0, MY_PREVIEW_ROWS);

  return (
    <Section title={copy.myWallet} testId="my-preview-wallet" href={MY_WALLET_PATH}>
      <Stack gap="4">
        {me.isPending ? (
          <Skeleton height="6" />
        ) : (
          <HStack gap="4" flexWrap="wrap" fontSize="sm">
            <HStack gap="2">
              <Text color="fg.muted">{copy.walletBalance}</Text>
              {me.data ? (
                <CoinText
                  fontWeight="semibold"
                  amount={parseCoinAmount(me.data.balance.availableCoin)}
                  data-testid="my-preview-wallet-available"
                />
              ) : (
                <Text>—</Text>
              )}
            </HStack>
            <HStack gap="2" color="fg.muted">
              <Text>{copy.walletLocked}</Text>
              {me.data ? (
                <CoinText amount={parseCoinAmount(me.data.balance.lockedCoin)} />
              ) : (
                <Text>—</Text>
              )}
            </HStack>
          </HStack>
        )}
        <StartGrantPendingNotice
          me={me.data}
          size="sm"
          testId="my-preview-wallet-start-grant-pending"
        />
        <Stack gap="3">
          <Heading as="h4" size="sm">
            {copy.ledgerTitle}
          </Heading>
          {me.data === undefined ? (
            <ProfileUnavailable height="24" />
          ) : ledger.isPending ? (
            <Skeleton height="24" />
          ) : readFailed(ledger) ? (
            <LoadFailed message={copy.errUnknown} onRetry={() => void ledger.refetch()} />
          ) : entries.length === 0 ? (
            <Text color="fg.muted">{copy.ledgerEmpty}</Text>
          ) : (
            <Stack as="ul" listStyleType="none" m="0" p="0" gap="3" divideY="1px">
              {entries.map((entry) => (
                <LedgerRow key={entry.id} entry={entry} variant="preview" />
              ))}
            </Stack>
          )}
        </Stack>
      </Stack>
    </Section>
  );
}
