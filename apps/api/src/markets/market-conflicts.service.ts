import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { declareMarketConflict, marketConflictOf, schema, type Db } from '@buddha/db';
import {
  type AdminMarketConflicts,
  type AdminMarketConflictWrite,
  type MarketConflictDeclaration,
} from '@buddha/shared';
import { asc, eq } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { clockTimestamp } from '../infra/db/clock.js';
import { DB } from '../infra/db/db.provider.js';
import { assertMarketConflictAdmin } from './market-conflicts.js';
import { lockedMarketRow, type Executor } from './market-item-rules.js';
import { MarketAdminService } from './market-admin.service.js';
import { marketTagNames } from './market.service.js';
import { readMarketSources } from './market-sources.js';
import { MarketJudgementService } from './market-judgement.service.js';
import { lockMarket } from './market-lock.js';

/** Admin-only interests. A declaration is immutable and always names the session's account. */
@Injectable()
export class MarketConflictsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly judgements: MarketJudgementService,
    private readonly markets: MarketAdminService,
  ) {}

  async get(adminId: string, marketId: string): Promise<AdminMarketConflicts> {
    return this.db.transaction(
      async (tx) => {
        const [market] = await tx
          .select({ id: schema.markets.id })
          .from(schema.markets)
          .where(eq(schema.markets.id, marketId));
        if (!market) throw new AppError('NOT_FOUND', { message: 'Market not found' });
        return this.read(tx, adminId, marketId);
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  async declare(
    adminId: string,
    marketId: string,
    reason: string,
  ): Promise<AdminMarketConflictWrite> {
    const done = await this.db.transaction(async (tx) => {
      await lockMarket(tx, marketId);
      const market = await lockedMarketRow(tx, marketId);
      await assertMarketConflictAdmin(tx, adminId);
      const existing = await marketConflictOf(tx, marketId, adminId);
      if (existing.declaration !== null)
        return {
          answer: {
            conflicts: await this.read(tx, adminId, marketId),
            market: await this.markets.toAdminMarket(
              tx,
              market,
              await marketTagNames(tx, marketId),
              await readMarketSources(tx, marketId),
            ),
          },
          retraction: null,
        };
      const at = await clockTimestamp(tx);
      const adminActionId = randomUUID();
      await tx.insert(schema.adminActions).values({
        id: adminActionId,
        adminId,
        type: 'market_conflict_declare',
        targetType: 'market',
        targetId: marketId,
        payload: { reason },
        createdAt: at,
      });
      const { declaration } = await declareMarketConflict(tx, {
        marketId,
        userId: adminId,
        reason,
        adminActionId,
        at,
      });
      const retraction = await this.judgements.retractOwnPendingForConflict(
        tx,
        adminId,
        market,
        declaration.id,
      );
      return {
        answer: { conflicts: await this.read(tx, adminId, marketId), market: retraction.market },
        retraction,
      };
    });
    if (done.retraction !== null) await this.judgements.publishConflictRetraction(done.retraction);
    return done.answer;
  }

  private async read(
    reader: Executor,
    adminId: string,
    marketId: string,
  ): Promise<AdminMarketConflicts> {
    const conflict = await marketConflictOf(reader, marketId, adminId);
    const rows = await reader
      .select({
        declaration: schema.marketConflictDeclarations,
        nickname: schema.profiles.nickname,
      })
      .from(schema.marketConflictDeclarations)
      .leftJoin(
        schema.profiles,
        eq(schema.profiles.userId, schema.marketConflictDeclarations.userId),
      )
      .where(eq(schema.marketConflictDeclarations.marketId, marketId))
      .orderBy(
        asc(schema.marketConflictDeclarations.declaredAt),
        asc(schema.marketConflictDeclarations.id),
      );
    const declarations: MarketConflictDeclaration[] = rows.map(({ declaration, nickname }) => ({
      id: declaration.id,
      reason: declaration.reason,
      declaredAt: declaration.declaredAt.toISOString(),
      declaredBy: { id: declaration.userId, nickname },
    }));
    return {
      marketId,
      operator: {
        userId: adminId,
        hasFill: conflict.hasFill,
        conflicted: conflict.conflicted,
        declaration: declarations.find((row) => row.declaredBy.id === adminId) ?? null,
      },
      declarations,
    };
  }
}
