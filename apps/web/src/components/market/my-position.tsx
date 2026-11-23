'use client';

import { Alert, Button, Card, Heading, Skeleton, Stack } from '@chakra-ui/react';
import { type MarketStatus } from '@buddha/shared';
import { ProfileUnavailable } from '@/components/my/profile-unavailable';
import { AccountBlockLine } from '@/components/position/account-block-line';
import { HoldingRow, type SellAccount } from '@/components/position/holding-rows';
import { EmptyState } from '@/components/ui/empty-state';
import { copy } from '@/copy';
import { useMarketSettlements } from '@/hooks/use-market-recap';
import { useMe } from '@/hooks/use-me';
import {
  type LiveMarketReading,
  markToLiveMarket,
  positionListStatusFor,
  usePositions,
} from '@/hooks/use-portfolio';
import { useSellableReadings } from '@/hooks/use-sellable-readings';
import { type MySettlement, type PublicMarketJudgementCorrection } from '@/lib/api';
import {
  positionEmptyCopy,
  recapViewOf,
  recordsReadingOf,
  settledRecapOf,
} from '@/lib/market-recap';
import { refreshFailed, sessionListSection } from '@/lib/query-client';
import { POSITION_ACCOUNT_LINE_ID, positionAccountLine } from '@/lib/sellable-view';
import { useOrderPanel } from './order-panel-provider';
import { CorrectionRecap } from './correction-recap';
import { SettledRecap } from './settled-recap';

/**
 * 내 포지션 on the market detail (PLAN 11.3): what this visitor holds in THIS market, marked to
 * the market's own last price while it still trades, and what the market paid them once it has
 * finished.
 *
 * Every figure is `use-portfolio.ts`'s arithmetic, in `bigint`. Not one of them is recomputed
 * here, and `markPriceCoin` in particular is the reason: a NO contract is worth the complement of
 * the YES price, and valuing it at the YES price is a silent error that produces a plausible
 * number wrong by 100 − 2·price per contract.
 *
 * The list itself is `usePositions` — the same query MY's 보유 계약 reads, so the two screens
 * hold one copy of the rows rather than two. It waits for the session on its own, so a
 * signed-out visitor never provokes the 401 that the retry rule refuses to retry, and this card
 * draws nothing for one (#122): 내 포지션 is a personal area, a signed-in reader's only, and the
 * detail puts its one sign-in prompt for all the personal areas in this card's place instead.
 *
 * WHICH of the two lists it reads follows the market's own status through
 * `positionListStatusFor`: a finished market moved its holders' rows to the settled list, so
 * asking only for `'open'` would answer "아직 이 시장에 참여하지 않았습니다" to an account that
 * did hold and was paid out. A paid-out market adds the account's settlement records of it
 * (`useMarketSettlements`, #34, ADR-0145; ADR-0135 I1) and draws the recap (`SettledRecap`): each
 * record's columns with the result, the two times, and the row's 실현 손익 — the same figures, by
 * the same names, as the record's line in MY's 정산 이력. Every status before that keeps the
 * holding rows, marked to the last price with no expected payout (ADR-0135 F2), and never a
 * record: the query is off until the market is `settled` (`recapViewOf`).
 */

export interface MyPositionProps {
  /** The market's canonical lower-cased uuid — `Position.marketId` carries the same string. */
  marketId: string;
  /**
   * The market's current status, which is what says which of the two position lists this
   * account's rows are in. Optional and `'open'` by default: a caller that has not loaded the
   * row yet keeps exactly the pre-terminal reading rather than guessing at the wrong list, and
   * the detail page seeds the row into the cache before the first client render, so the
   * default is a fallback and not the ordinary path.
   */
  status?: MarketStatus;
  /**
   * The market's live row — its price with the fill's time and count, and its status with its
   * key — which 최근 체결가, 참고 평가 and 미실현 손익 are marked to (`markToLiveMarket`, #67).
   *
   * `Position.marketLastPrice` is a join taken when the positions list was fetched, and only
   * this account's own trades ever move that list; somebody else's trade arrives as a
   * `market:tick` and writes the `['market', id]` cache instead. Without this the price in the
   * header above and the valuation in this card drifted apart on a market anyone else was
   * trading. `undefined` (the row not loaded) keeps the snapshot the list carried, as MY does for
   * a market it has no cache entry for.
   */
  live?: LiveMarketReading;
  /**
   * The market's 판정 정정 confirmed after its payout (`judgingRecord.correction`, #144 — ADR-0166,
   * 144-11): the recap's records stay the paid result's, and a 판정 정정 block goes under them
   * (`CorrectionRecap`). Null or absent for every other market.
   */
  correction?: PublicMarketJudgementCorrection | null;
  'data-testid'?: string;
}

export function MyPosition({
  marketId,
  status = 'open',
  live,
  correction = null,
  'data-testid': testId = 'market-my-position',
}: MyPositionProps) {
  const listStatus = positionListStatusFor(status);
  const accountId = useMe().data?.id;
  const positions = usePositions(listStatus, accountId);
  const rows = (positions.data ?? []).filter((row) => row.marketId === marketId);
  // A paid-out market's settlement records (ADR-0145): no request before `settled`.
  const { query: records, mountedAt } = useMarketSettlements(marketId, status, accountId);
  const recordRows: MySettlement[] = (
    records.data?.pages.flatMap((page) => page.items) ?? []
  ).filter((record) => record.marketId.toLowerCase() === marketId.toLowerCase());
  const panel = useOrderPanel();
  // The same 매도 가능액 entry as the order panel's (`sellableKey`): no request of its own.
  const marked = listStatus === 'open' ? rows.map((row) => markToLiveMarket(row, live)) : rows;
  const sellable = useSellableReadings({
    accountId: listStatus === 'open' ? accountId : undefined,
    marketIds: listStatus === 'open' && rows.some((row) => row.qty >= 1) ? [marketId] : [],
    positions: marked,
    list: positions,
  });
  // D13's line: the order column's where it is drawn, else the card's own above the rows (375,
  // or a market with no order area), so an off '매도' always has its reason on screen.
  const accountLine = positionAccountLine({
    account: panel.account,
    orderArea: panel.orderArea,
    mdUp: panel.mdUp,
  });
  const sellAccount: SellAccount = {
    account: panel.account,
    accountKnown: panel.accountKnown && panel.me !== undefined,
    describedBy: accountLine.describedBy,
  };
  // Four states, not three. A refetch that fails after the list has answered KEEPS the rows and
  // reports `isRefetchError`, which this ladder folded into the ordinary reading — and on this
  // card that silence is a false sentence, not merely a stale one. `user:position` can neither
  // BUILD a row (it carries no marketSlug/Title/Status/LastPrice) nor MOVE one between the two
  // lists, so `applyPositionEvent` answers `refetch` for exactly the two cases that matter here:
  // another tab opening this market's first holding, and a settlement. That refetch is the only
  // path, and when it failed the card told an account that DOES hold — and on a settled market,
  // one that was already paid out — 아직 이 시장에 참여하지 않았습니다.
  //
  // The count is the MARKET-FILTERED one: a stale list full of other markets' rows is empty for
  // this market, which is the reading that has to reach the empty rung rather than an empty list.
  const section = sessionListSection(positions, rows.length);
  // A personal area, so a signed-in reader's only (ADR-0061 decision 1, item 18): the detail
  // draws this card for one alone (`personalAreaView`), and a visitor gets the detail's one
  // sign-in prompt for every personal area rather than a card of this one's own (owner decision
  // 2026-10-17). The rung is the card's own half of that rule.
  if (section.body === 'signedOut') return null;
  const view = recapViewOf({
    status,
    list: listStatus,
    positions: section.body,
    // Only a list read on this mount decides; a failed read over an older one is a failure.
    records: recordsReadingOf(records, mountedAt, recordRows.length),
  });
  // A records refresh that failed after a read on this mount keeps the recap and says so with the
  // rows' own notice — on a paid-out market alone, where the records are read; with no such read
  // the card is `recordsFailed` and its own 다시 시도.
  const recordsStale = status === 'settled' && view !== 'recordsFailed' && refreshFailed(records);
  const retry = () => {
    void positions.refetch();
    if (recordsStale) void records.refetch();
  };

  return (
    <Card.Root data-testid={testId}>
      <Card.Header>
        <Heading as="h2" size="md">
          {copy.marketMyPosition}
        </Heading>
      </Card.Header>
      <Card.Body>
        <Stack gap="3">
          {/* Above the body, never in place of it: the rows are real and worth keeping on
                screen, and the empty rung is the one that needs the label most. The same shape
                as 최근 체결's stale notice (recent-fills.tsx). */}
          {(section.stale || recordsStale) && (
            <Alert.Root status="warning" role="status" data-testid="market-my-position-stale">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>{copy.marketRefreshFailed}</Alert.Description>
              </Alert.Content>
              <Button size="xs" variant="outline" ml="auto" onClick={retry}>
                {copy.retry}
              </Button>
            </Alert.Root>
          )}
          {accountId === undefined ? (
            // The list is keyed by MY's account, which `GET /me` names (#67, ADR-0142).
            <ProfileUnavailable height="12" />
          ) : view === 'pending' ? (
            <Skeleton height="12" />
          ) : view === 'failed' ? (
            <Stack gap="2" align="flex-start">
              <Alert.Root status="error" role="alert">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Description>{copy.errUnknown}</Alert.Description>
                </Alert.Content>
              </Alert.Root>
              <Button size="sm" variant="outline" onClick={() => void positions.refetch()}>
                {copy.retry}
              </Button>
            </Stack>
          ) : view === 'recordsFailed' ? (
            // No figure at all rather than a recap without its payout.
            <Stack gap="2" align="flex-start" data-testid="market-settled-failed">
              <Alert.Root status="error" role="alert">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Description>{copy.errUnknown}</Alert.Description>
                </Alert.Content>
              </Alert.Root>
              <Button size="sm" variant="outline" onClick={() => void records.refetch()}>
                {copy.retry}
              </Button>
            </Stack>
          ) : view === 'empty' ? (
            <EmptyState
              message={positionEmptyCopy(status)}
              data-testid="market-my-position-empty"
            />
          ) : view === 'recap' || view === 'ended' ? (
            // A finished market is never marked to a price: its last price is not its result. A
            // cancelled market has no records (ADR-0117), so its rows, if any, are sold-out lines.
            <Stack gap="4">
              <SettledRecap
                entries={settledRecapOf(rows, view === 'recap' ? recordRows : [])}
                marketId={marketId}
              />
              {/* 144-11: the records as they are, then the correction and this account's share. */}
              {view === 'recap' && correction !== null && (
                <CorrectionRecap
                  marketId={marketId}
                  correction={correction}
                  accountId={accountId}
                />
              )}
            </Stack>
          ) : (
            <Stack gap="4">
              {accountLine.ownLine && (
                <AccountBlockLine
                  id={POSITION_ACCOUNT_LINE_ID}
                  account={panel.account}
                  restrictionEndsAt={panel.restrictionEndsAt}
                  testId="market-position-account-blocked"
                />
              )}
              <Stack gap="4" divideY="1px">
                {/* MY's row, field for field (F7): the same cells in the same places, without the
                    market's title — this IS that market's page. A sold-out contract is '보유 없음'
                    with its 실현 손익 (ADR-0135 결과 4). The '매도' opens this page's own panel. */}
                {[...marked]
                  .sort((a, b) => (a.outcome === 'YES' ? 0 : 1) - (b.outcome === 'YES' ? 0 : 1))
                  .map((row) => (
                    <HoldingRow
                      key={row.outcome}
                      position={row}
                      sellable={sellable.reading(row.marketId, row.outcome, row.qty)}
                      onRetrySellable={() => {
                        sellable.retry(row.marketId);
                      }}
                      sellTarget={{
                        kind: 'panel',
                        onSell: (origin) => {
                          panel.openSell(row.outcome, origin);
                        },
                      }}
                      sellAccount={sellAccount}
                      layout="detail"
                      testId={`market-position-${row.outcome === 'YES' ? 'yes' : 'no'}`}
                    />
                  ))}
              </Stack>
            </Stack>
          )}
        </Stack>
      </Card.Body>
    </Card.Root>
  );
}
