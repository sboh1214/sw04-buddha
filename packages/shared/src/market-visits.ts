import * as z from 'zod';
import { uuidSchema } from './api/uuid.js';
import { expectedAccountIdSchema } from './expected-account.js';

/*
 * 방문 기록 (#151, ADR-0170; owner answers 151-3·151-4·151-5, ADR-0167 결정 6): a signed-in,
 * onboarded member's open of a public market's detail, kept as one row per account, market and
 * Korean date (`market_visits`) and read only by the two visit-based observation metrics
 * (관심 등록 후 재방문, 결과 조회 — observation-metrics.ts). No time, address, device, referrer or
 * cookie id is kept, admins' and bots' opens are not kept at all, and no answer — public, owner or
 * admin — carries a visit row (PRIVATE_DATA `market-visits`); the admin screen sees weekly counts
 * only (95-10).
 */

/**
 * `POST /me/market-visits` (204, no body): the market whose detail the member opened and the
 * account the screen shows (`expectedAccountId`, ADR-0092 — a tab still showing account A after
 * another signed in as B would otherwise record A's open as B's). The market travels in the body,
 * not the path, so the request log line every API call leaves (method, path, address, time) never
 * names the market an account opened (ADR-0167 결정 6 "조회 시각도 남기지 않는다"; the
 * `POST /me/search-history` precedent, ADR-0066). The date is the database's (KST), never the
 * client's.
 */
export const recordMarketVisitBodySchema = z
  .object({
    expectedAccountId: expectedAccountIdSchema,
    marketId: uuidSchema,
  })
  .strict()
  .meta({ id: 'RecordMarketVisitBody' });
export type RecordMarketVisitBody = z.infer<typeof recordMarketVisitBodySchema>;
