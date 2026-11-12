import * as z from 'zod';
import { uuidSchema } from './api/uuid.js';

export const RECONCILIATION_RECOVERY_APPROVAL_KIND = 'reconciliation_recovery';
export const RECONCILIATION_SYSTEM_PAUSE_NOTE =
  '담보·원장 대사에서 불일치가 확인되어 거래를 일시 중단했습니다.';
export const RECONCILIATION_SCOPES = ['market', 'account', 'supply'] as const;
export const RECONCILIATION_SOURCES = ['scheduled', 'manual', 'recovery'] as const;
export type ReconciliationScope = (typeof RECONCILIATION_SCOPES)[number];
export type ReconciliationSource = (typeof RECONCILIATION_SOURCES)[number];

export const RECONCILIATION_FINDING_CODES = [
  'balance_missing',
  'account_balance',
  'account_ledger_copy',
  'coin_lock',
  'negative_coin',
  'contract_lock',
  'market_maker_account_missing',
  'market_maker_recall',
  'retired_position',
  'closed_position_holder',
  'empty_position_cost',
  'settlement_books',
  'pair_supply',
  'pair_collateral',
  'unexpected_settlement_records',
  'pair_ledger',
  'settled_live_orders',
  'ledger_account_missing',
  'supply_balance',
  'supply_ledger_copy',
] as const;
export const reconciliationFindingSchema = z.object({
  code: z.enum(RECONCILIATION_FINDING_CODES),
  expected: z.string(),
  actual: z.string(),
  detail: z.string().optional(),
});
export type ReconciliationFinding = z.infer<typeof reconciliationFindingSchema>;

export const reconciliationTargetSchema = z.union([
  z.object({ scope: z.literal('market'), marketId: uuidSchema }),
  z.object({ scope: z.literal('account'), userId: z.string().min(1) }),
  z.object({ scope: z.literal('account'), accountId: z.string().regex(/^[1-9]\d*$/) }),
  z.object({ scope: z.literal('supply') }),
]);
export type ReconciliationTarget = z.infer<typeof reconciliationTargetSchema>;

export const reconciliationResultSchema = z
  .object({
    id: z.string(),
    scope: z.enum(RECONCILIATION_SCOPES),
    targetKey: z.string(),
    marketId: z.uuid().nullable(),
    accountId: z.string().nullable(),
    userId: z.string().nullable(),
    source: z.enum(RECONCILIATION_SOURCES),
    passed: z.boolean(),
    checkedAt: z.iso.datetime(),
    ledgerCursor: z.string(),
    findings: z.array(reconciliationFindingSchema),
    facts: z.record(z.string(), z.unknown()),
  })
  .meta({ id: 'ReconciliationResult' });
export type ReconciliationResult = z.infer<typeof reconciliationResultSchema>;

export const reconciliationHoldSchema = z
  .object({
    id: z.uuid(),
    scope: z.enum(['market', 'account']),
    targetKey: z.string(),
    marketId: z.uuid().nullable(),
    userId: z.string().nullable(),
    failureResultId: z.string().nullable(),
    legacyPauseId: z.uuid().nullable(),
    startedAt: z.iso.datetime(),
    recoveredAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'ReconciliationHold' });
export type ReconciliationHold = z.infer<typeof reconciliationHoldSchema>;

export const reconciliationRecoveryPayloadSchema = z.object({
  holdId: z.uuid(),
  failureResultId: z.string().nullable(),
});
export type ReconciliationRecoveryPayload = z.infer<typeof reconciliationRecoveryPayloadSchema>;

export const RECONCILIATION_REFUSALS = [
  'not_found',
  'stale',
  'not_passed',
  'paused',
  'requester',
  'approval',
  'pending',
] as const;
export type ReconciliationRefusal = (typeof RECONCILIATION_REFUSALS)[number];
