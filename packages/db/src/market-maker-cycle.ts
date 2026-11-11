import { randomUUID } from 'node:crypto';
import {
  CONTRACT_TERMS,
  ORDER_ACCEPTING_SETTING,
  RELEASE_SETTINGS,
  isOrderIntakeOpen,
  quoteLadder,
  planBotQuotes,
  reconcileBotQuotes,
  type Outcome,
  type ReleaseSettingsRegistry,
} from '@buddha/shared';
import { eq } from 'drizzle-orm';
import type { Db } from './client.js';
import { lockOrderHolders } from './contracts.js';
import { ledgerHeldMarketIds } from './ledger-held-markets.js';
import { readMarketMakerConfig } from './market-liquidity.js';
import { burnAvailableMarketMakerPairs } from './market-maker-burn.js';
import { readMarketMakerRiskSnapshot } from './market-maker-risk.js';
import { readMarketMakerRuntime, recordMarketMakerRun } from './market-maker-runtime.js';
import { readMarketMakerStageSettings } from './market-maker-settings.js';
import { cancelOrder } from './order-cancel.js';
import {
  placeOrder,
  readLiveBook,
  placeOrderChangedBook,
  type PlaceOrderResult,
} from './orders.js';
import { getReleaseSetting } from './release-settings.js';
import { markets } from './schema/index.js';
import { clockTimestamp, lockMarket } from './tx-helpers.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export interface MarketMakerCycleContext {
  marketId: string;
  generation: bigint;
  controlGeneration: bigint;
  startedAt: Date;
}
export class MarketMakerCycleError extends Error {
  readonly context: MarketMakerCycleContext;
  constructor(context: MarketMakerCycleContext, cause: unknown) {
    super('Market maker cycle failed', { cause });
    this.name = 'MarketMakerCycleError';
    this.context = context;
  }
}
export type MarketMakerCycleResult =
  | { outcome: 'skipped'; marketId: string; reason: 'no_runtime' | 'already_completed' }
  | (MarketMakerCycleContext & {
      /** Permanent identity of this successful attempt, including normal waiting. */
      runId: string;
      outcome: 'ready' | 'waiting';
      reason: string | null;
      finishedAt: Date;
      orders: Extract<PlaceOrderResult, { kind: 'placed' }>[];
      cancelledOrderIds: string[];
      burnedQty: number;
      bookChanged: boolean;
      nextGeneration: bigint | null;
    });

/** One bounded pass. Caller commits before enqueue/publish, or rolls back before error recording.
 * All potentially encountered people are prelocked once before the first cancellation or fill:
 * several placements must not acquire new shared balances after an earlier placement wrote one.
 * No runtime is created for old OPEN markets. Price follows actual holdings, never last trade.
 */
export async function runMarketMakerCycle(
  tx: Tx,
  {
    marketId,
    registry = RELEASE_SETTINGS,
  }: { marketId: string; registry?: ReleaseSettingsRegistry },
): Promise<MarketMakerCycleResult> {
  await lockMarket(tx, marketId);
  const runtime = await readMarketMakerRuntime(tx, marketId);
  if (!runtime) return { outcome: 'skipped', marketId, reason: 'no_runtime' };
  if (runtime.generation <= runtime.completedGeneration)
    return { outcome: 'skipped', marketId, reason: 'already_completed' };
  const context = {
    marketId,
    generation: runtime.generation,
    controlGeneration: runtime.controlGeneration,
    startedAt: await clockTimestamp(tx),
  };
  try {
    const placed: Extract<PlaceOrderResult, { kind: 'placed' }>[] = [];
    const cancelledOrderIds: string[] = [];
    let burnedQty = 0;
    let configVersion = runtime.lastConfigVersion;
    const finish = async (
      outcome: 'ready' | 'waiting',
      reason: string | null,
    ): Promise<MarketMakerCycleResult> => {
      const recorded = await recordMarketMakerRun(tx, {
        ...context,
        outcome,
        reason,
        ...(configVersion === null ? {} : { configVersion }),
        detail: {
          placedOrders: placed.length,
          cancelledOrders: cancelledOrderIds.length,
          burnedQty,
        },
      });
      if (!recorded) throw new Error('Allocated runtime disappeared');
      return {
        ...context,
        runId: recorded.run.id,
        outcome,
        reason,
        finishedAt: recorded.run.finishedAt,
        orders: placed,
        cancelledOrderIds,
        burnedQty,
        bookChanged: cancelledOrderIds.length > 0 || placed.some(placeOrderChangedBook),
        nextGeneration:
          recorded.runtime.generation > context.generation ? recorded.runtime.generation : null,
      };
    };
    const [market] = await tx.select().from(markets).where(eq(markets.id, marketId)).for('update');
    if (!market) throw new Error('Allocated market disappeared');
    if (market.status !== 'open' && market.status !== 'paused')
      return finish('waiting', 'not_trading');
    if ((await ledgerHeldMarketIds(tx, [marketId])).has(marketId))
      return finish('waiting', 'ledger_hold');
    if (market.closeAt.getTime() <= context.startedAt.getTime())
      return finish('waiting', 'close_passed');
    let book = await readLiveBook(tx, marketId);
    let snapshot = await readMarketMakerRiskSnapshot(tx, marketId, book);
    if (snapshot.kind === 'inconsistent')
      throw new Error(`MM assets inconsistent: ${snapshot.reason}`);
    if (snapshot.kind !== 'ready') return finish('waiting', snapshot.reason);
    const ownerId = snapshot.ownerId;
    const config = await readMarketMakerConfig(tx, marketId);
    if (!config) return finish('waiting', 'missing_config');
    configVersion = config.version;
    const stages = await readMarketMakerStageSettings(tx, registry);
    const accepting = await getReleaseSetting(tx, registry, ORDER_ACCEPTING_SETTING);
    await lockOrderHolders(tx, marketId, [ownerId, ...book.map((o) => o.owner.id)]);
    const at = await clockTimestamp(tx);
    if (market.closeAt.getTime() <= at.getTime()) return finish('waiting', 'close_passed');
    burnedQty = await burnAvailableMarketMakerPairs(tx, marketId, `cycle:${randomUUID()}`);
    const cancel = async (ids: readonly string[]) => {
      for (const orderId of ids) {
        const result = await cancelOrder(tx, { ownerId, orderId, reason: 'by_owner' });
        if (result.kind !== 'cancelled') throw new Error(`MM quote cancel failed: ${result.kind}`);
        cancelledOrderIds.push(orderId);
      }
    };
    if (!runtime.desiredEnabled || market.status === 'paused' || stages.kind !== 'ready') {
      await cancel(snapshot.liveOrders.map((o) => o.id));
      return finish(
        'waiting',
        !runtime.desiredEnabled
          ? 'stopped'
          : market.status === 'paused'
            ? 'paused'
            : stages.kind === 'unavailable' && stages.reason === 'undecided'
              ? 'risk_settings_missing'
              : 'risk_settings_invalid',
      );
    }
    // The intake switch preserves resting orders by its existing policy. It forbids new posts;
    // it is not an implicit bot-stop command or a reason to pull the old book.
    if (!isOrderIntakeOpen(accepting)) return finish('waiting', 'intake_closed');
    snapshot = await readMarketMakerRiskSnapshot(tx, marketId);
    if (snapshot.kind !== 'ready') throw new Error('MM assets changed under its market lock');
    const limits = { ...snapshot.limits, ...stages.settings };
    const ladder = quoteLadder(snapshot.book.noQty - snapshot.book.yesQty, config, CONTRACT_TERMS);
    const target = planBotQuotes(
      ladder,
      snapshot.book,
      snapshot.liveOrders,
      config.quantity,
      limits,
      CONTRACT_TERMS,
    );
    const changes = reconcileBotQuotes(target, snapshot.liveOrders);
    // The pure diff can trim a partial remainder; storage only cancels whole orders. Cancel
    // each affected row completely, then recalculate what this SAME target still lacks.
    await cancel(changes.cancel.map((o) => o.id));
    book = await readLiveBook(tx, marketId);
    snapshot = await readMarketMakerRiskSnapshot(tx, marketId, book);
    if (snapshot.kind !== 'ready') throw new Error('MM cancellation left invalid assets');
    const remaining = reconcileBotQuotes(target, snapshot.liveOrders);
    if (remaining.cancel.length !== 0) throw new Error('MM target retained an incompatible quote');
    const refused = new Set<Outcome>();
    for (const order of remaining.place) {
      if (refused.has(order.outcome)) continue;
      const result = await placeOrder(
        tx,
        {
          ownerId,
          marketId,
          requestId: randomUUID(),
          outcome: order.outcome,
          side: 'buy',
          timeInForce: 'gtc',
          limitPriceCoin: order.priceCoin,
          qty: order.qty,
          budgetCoin: null,
        },
        { registry },
      );
      if (result.kind === 'bot_risk_rejected') {
        refused.add(order.outcome);
        continue;
      }
      if (result.kind === 'closed')
        return finish('waiting', result.why === 'intake' ? 'intake_closed' : 'price_protection');
      if (result.kind !== 'placed')
        throw new Error(`New MM order was not recorded: ${result.kind}`);
      placed.push(result);
      if (result.order.status === 'rejected') {
        refused.add(order.outcome);
        continue;
      }
      // One immediate fill changes d and can burn pairs. Never publish the old ladder's later
      // levels from the pre-fill inventory. The intake marked a newer durable generation.
      if (result.fills.length > 0) return finish('ready', null);
    }
    if (refused.size > 0) return finish('waiting', 'admission_refused');
    return finish('ready', target.yesBids.length + target.noBids.length === 0 ? 'no_quotes' : null);
  } catch (cause) {
    throw new MarketMakerCycleError(context, cause);
  }
}
