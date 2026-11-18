'use client';

import {
  Alert,
  Box,
  Button,
  Card,
  Grid,
  HStack,
  Link as ChakraLink,
  Skeleton,
  Stack,
  Text,
} from '@chakra-ui/react';
import { MINUS_SIGN, formatCoin, parseCoinAmount } from '@buddha/shared';
import type { Route } from 'next';
import NextLink from 'next/link';
import { Fragment, type ReactNode } from 'react';
import { HistoryMarketLink, OnlyMarketLink } from '@/components/history/history-parts';
import { ProfileUnavailable } from '@/components/my/profile-unavailable';
import { useFormatDateTime } from '@/components/time-zone/time-zone-provider';
import { LoadMoreFailed } from '@/components/ui/load-more-failed';
import { copy } from '@/copy';
import { useMe } from '@/hooks/use-me';
import { useLedger } from '@/hooks/use-wallet';
import { useWalletLockWatch } from '@/hooks/use-wallet-lock-watch';
import { type LedgerEntry } from '@/lib/api';
import { myOrderPath } from '@/lib/my';
import { myHistoryPath } from '@/lib/my-history';
import { listSection } from '@/lib/query-client';
import {
  LEDGER_KIND_LABEL,
  type WalletFilters as WalletFiltersValue,
  ledgerBalanceNote,
  ledgerEmptyText,
  onlyMarketPath,
  showsCorrectionNote,
  walletListFilters,
} from '@/lib/wallet';
import { useSessionEnded } from '../portfolio';
import { WalletFilters } from './wallet-filters';

/**
 * 지갑's 이용 내역 (#69, ADR-0144): the account's own Coin ledger, one line per ledger row (ADR-0135
 * H3), newest first, under its filter line (유형 → 기간 → 시장, `WalletFilters`). The filters are
 * the address the server page normalised (`filters`); the rows are read in the browser with the
 * account's cookie — never on the server — keyed by the account `GET /me` names and waiting for it
 * (`ProfileUnavailable`), as #124's lists.
 *
 * The section also keeps 주문 잠금 코인 up with the account's live buys (`useWalletLockWatch`): the
 * balance card above reads the same `['me']`.
 *
 * A session that ends under the mounted page (another tab signed out, expiry) takes the section
 * away (`useSessionEnded`, MY's ladder): `['me']` is reset and never read again, so waiting for it
 * would be a skeleton with no end. The balance card above draws the page's one signed-out rung
 * with the way back to the login.
 */
export function LedgerSection({
  filters,
  marketTitle,
}: {
  filters: WalletFiltersValue;
  /** The title of the market `filters.market` names, read on the server; absent if it failed. */
  marketTitle?: string;
}) {
  const accountId = useMe().data?.id;
  useWalletLockWatch(accountId);
  const ended = useSessionEnded();
  if (ended) return null;
  return (
    <Card.Root data-testid="ledger-list">
      <Card.Header>
        <Stack gap="3" minW="0">
          <Text fontWeight="semibold">{copy.ledgerTitle}</Text>
          <WalletFilters filters={filters} marketTitle={marketTitle} />
        </Stack>
      </Card.Header>
      <Card.Body>
        {accountId === undefined ? (
          <ProfileUnavailable height="24" />
        ) : (
          <LedgerList key={accountId} accountId={accountId} filters={filters} />
        )}
      </Card.Body>
    </Card.Root>
  );
}

/**
 * The rows the filters leave, with the rungs #124's lists have (`listSection`): a refresh that
 * failed keeps the rows and says so above them; an empty list says whether nothing exists or
 * nothing matched. Over the rows, what '반영 후 코인 합계' is, and — while a filter is on — that the
 * figures no longer follow from one row to the next (ADR-0144 결정 2-6). 'Coin 보정' filtered says
 * where the corrections with no ledger row are (결정 2-8).
 */
export function LedgerList({
  accountId,
  filters,
}: {
  accountId: string;
  filters: WalletFiltersValue;
}) {
  const listFilters = walletListFilters(filters);
  const list = useLedger(listFilters, accountId);
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, refetch } = list;
  const entries = data?.pages.flatMap((page) => page.items) ?? [];
  const section = listSection(list, entries.length);

  return (
    <Stack gap="3">
      {section.stale && (
        <Alert.Root status="warning" role="status" data-testid="ledger-stale">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{copy.marketRefreshFailed}</Alert.Description>
          </Alert.Content>
          <Button size="xs" variant="outline" ml="auto" onClick={() => void refetch()}>
            {copy.retry}
          </Button>
        </Alert.Root>
      )}
      {showsCorrectionNote(listFilters) && (
        <Text fontSize="sm" color="fg.muted" data-testid="ledger-correction-note">
          {copy.ledgerCorrectionFilterNote}
        </Text>
      )}
      {section.body === 'pending' ? (
        <Skeleton height="24" />
      ) : section.body === 'failed' ? (
        <Stack gap="3" align="flex-start">
          <Alert.Root status="error" role="alert">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{copy.errUnknown}</Alert.Description>
            </Alert.Content>
          </Alert.Root>
          <Button size="sm" variant="outline" onClick={() => void refetch()}>
            {copy.retry}
          </Button>
        </Stack>
      ) : section.body === 'empty' && !hasNextPage ? (
        <Text color="fg.muted" data-testid="ledger-empty">
          {ledgerEmptyText(listFilters)}
        </Text>
      ) : (
        <Stack gap="3">
          <Text fontSize="xs" color="fg.muted" data-testid="ledger-balance-note">
            {ledgerBalanceNote(listFilters)}
          </Text>
          {/* A list, so each row's links are told apart by the row around them (WCAG 2.4.4). */}
          <Stack as="ul" listStyleType="none" m="0" p="0" gap="3" divideY="1px">
            {entries.map((entry) => (
              <LedgerRow
                key={entry.id}
                entry={entry}
                onlyMarketHref={onlyMarketPath(entry, filters)}
              />
            ))}
          </Stack>
          {hasNextPage && (
            <>
              {/* A 더 보기 that failed: the rows stay, the message above the button that asks
                  again (owner decision 2026-10-20 7). Outside the divided rows, so no row
                  divider is drawn over it. */}
              <LoadMoreFailed
                list={list}
                message={copy.errUnknown}
                data-testid="ledger-more-failed"
              />
              <Button
                alignSelf="center"
                size="sm"
                variant="ghost"
                mt="3"
                loading={isFetchingNextPage}
                onClick={() => void fetchNextPage()}
                data-testid="ledger-more"
              >
                {copy.loadMore}
              </Button>
            </>
          )}
        </Stack>
      )}
    </Stack>
  );
}

/** A link of a row's meta line: the order's detail or the market's settlement records. */
function RowLink({ href, testId, children }: { href: string; testId: string; children: string }) {
  return (
    <ChakraLink asChild fontSize="sm" colorPalette="brand" color="colorPalette.fg">
      <NextLink href={href as Route} data-testid={testId}>
        {children}
      </NextLink>
    </ChakraLink>
  );
}

/**
 * 이용 내역 한 줄 (#69, ADR-0144 결정 2; ADR-0135 H1·H2·결정 4): the kind's name, the signed Coin
 * and the server's time; the market, linked to its page while public — an ended or settled market
 * too; for a fill its own order's detail, for a payout the market's settlement records, and
 * '이 시장만 보기' (`onlyMarketHref`, left out once the list is narrowed to that market). A Coin
 * correction says what it did (`correctionEffect`, the server's) and the member-facing reason it
 * was given. Nothing else of a fill or a payout — price, quantity, contract, result, counterparty
 * — is in the answer or here (H2: those are 주문 상세's and 이력's).
 *
 * '반영 후 코인 합계' is the ledger's own total for the account right after the row (가용 + 주문
 * 잠금, H4), drawn as stored. Side by side on a wide screen; stacked below `md`, where the right
 * column would leave a long title no room.
 *
 * `preview` (MY 요약): the name, the Coin, the time and the market's name as text — no total, no
 * links and no reason; the preview's 전체 보기 goes to the wallet.
 *
 * A list item (`li`): both lists that draw it are `ul`s, so the same '주문 상세', '정산 이력' and
 * '이 시장만 보기' on every row have that row as their context (WCAG 2.4.4, H77).
 */
export function LedgerRow({
  entry,
  variant = 'full',
  onlyMarketHref,
}: {
  entry: LedgerEntry;
  variant?: 'full' | 'preview';
  onlyMarketHref?: string;
}) {
  const formatDateTime = useFormatDateTime();
  const amount = parseCoinAmount(entry.amountCoin);
  const credit = amount >= 0n;
  const full = variant === 'full';
  const corrected = entry.kind === 'RECONCILIATION_CORRECTION';
  const market = entry.marketTitle;

  // The meta line: the time, then the row's links, each keyed by what it is.
  const meta: { key: string; node: ReactNode }[] = [
    {
      key: 'time',
      node: (
        <Text fontSize="xs" color="fg.muted">
          {formatDateTime(entry.createdAt)}
        </Text>
      ),
    },
  ];
  if (full && (entry.kind === 'BUY_FILL' || entry.kind === 'SELL_FILL') && entry.orderId) {
    meta.push({
      key: 'order',
      node: (
        <RowLink href={myOrderPath(entry.orderId)} testId="ledger-order-link">
          {copy.ledgerOrderDetail}
        </RowLink>
      ),
    });
  }
  if (full && entry.kind === 'SETTLEMENT_PAYOUT' && entry.marketId !== null) {
    meta.push({
      key: 'settlement',
      node: (
        <RowLink
          href={myHistoryPath({ kind: 'settlements', market: entry.marketId })}
          testId="ledger-settlement-link"
        >
          {copy.ledgerSettlementHistory}
        </RowLink>
      ),
    });
  }
  if (full && onlyMarketHref !== undefined) {
    meta.push({
      key: 'only-market',
      node: <OnlyMarketLink href={onlyMarketHref} testId="ledger-only-market" />,
    });
  }

  // The areas drawn, wide and narrow: a row with no market or no total has no empty line.
  const second = `"${market !== null ? 'market' : '.'} ${full ? 'total' : '.'}"`;
  const wide = ['"kind amount"', ...(market !== null || full ? [second] : []), '"meta meta"'].join(
    ' ',
  );
  const narrow = [
    '"kind amount"',
    ...(market !== null ? ['"market market"'] : []),
    '"meta meta"',
    ...(full ? ['"total total"'] : []),
  ].join(' ');

  return (
    <Grid
      as="li"
      templateColumns="minmax(0, 1fr) auto"
      templateAreas={{ base: narrow, md: wide }}
      columnGap="3"
      rowGap="1"
      pt="3"
      _first={{ pt: 0 }}
      alignItems="start"
    >
      <Stack gap="0.5" gridArea="kind" minW="0">
        <Text fontWeight="medium" data-testid="ledger-type">
          {LEDGER_KIND_LABEL[entry.kind]}
        </Text>
        {corrected && (
          <Text fontSize="xs" color="fg.muted" data-testid="ledger-correction-effect">
            {entry.correctionEffect === 'ledger_only'
              ? copy.reconciliationCorrectionReplenishHint
              : copy.reconciliationCorrectionLedgerAmountHint}
          </Text>
        )}
        {full && entry.memo && (
          <Text
            fontSize="xs"
            color="fg.muted"
            whiteSpace="pre-wrap"
            wordBreak="break-word"
            data-testid={corrected ? 'ledger-reason' : undefined}
          >
            {corrected ? `${copy.ledgerCorrectionReason}: ${entry.memo}` : entry.memo}
          </Text>
        )}
      </Stack>
      {/* The sign carries the meaning; colour only reinforces it (PLAN 11.2). */}
      <Text
        gridArea="amount"
        justifySelf="end"
        fontWeight="semibold"
        colorPalette={credit ? 'yes' : 'no'}
        color="colorPalette.fg"
        whiteSpace="nowrap"
        data-testid="ledger-amount"
      >
        {credit ? '+' : MINUS_SIGN}
        {formatCoin(credit ? amount : -amount)}
      </Text>
      {market !== null && (
        <Box gridArea="market" minW="0" wordBreak="break-word" data-testid="ledger-market">
          {full && entry.marketSlug !== null ? (
            <HistoryMarketLink slug={entry.marketSlug} title={market} />
          ) : (
            <Text fontSize="sm">{market}</Text>
          )}
        </Box>
      )}
      <HStack gridArea="meta" gap="2" flexWrap="wrap" minW="0">
        {/* Each item after the first keeps its '·' in one unbreakable span, so a wrap at 375
            lands between items and never leaves a dot at a line's end or start. */}
        {meta.map(({ key, node }, index) =>
          index === 0 ? (
            <Fragment key={key}>{node}</Fragment>
          ) : (
            <HStack as="span" key={key} gap="2" whiteSpace="nowrap">
              <Text as="span" fontSize="xs" color="fg.muted" aria-hidden="true">
                ·
              </Text>
              {node}
            </HStack>
          ),
        )}
      </HStack>
      {full && (
        <Text
          gridArea="total"
          justifySelf={{ base: 'start', md: 'end' }}
          fontSize="xs"
          color="fg.muted"
          whiteSpace="nowrap"
          data-testid="ledger-balance-after"
        >
          {copy.ledgerBalanceAfter} {formatCoin(parseCoinAmount(entry.balanceAfterCoin))}
        </Text>
      )}
    </Grid>
  );
}
