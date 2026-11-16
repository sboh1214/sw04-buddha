'use client';

import {
  Badge,
  Button,
  DataList,
  Grid,
  HStack,
  Link as ChakraLink,
  Skeleton,
  Stack,
  Text,
} from '@chakra-ui/react';
import { parseCoinAmount } from '@buddha/shared';
import type { Route } from 'next';
import NextLink from 'next/link';
import { type ReactNode, useId } from 'react';
import { useFormatDateTime } from '@/components/time-zone/time-zone-provider';
import { CoinText } from '@/components/ui/coin-text';
import { copy } from '@/copy';
import type { AccountBlock } from '@/hooks/use-account-block';
import {
  type HeldGroup,
  averageCostBp,
  markPriceCoin,
  positionValueCoin,
  unrealizedPnlCoin,
} from '@/hooks/use-portfolio';
import type { Market, Position } from '@/lib/api';
import { MARKET_STATUS_PALETTE, formatContracts, formatPricePerContract } from '@/lib/market-admin';
import { marketStatusLabel } from '@/lib/market-status';
import { sellIntentQuery } from '@/lib/order-panel';
import {
  type SellableReading,
  type SellableView,
  sellCapText,
  sellEntryOf,
  sellableCellText,
  sellableView,
} from '@/lib/sellable-view';

/**
 * 보유 행 (#67, ADR-0142; ADR-0135 F7): one contract of a holding as MY's 보유 계약 and the detail's
 * 내 포지션 both draw it — the same cells in the same places for a contract held at 1 or more. Two
 * groups, always open: '보유·원가' (보유 수량, 매도 잠금, 평균 매입가, 잔여 원가, 실현 손익) and
 * '평가·매도' (최근 체결가 with '최근 체결 <절대 시각>' under it, 참고 평가, 미실현 손익, 매도 가능).
 * Which cell sits in which group, and their order, is this PR's choice; the owner named the groups.
 *
 * Every figure is the server's or `use-portfolio.ts`'s arithmetic in bigint, none worked out here:
 * 참고 평가 is qty × 최근 체결가 (NO the complement of the market price), 미실현 손익 that minus
 * 잔여 원가 (F1), and a holding with no fill shows '체결 없음' and '—', never 0 or the open's 50
 * (결정 4). 매도 가능 and 매도 잠금 are the sellable figures (`sellableView`): a figure not known is a
 * skeleton or '—'. No rank, skill or score sits beside a PnL (N04 §1·§3): the sign is a character
 * and the colour only repeats it.
 *
 * Side by side from md up in MY, from lg up on the detail, where the order column beside the card
 * leaves it about 400px at md; stacked below. No container query: the codebase has none.
 */

/** The repo's placeholder for a figure that does not exist (admin-market-detail.tsx). */
const EMPTY = '—';

/** A holding's status displays, from its market's live row. */
export type HoldingDisplay = Pick<Market, 'judgementDelayed' | 'disputeUnderReview'>;

/** A market with no live row yet: its holding reads its status alone. */
export const NO_HOLDING_DISPLAY: HoldingDisplay = {
  judgementDelayed: false,
  disputeUnderReview: false,
};

/** What a row's '매도' does: MY links to the detail (F6), the detail opens its own panel. */
export type SellTarget =
  { kind: 'link' } | { kind: 'panel'; onSell: (origin: HTMLElement) => void };

/** The account facts a row's '매도' is decided on (D13), and the line that says why it is off. */
export interface SellAccount {
  account: AccountBlock;
  /** `me` and the restriction answered: until then the button stays off, never flashing on. */
  accountKnown: boolean;
  /** The element that says why D13 turns '매도' off (`aria-describedby`), when one is drawn. */
  describedBy: string | undefined;
}

export interface HoldingRowProps {
  /** The row marked to its market's live price and status (`markToLiveMarket`). */
  position: Position;
  sellable: SellableReading;
  /** Reads the market's sellable (and the holdings) again: the '—' cell's 다시 시도. */
  onRetrySellable: () => void;
  sellTarget: SellTarget;
  sellAccount: SellAccount;
  layout: 'my' | 'detail';
  testId: string;
}

/** The detail's sold-out contract: '보유 없음' and its 실현 손익 (ADR-0135 결과 4 '#67·#34'). */
function NoHoldingRow({ position, testId }: { position: Position; testId: string }) {
  const yes = position.outcome === 'YES';
  return (
    <Stack gap="2" data-testid={testId}>
      <HStack gap="2">
        <Badge colorPalette={yes ? 'yes' : 'no'} variant="subtle">
          {yes ? copy.yes : copy.no}
        </Badge>
        <Text fontSize="sm" color="fg.muted" data-testid="position-none">
          {copy.positionNoHolding}
        </Text>
      </HStack>
      <DataList.Root orientation="horizontal" size="sm">
        <Cell label={copy.positionRealizedPnl} testId="position-realized">
          <Signed amount={parseCoinAmount(position.realizedPnlCoin)} />
        </Cell>
      </DataList.Root>
    </Stack>
  );
}

/** One contract's row: the two groups, the contract badge and its '매도'. */
export function HoldingRow(props: HoldingRowProps) {
  const { position, layout, testId } = props;
  const formatDateTime = useFormatDateTime();
  const holdingId = useId();
  const markId = useId();
  const sellableId = useId();
  if (position.qty < 1) return <NoHoldingRow position={position} testId={testId} />;
  const yes = position.outcome === 'YES';
  const average = averageCostBp(position);
  // All three `undefined` together, for a market with no fill to mark to (체결 없음, 결정 4).
  const mark = markPriceCoin(position);
  const value = positionValueCoin(position);
  const unrealized = unrealizedPnlCoin(position);
  const view = sellableView({
    marketStatus: position.marketStatus,
    position,
    sellable: props.sellable,
  });
  const entry = sellEntryOf({
    qty: position.qty,
    marketStatus: position.marketStatus,
    account: props.sellAccount.account,
    accountKnown: props.sellAccount.accountKnown,
  });
  const twoColumns =
    layout === 'my' ? { base: '1fr', md: '1fr 1fr' } : { base: '1fr', lg: '1fr 1fr' };
  return (
    <Stack gap="3" minW="0" data-testid={testId}>
      <HStack gap="2" justify="space-between" flexWrap="wrap">
        <Badge colorPalette={yes ? 'yes' : 'no'} variant="subtle">
          {yes ? copy.yes : copy.no}
        </Badge>
        <SellButton
          position={position}
          entry={entry}
          target={props.sellTarget}
          describedBy={
            entry.kind === 'account'
              ? props.sellAccount.describedBy
              : entry.kind === 'market'
                ? sellableId
                : undefined
          }
        />
      </HStack>
      <Grid templateColumns={twoColumns} gap="4" minW="0">
        <Stack gap="1" minW="0">
          <Text id={holdingId} fontSize="xs" fontWeight="semibold" color="fg.muted">
            {copy.positionGroupHolding}
          </Text>
          <DataList.Root orientation="horizontal" size="sm" aria-labelledby={holdingId}>
            <Cell label={copy.positionQty} testId="position-qty">
              {formatContracts(position.qty)}
            </Cell>
            <Cell label={copy.positionLockedQty} testId="position-locked">
              <Locked view={view} onRetry={props.onRetrySellable} />
            </Cell>
            <Cell label={copy.positionAvgPrice} testId="position-avg">
              {average === undefined ? EMPTY : formatPricePerContract(average)}
            </Cell>
            <Cell label={copy.positionCostBasis} testId="position-cost">
              <CoinText amount={parseCoinAmount(position.costBasisCoin)} />
            </Cell>
            <Cell label={copy.positionRealizedPnl} testId="position-realized">
              <Signed amount={parseCoinAmount(position.realizedPnlCoin)} />
            </Cell>
          </DataList.Root>
        </Stack>
        <Stack gap="1" minW="0">
          <Text id={markId} fontSize="xs" fontWeight="semibold" color="fg.muted">
            {copy.positionGroupMark}
          </Text>
          <DataList.Root orientation="horizontal" size="sm" aria-labelledby={markId}>
            <Cell label={copy.positionCurrentPrice} testId="position-last-price">
              {mark === undefined ? (
                copy.noFills
              ) : (
                <Stack gap="0">
                  <CoinText amount={mark} />
                  {/* F3: always '최근 체결 <절대 시각>', the card's and the header's words. A
                      holding with no fill has no time either. */}
                  {position.marketLastFillAt !== null && (
                    <Text as="span" fontSize="xs" color="fg.muted" data-testid="position-last-fill">
                      {`${copy.marketLastFillAt} ${formatDateTime(position.marketLastFillAt)}`}
                    </Text>
                  )}
                </Stack>
              )}
            </Cell>
            <Cell label={copy.positionValue} testId="position-value">
              {value === undefined ? EMPTY : <CoinText amount={value} />}
            </Cell>
            <Cell label={copy.positionPnl} testId="position-unrealized">
              {unrealized === undefined ? EMPTY : <Signed amount={unrealized} />}
            </Cell>
            <Cell label={copy.positionSellable} testId="position-sellable">
              <Sellable view={view} id={sellableId} onRetry={props.onRetrySellable} />
            </Cell>
          </DataList.Root>
        </Stack>
      </Grid>
    </Stack>
  );
}

/**
 * 매도 잠금: the resting sells' contracts, a skeleton until the figures are this holding's. A failed
 * read's 다시 시도 is the 매도 가능 cell's, except where that cell is '마감' from the status alone —
 * a market closed under a ledger hold keeps its locks (F2), so this cell carries it then.
 */
function Locked({ view, onRetry }: { view: SellableView; onRetry: () => void }) {
  switch (view.locked.kind) {
    case 'loading':
      return <Skeleton height="4" width="16" />;
    case 'failed':
      if (view.cell.kind !== 'closed') return EMPTY;
      return (
        <HStack gap="2">
          <Text as="span">{EMPTY}</Text>
          <Button
            size="2xs"
            variant="outline"
            onClick={onRetry}
            data-testid="position-locked-retry"
          >
            {copy.retry}
          </Button>
        </HStack>
      );
    case 'ready':
      return formatContracts(view.locked.qty);
  }
}

/** 매도 가능: the cell's line, the stop under '일부 수량만 가능', and the 1,000,000 line. */
function Sellable({ view, id, onRetry }: { view: SellableView; id: string; onRetry: () => void }) {
  if (view.cell.kind === 'loading') return <Skeleton id={id} height="4" width="24" />;
  if (view.cell.kind === 'failed') {
    return (
      <HStack gap="2" id={id}>
        <Text as="span">{EMPTY}</Text>
        <Button size="2xs" variant="outline" onClick={onRetry} data-testid="position-sell-retry">
          {copy.retry}
        </Button>
      </HStack>
    );
  }
  const text = sellableCellText(view.cell);
  return (
    <Stack gap="0" id={id} minW="0">
      <Text as="span">{text?.line}</Text>
      {text?.reason !== undefined && (
        <Text as="span" fontSize="xs" color="fg.muted" data-testid="position-sell-reason">
          {text.reason}
        </Text>
      )}
      {view.cap && (
        <Text as="span" fontSize="xs" color="fg.muted" data-testid="position-sell-cap">
          {sellCapText()}
        </Text>
      )}
    </Stack>
  );
}

/**
 * '매도' (F6): on, a link to the detail with the contract and 매도 chosen (MY) or the detail's own
 * panel (내 포지션); off, a real disabled button with no address, pointing at the line that says
 * why — D13's account line, or the row's own 매도 가능 cell ('마감', '일시 중단'; ADR-0142).
 */
function SellButton({
  position,
  entry,
  target,
  describedBy,
}: {
  position: Position;
  entry: ReturnType<typeof sellEntryOf>;
  target: SellTarget;
  describedBy: string | undefined;
}) {
  if (entry.kind === 'none') return null;
  const contract = position.outcome === 'YES' ? copy.yes : copy.no;
  const label = `${position.marketTitle} ${contract} ${copy.positionSell}`;
  if (entry.kind !== 'on') {
    return (
      <Button
        size="sm"
        variant="outline"
        disabled
        aria-label={label}
        aria-describedby={describedBy}
        data-testid="position-sell"
      >
        {copy.positionSell}
      </Button>
    );
  }
  if (target.kind === 'panel') {
    return (
      <Button
        size="sm"
        variant="outline"
        aria-label={label}
        onClick={(event) => {
          target.onSell(event.currentTarget);
        }}
        data-testid="position-sell"
      >
        {copy.positionSell}
      </Button>
    );
  }
  const href = `/markets/${position.marketSlug}?${sellIntentQuery(position.outcome)}` as Route;
  return (
    <Button asChild size="sm" variant="outline">
      <NextLink href={href} aria-label={label} data-testid="position-sell">
        {copy.positionSell}
      </NextLink>
    </Button>
  );
}

/**
 * MY's market group (F7): the market's title — a link to it — and, while it is not 거래 중, its
 * status with '판정 지연' or '이의 검토 중' from its live row; under it the held contracts, YES
 * then NO.
 */
export function HoldingMarketGroup({
  group,
  display,
  sellables,
  onRetrySellable,
  sellAccount,
}: {
  group: HeldGroup;
  display: HoldingDisplay;
  /** The sellable reading of each held contract, by outcome. */
  sellables: (outcome: Position['outcome']) => SellableReading;
  onRetrySellable: () => void;
  sellAccount: SellAccount;
}) {
  const [first] = group.rows;
  if (first === undefined) return null;
  return (
    <Stack
      gap="3"
      borderWidth="1px"
      borderRadius="l2"
      p="3"
      minW="0"
      data-testid={`portfolio-market-${group.marketId}`}
    >
      <HStack gap="2" flexWrap="wrap">
        <ChakraLink asChild fontWeight="semibold">
          <NextLink href={`/markets/${first.marketSlug}` as Route}>{first.marketTitle}</NextLink>
        </ChakraLink>
        {first.marketStatus !== 'open' && (
          <Badge
            colorPalette={MARKET_STATUS_PALETTE[first.marketStatus]}
            variant="subtle"
            data-testid="portfolio-market-status"
          >
            {marketStatusLabel({ status: first.marketStatus, ...display })}
          </Badge>
        )}
      </HStack>
      <Stack gap="4" divideY="1px">
        {group.rows.map((row) => (
          <HoldingRow
            key={row.outcome}
            position={row}
            sellable={sellables(row.outcome)}
            onRetrySellable={onRetrySellable}
            sellTarget={{ kind: 'link' }}
            sellAccount={sellAccount}
            layout="my"
            testId={`portfolio-position-${row.marketId}-${row.outcome}`}
          />
        ))}
      </Stack>
    </Stack>
  );
}

/**
 * A gain or a loss. `formatCoin` writes a loss with U+2212 (PLAN 11.1-6), so the colour only
 * repeats what the sign already says — and at exactly 0 it stays on the ordinary foreground
 * rather than claiming a direction.
 */
function Signed({ amount }: { amount: bigint }) {
  if (amount === 0n) return <CoinText amount={amount} />;
  return (
    <CoinText amount={amount} colorPalette={amount > 0n ? 'yes' : 'no'} color="colorPalette.fg" />
  );
}

/** One label and value; the value never pushes the row wider than the screen (R16). */
function Cell({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  return (
    <DataList.Item>
      <DataList.ItemLabel>{label}</DataList.ItemLabel>
      <DataList.ItemValue
        minW="0"
        overflowWrap="anywhere"
        fontVariantNumeric="tabular-nums"
        data-testid={testId}
      >
        {children}
      </DataList.ItemValue>
    </DataList.Item>
  );
}
