import { Inject, Injectable } from '@nestjs/common';
import {
  ledgerHeldMarketIds,
  readMarketMakerOpenAttempt,
  readMarketMakerRuntime,
  schema,
  type Db,
} from '@buddha/db';
import {
  isOrderIntakeOpen,
  MARKET_MAKER_REDUCE_AT_BP_SETTING,
  MARKET_MAKER_HALT_AT_BP_SETTING,
  MARKET_MAKER_REDUCE_RATIO_BP_SETTING,
  marketMakerStageSettings,
  ORDER_ACCEPTING_SETTING,
  type AdminMarketMaker,
} from '@buddha/shared';
import { eq } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { DB } from '../infra/db/db.provider.js';
import { readAdminMarketLiquidity } from '../markets/market-liquidity.js';
import { ReleaseSettingsService } from '../release-settings/release-settings.service.js';

/** A SELECT-only snapshot. Reading a legacy/open market neither allocates nor creates a bot. */
@Injectable()
export class AdminMarketMakerService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly settings: ReleaseSettingsService,
  ) {}

  get(marketId: string): Promise<AdminMarketMaker> {
    return this.db.transaction(
      async (tx) => {
        const [market] = await tx
          .select()
          .from(schema.markets)
          .where(eq(schema.markets.id, marketId));
        if (!market) throw new AppError('NOT_FOUND', { message: 'Market not found' });
        const liquidity = await readAdminMarketLiquidity(tx, market);
        const runtime = await readMarketMakerRuntime(tx, marketId);
        const openAttempt = await readMarketMakerOpenAttempt(tx, marketId);
        const readings = {
          reduceAtBp: await this.settings.get(MARKET_MAKER_REDUCE_AT_BP_SETTING, tx),
          haltAtBp: await this.settings.get(MARKET_MAKER_HALT_AT_BP_SETTING, tx),
          reduceRatioBp: await this.settings.get(MARKET_MAKER_REDUCE_RATIO_BP_SETTING, tx),
        };
        const stage = marketMakerStageSettings(readings);
        const intake = await this.settings.get(ORDER_ACCEPTING_SETTING, tx);
        const held = (await ledgerHeldMarketIds(tx, [marketId])).has(marketId);
        const blockers: AdminMarketMaker['readiness']['blockers'] = [];
        if (market.status !== 'open') blockers.push('market_not_open');
        if (held) blockers.push('ledger_hold');
        if (!liquidity.current) blockers.push('liquidity_missing');
        if (stage.kind === 'unavailable')
          blockers.push(
            stage.reason === 'undecided' ? 'risk_settings_missing' : 'risk_settings_invalid',
          );
        if (!isOrderIntakeOpen(intake)) blockers.push('intake_closed');
        if (!runtime) blockers.push('not_allocated');
        else if (!runtime.desiredEnabled) blockers.push('disabled');
        return {
          marketId,
          config: liquidity.current,
          openedVersion: liquidity.openedVersion,
          runtime:
            runtime === null
              ? null
              : {
                  desiredEnabled: runtime.desiredEnabled,
                  generation: runtime.generation.toString(),
                  completedGeneration: runtime.completedGeneration.toString(),
                  state: runtime.state,
                  reason: runtime.reason,
                  lastConfigVersion: runtime.lastConfigVersion,
                  lastAttemptAt: runtime.lastAttemptAt?.toISOString() ?? null,
                  lastSuccessAt: runtime.lastSuccessAt?.toISOString() ?? null,
                  lastFailureAt: runtime.lastFailureAt?.toISOString() ?? null,
                  lastError: runtime.lastError,
                  consecutiveFailures: runtime.consecutiveFailures,
                  updatedAt: runtime.updatedAt.toISOString(),
                },
          stageSettings: { status: stage.kind === 'ready' ? 'ready' : stage.reason, ...readings },
          readiness: { blockers },
          lastOpenAttempt:
            openAttempt === null
              ? null
              : {
                  lastAttemptAt: openAttempt.lastAttemptAt.toISOString(),
                  reason: openAttempt.reason,
                  requiredCoin: openAttempt.requiredCoin?.toString() ?? null,
                  availableCoin: openAttempt.availableCoin?.toString() ?? null,
                  liquidityVersion: openAttempt.liquidityVersion,
                  succeededAt: openAttempt.succeededAt?.toISOString() ?? null,
                },
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }
}
