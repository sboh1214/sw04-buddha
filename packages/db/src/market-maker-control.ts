import {
  MARKET_MAKER_CONTROL_KIND,
  MAX_COIN_AMOUNT,
  marketLiquiditySettingsInputSchema,
  marketMakerControlPayloadSchema,
  marketMakerDemandSnapshotSchema,
  type MarketMakerControlPayload,
  type RequestMarketMakerControlBody,
  type MARKET_MAKER_CONTROL_REFUSALS,
} from '@buddha/shared';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { findLedgerAccount, lockLedgerAccounts, recordLedgerEntry } from './ledger.js';
import { ledgerHeldMarketIds } from './ledger-held-markets.js';
import { readMarketMakerConfig } from './market-liquidity.js';
import { readMarketMakerRiskSnapshot } from './market-maker-risk.js';
import { readMarketMakerRuntime } from './market-maker-runtime.js';
import { readMarketMakerStageSettings } from './market-maker-settings.js';
import { readAdminTreasurySnapshot } from './treasury-snapshot.js';
import { cancelOrder } from './order-cancel.js';
import {
  approvalRequests,
  balances,
  marketLiquidityVersions,
  marketMakerControls,
  marketMakerRuntime,
  markets,
  profiles,
} from './schema/index.js';
import { clockTimestamp, lockAdminRoles, lockMarket } from './tx-helpers.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type MarketMakerControlRow = typeof marketMakerControls.$inferSelect;
export class MarketMakerControlError extends Error {
  readonly code: (typeof MARKET_MAKER_CONTROL_REFUSALS)[number];
  constructor(code: MarketMakerControlError['code']) {
    super(`Market maker control: ${code}`);
    this.name = 'MarketMakerControlError';
    this.code = code;
  }
}
const refuse = (code: MarketMakerControlError['code']): never => {
  throw new MarketMakerControlError(code);
};

export async function assertMarketMakerControlAdmin(tx: Tx, actorId: string): Promise<void> {
  await lockAdminRoles(tx, 'shared');
  const [actor] = await tx
    .select({ id: profiles.userId })
    .from(profiles)
    .where(
      and(eq(profiles.userId, actorId), eq(profiles.role, 'admin'), isNull(profiles.closedAt)),
    );
  if (!actor) refuse('approval');
}
const configWire = (c: NonNullable<Awaited<ReturnType<typeof readMarketMakerConfig>>>) => ({
  budgetCoin: c.budgetCoin.toString(),
  maxLossCoin: c.maxLossCoin.toString(),
  b: c.b,
  levels: c.levels,
  quantity: c.quantity,
  safetyTicks: c.safetyTicks,
});

async function context(
  tx: Tx,
  marketId: string,
  payload: Pick<MarketMakerControlPayload, 'baseVersion' | 'baseControlGeneration' | 'change'>,
) {
  await lockMarket(tx, marketId);
  const [market] = await tx.select().from(markets).where(eq(markets.id, marketId)).for('update');
  if (!market) return refuse('not_found');
  const config = await readMarketMakerConfig(tx, marketId);
  const runtime = await readMarketMakerRuntime(tx, marketId);
  if (!config || !runtime || market.openedLiquidityVersion === null) return refuse('not_allocated');
  if (
    config.version !== payload.baseVersion ||
    runtime.controlGeneration.toString() !== payload.baseControlGeneration
  )
    refuse('stale');
  const action = payload.change.action;
  if (market.status !== 'open' && !(action === 'stop' && market.status === 'paused'))
    refuse('state');
  if ((await ledgerHeldMarketIds(tx, [marketId])).has(marketId)) refuse('held');
  if (market.closeAt <= (await clockTimestamp(tx))) refuse('close_passed');
  if (
    (action === 'stop' && !runtime.desiredEnabled) ||
    (action === 'resume' && runtime.desiredEnabled)
  )
    refuse('unchanged');
  const next = configWire(config);
  if (payload.change.action === 'settings') Object.assign(next, payload.change.settings);
  if (payload.change.action === 'increase')
    next.budgetCoin = (config.budgetCoin + BigInt(payload.change.additionalCoin)).toString();
  if (!marketLiquiditySettingsInputSchema.safeParse(next).success) refuse('settings');
  if (action === 'settings' && JSON.stringify(next) === JSON.stringify(configWire(config)))
    refuse('unchanged');
  return { market, config, runtime, next };
}

/** Captures evidence under the market lock; no numeric demand threshold or personal snapshot. */
export async function prepareMarketMakerControlRequest(
  tx: Tx,
  marketId: string,
  actorId: string,
  body: RequestMarketMakerControlBody,
): Promise<MarketMakerControlPayload> {
  await lockMarket(tx, marketId);
  await assertMarketMakerControlAdmin(tx, actorId);
  const { config, runtime } = await context(tx, marketId, body);
  const change =
    body.change.action === 'increase'
      ? {
          ...body.change,
          demand: {
            ...body.change.demand,
            from: new Date(body.change.demand.from).toISOString(),
            to: new Date(body.change.demand.to).toISOString(),
          },
        }
      : body.change;
  let demandSnapshot: MarketMakerControlPayload['demandSnapshot'] = null;
  if (change.action === 'increase') {
    const at = await clockTimestamp(tx);
    const { from, to } = change.demand;
    if (new Date(to) > at) refuse('settings');
    const { rows } = await tx.execute<{ snapshot: unknown }>(
      sql`SELECT market_maker_demand_snapshot(${marketId}::uuid, ${from}::timestamptz, ${to}::timestamptz, ${at.toISOString()}::timestamptz, NULL) AS snapshot`,
    );
    demandSnapshot = marketMakerDemandSnapshotSchema.parse(rows[0]?.snapshot);
  }
  return marketMakerControlPayloadSchema.parse({
    baseVersion: body.baseVersion,
    baseControlGeneration: body.baseControlGeneration,
    change,
    beforeConfig: configWire(config),
    beforeDesiredEnabled: runtime.desiredEnabled,
    demandSnapshot,
  });
}

/** Complete asset lock set BEFORE the approval row. Missing allocated assets never get made. */
export async function lockMarketMakerControl(
  tx: Tx,
  marketId: string,
  payload: MarketMakerControlPayload,
) {
  const current = await context(tx, marketId, payload);
  const collateral = await findLedgerAccount(tx, { kind: 'market_collateral', marketId });
  const refs = [
    { kind: 'market_maker_funds' as const, marketId },
    ...(collateral ? [{ kind: 'market_collateral' as const, marketId }] : []),
  ];
  const all =
    payload.change.action === 'increase' ? [...refs, { kind: 'treasury' as const }] : refs;
  for (const ref of all) {
    const account = await findLedgerAccount(tx, ref);
    if (!account) refuse(ref.kind === 'treasury' ? 'treasury' : 'assets');
    const [balance] = await tx
      .select({ id: balances.accountId })
      .from(balances)
      .where(eq(balances.accountId, account!.id));
    if (!balance) refuse(ref.kind === 'treasury' ? 'treasury' : 'assets');
  }
  await lockLedgerAccounts(tx, all);
  const risk = await readMarketMakerRiskSnapshot(tx, marketId);
  if (risk.kind !== 'ready') return refuse('assets');
  const { rows } = await tx.execute<{ valid: boolean }>(
    sql`SELECT market_maker_control_assets_valid(${marketId}::uuid) AS valid`,
  );
  if (!rows[0]?.valid) refuse('assets');
  if (
    payload.change.action === 'resume' &&
    (await readMarketMakerStageSettings(tx)).kind !== 'ready'
  )
    refuse('settings');
  if (payload.change.action === 'increase') {
    const treasury = await readAdminTreasurySnapshot(tx);
    if (treasury.status !== 'ready' || treasury.availableCoin === null) return refuse('treasury');
    const delta = BigInt(payload.change.additionalCoin);
    if (BigInt(treasury.availableCoin) < delta) refuse('insufficient_treasury');
    if (risk.book.coin + delta > MAX_COIN_AMOUNT) refuse('capacity');
  }
  // Last lock may have waited beyond close; neither the payload nor process time can extend it.
  await context(tx, marketId, payload);
  return { ...current, risk };
}

/** Same transaction as ApprovalService.approve. SQL independently binds every economic effect. */
export async function applyMarketMakerControl(tx: Tx, input: { approvalId: string }) {
  const [identity] = await tx
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.id, input.approvalId));
  if (
    !identity ||
    identity.kind !== MARKET_MAKER_CONTROL_KIND ||
    identity.targetType !== 'market' ||
    !identity.targetId
  )
    return refuse('not_found');
  const marketId = identity.targetId;
  await lockMarket(tx, marketId);
  await lockAdminRoles(tx, 'shared');
  const [prior] = await tx
    .select()
    .from(marketMakerControls)
    .where(eq(marketMakerControls.approvalId, input.approvalId));
  if (prior)
    return {
      outcome: 'duplicate' as const,
      execution: prior,
      cancelledOrderIds: [] as string[],
      generation: prior.afterGeneration,
      bookChanged: false,
      refreshRequested: false,
    };
  const payload = marketMakerControlPayloadSchema.parse(identity.payload);
  const current = await lockMarketMakerControl(tx, marketId, payload);
  const [approval] = await tx
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.id, input.approvalId))
    .for('update');
  if (
    !approval ||
    approval.status !== 'approved' ||
    !approval.decidedBy ||
    approval.decidedBy === approval.requestedBy
  )
    return refuse('approval');
  const admins = await tx
    .select({ id: profiles.userId })
    .from(profiles)
    .where(
      and(
        inArray(profiles.userId, [approval.requestedBy, approval.decidedBy]),
        eq(profiles.role, 'admin'),
        isNull(profiles.closedAt),
      ),
    );
  if (admins.length !== 2) refuse('requester');
  if (
    JSON.stringify(payload.beforeConfig) !== JSON.stringify(configWire(current.config)) ||
    payload.beforeDesiredEnabled !== current.runtime.desiredEnabled
  )
    refuse('stale');
  const action = payload.change.action;
  const at = await clockTimestamp(tx);
  const cancelledOrderIds: string[] = [];
  if (action === 'stop') {
    for (const order of current.risk.liveOrders) {
      const result = await cancelOrder(tx, {
        ownerId: current.risk.ownerId,
        orderId: order.id,
        reason: 'by_owner',
      });
      if (result.kind !== 'cancelled') refuse('assets');
      cancelledOrderIds.push(order.id);
    }
  }
  let ledgerEntryId: number | null = null;
  if (payload.change.action === 'increase') {
    const transfer = await recordLedgerEntry(tx, {
      type: 'BOT_ALLOCATION',
      from: { kind: 'treasury' },
      to: { kind: 'market_maker_funds', marketId },
      marketId,
      amountCoin: BigInt(payload.change.additionalCoin),
      refType: 'approval_request',
      refId: approval.id,
      idempotencyKey: approval.id,
      at,
    });
    if (transfer.outcome !== 'recorded') return refuse('approval');
    ledgerEntryId = transfer.entry.id;
  }
  const changesVersion = action === 'settings' || action === 'increase';
  const nextVersion = current.config.version + (changesVersion ? 1 : 0);
  const desiredEnabled =
    action === 'stop' ? false : action === 'resume' ? true : current.runtime.desiredEnabled;
  const [execution] = await tx
    .insert(marketMakerControls)
    .values({
      approvalId: approval.id,
      marketId,
      action,
      requestedBy: approval.requestedBy,
      approvedBy: approval.decidedBy,
      beforeVersion: current.config.version,
      afterVersion: nextVersion,
      beforeControlGeneration: current.runtime.controlGeneration,
      afterControlGeneration: current.runtime.controlGeneration + 1n,
      beforeGeneration: current.runtime.generation,
      afterGeneration: current.runtime.generation + 1n,
      beforeDesiredEnabled: current.runtime.desiredEnabled,
      afterDesiredEnabled: desiredEnabled,
      additionalCoin:
        payload.change.action === 'increase' ? BigInt(payload.change.additionalCoin) : null,
      ledgerEntryId,
      performedAt: at,
      appliedTxid: sql`pg_current_xact_id()::text`,
    })
    .returning();
  if (changesVersion) {
    await tx.insert(marketLiquidityVersions).values({
      marketId,
      version: nextVersion,
      ...marketLiquiditySettingsInputSchema.parse(current.next),
      createdBy: approval.decidedBy,
      reason: approval.decisionReason!,
      createdAt: at,
    });
    await tx
      .update(markets)
      .set({ currentLiquidityVersion: nextVersion, updatedAt: sql`${markets.updatedAt}` })
      .where(eq(markets.id, marketId));
  }
  await tx
    .update(marketMakerRuntime)
    .set({
      desiredEnabled,
      controlGeneration: current.runtime.controlGeneration + 1n,
      generation: current.runtime.generation + 1n,
      state: desiredEnabled ? 'waiting' : 'stopped',
      reason:
        action === 'stop' ? 'operator_stopped' : desiredEnabled ? null : current.runtime.reason,
      updatedAt: at,
    })
    .where(eq(marketMakerRuntime.marketId, marketId));
  return {
    outcome: 'applied' as const,
    execution: execution!,
    cancelledOrderIds,
    generation: current.runtime.generation + 1n,
    bookChanged: cancelledOrderIds.length > 0 || action === 'settings' || action === 'resume',
    refreshRequested: action !== 'stop',
  };
}
