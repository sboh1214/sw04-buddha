import { type JudgementDelayRead } from '@buddha/db';
import { withCurrentJudgementDelay, type AdminJudgementDelay } from '@buddha/shared';
import { type MarketRow } from './market.service.js';

/**
 * 판정 지연 기록 (#142, ADR-0106; market-judgement-delay.ts in @buddha/shared and @buddha/db) as the
 * admin detail reads it: `AdminMarket.judgementDelays`, every record of the market the newest
 * first — `readJudgementDelays` of @buddha/db, one statement, which MarketAdminService reads once
 * for this and for the inherited public `judgementDelay` alike.
 *
 * An account is named as every admin record names one (`AdminAccountActor`, as market-pause.ts):
 * its id and its current nickname — null once its member closed it (#140; an admin cannot close
 * one, ADR-0086, so a former admin's). Nothing here is public: the public detail reads the current
 * record alone, naming nobody and with no record time (`readPublicJudgementDelay`; #173 item 13,
 * decision 3 '#142 지연 사유'), and #24 decides any public history.
 */

/**
 * The records of `market` (`readJudgementDelays`, the newest first) as `AdminJudgementDelay`s,
 * each marked whether it is the market's current one (`withCurrentJudgementDelay`: the newest of
 * the market's current status and judgement version — at most one is). The mark is the episode
 * alone, not whether the market reads '판정 지연' now: the public `judgementDelay` asks that too.
 */
export function toAdminJudgementDelays(
  records: readonly JudgementDelayRead[],
  market: Pick<MarketRow, 'status' | 'judgementVersion'>,
): AdminJudgementDelay[] {
  return withCurrentJudgementDelay(records, market).map((record) => ({
    id: record.id,
    reason: record.reason,
    nextReviewAt: record.nextReviewAt.toISOString(),
    marketStatus: record.marketStatus,
    judgementVersion: record.judgementVersion,
    recordedAt: record.recordedAt.toISOString(),
    recordedBy: { id: record.recordedBy, nickname: record.recordedByNickname },
    current: record.current,
  }));
}
