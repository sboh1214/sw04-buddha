/**
 * 원장 계정과 이벤트 유형의 규칙 (#116, ADR-0109; ADR-0107 결정 2 #73 1·2·3·10·15·16항).
 *
 * The ledger is a record of moves between ledger accounts (LEDGER_ACCOUNT_KINDS): a person's own
 * `user` account, the operating `treasury`, each market's `market_collateral` and each market's
 * `market_maker_funds`. An event moves a positive amount from one account to another, or mints
 * into one (no from-account) or burns from one (no to-account). Which (from, to) pairs a type may
 * take is this table, and nothing else: the write API refuses any other (@buddha/db `ledger.ts`)
 * and the database refuses it again (`ledger_entry_direction_allowed`, migration 0060, which a db
 * test keeps equal to `isLedgerDirectionAllowed` for every type and pair).
 *
 * The plan's words (N01 §2·§9) and the types that carry them:
 * - 발행: START_GRANT (mint → user) and TREASURY_MINT (mint → treasury); 재지급 (#74) and 판정 오류
 *   보상 (#144) are added later, each a mint → user under its own type;
 * - 운영금 이전: BOT_ALLOCATION (treasury → 마켓메이커 자금) and BOT_RECALL (back);
 * - 지원 (N01 §9): BOT_ALLOCATION alone — a recall is 운영금 이전, not 지원 — and 재지급 (#74),
 *   not yet (ADR-0107 결정 2 #73 1항);
 * - 담보: PAIR_MINT_COLLATERAL (buyer → collateral), released by PAIR_BURN_RETURN (collateral →
 *   the bot's funds; a user's pair is never burned, #177 6항);
 * - 거래: TRADE_FILL (buyer → seller), the one move between two holders — no user sends Coin to
 *   another any other way;
 * - 수수료: none while fees are 0 (15항, #91): no FEE type and no fee row;
 * - 정산: SETTLEMENT_PAYOUT (collateral → holder, VOID's 50·50 too);
 * - 보상: 판정 오류 보상 (#144), not yet;
 * - 실제 소각: CLOSURE_FORFEIT (user → burn), the only burn (16항); no generic burn type;
 * - 대사 정정 (10항): RECONCILIATION_CORRECTION, the treasury against the account that differs
 *   (the collateral, a 마켓메이커 자금, or a user's — which it only ever credits: a correction never
 *   takes a user's Coin, and so never undoes a paid settlement, N03 §7).
 * The kept paid-Coin and coupon types (2항) mint into, or (PAYMENT_CANCEL) burn from, the user's
 * account, and #93 counts them with the rest.
 *
 * Order locks are not here (1항 주문 잠금): a lock moves Coin between one account's available and
 * locked buckets, the order row is its record, and #93 reconciles locked = live orders' locks.
 */
import * as z from 'zod';
import type { LedgerAccountKind, LedgerEntryType } from './enums.js';
import { LEDGER_ENTRY_TYPES } from './enums.js';

/** One side of an event: an account kind, or null for a mint's from-side or a burn's to-side. */
export type LedgerSide = LedgerAccountKind | null;

/** The plan's word for a type's source (N01 §2·§9, #73 1항); '보존' for the kept four (2항). */
export type LedgerPlanWord =
  '발행' | '운영금 이전' | '담보' | '거래' | '정산' | '소각' | '대사 정정' | '보존';

export interface LedgerEntryRule {
  /** `mint`: from is null; `burn`: to is null; `move`: both are accounts. */
  readonly flow: 'mint' | 'burn' | 'move';
  /** The (from, to) pairs the type may take — pairs, never a product of the two sides' kinds. */
  readonly pairs: readonly (readonly [from: LedgerSide, to: LedgerSide])[];
  /**
   * The event's `market_id`: `required` (a market's event), `none` (never a market's), or
   * `by_account` (exactly when one side is a market's account — the collateral or a 마켓메이커 자금).
   * A side that is a market's account always names the event's market.
   */
  readonly market: 'required' | 'none' | 'by_account';
  /**
   * Whether the from-account's locked bucket may pay it (`debitFrom: 'locked'`): an order's lock
   * consumed by its fill (#177 3항). Every other debit comes from the available bucket.
   */
  readonly debitsLocked: boolean;
  /** The plan's word (above). */
  readonly plan: LedgerPlanWord;
}

const USER = 'user';
const TREASURY = 'treasury';
const COLLATERAL = 'market_collateral';
const MM_FUNDS = 'market_maker_funds';

/**
 * Every type's rule (ADR-0107 결정 2 #73 1항, ADR-0109 결정 2). Adding a type adds its row here,
 * its value in LEDGER_ENTRY_TYPES and in migration SQL that replaces
 * `ledger_entry_direction_allowed`; a type that credits a user's account also needs an ADR and a
 * place in USER_INFLOW_TYPES (3항).
 */
export const LEDGER_ENTRY_RULES: { readonly [T in LedgerEntryType]: LedgerEntryRule } = {
  START_GRANT: {
    flow: 'mint',
    pairs: [[null, USER]],
    market: 'none',
    debitsLocked: false,
    plan: '발행',
  },
  TREASURY_MINT: {
    flow: 'mint',
    pairs: [[null, TREASURY]],
    market: 'none',
    debitsLocked: false,
    plan: '발행',
  },
  BOT_ALLOCATION: {
    flow: 'move',
    pairs: [[TREASURY, MM_FUNDS]],
    market: 'required',
    debitsLocked: false,
    plan: '운영금 이전',
  },
  BOT_RECALL: {
    flow: 'move',
    pairs: [[MM_FUNDS, TREASURY]],
    market: 'required',
    debitsLocked: false,
    plan: '운영금 이전',
  },
  PAIR_MINT_COLLATERAL: {
    flow: 'move',
    pairs: [
      [USER, COLLATERAL],
      [MM_FUNDS, COLLATERAL],
    ],
    market: 'required',
    debitsLocked: true,
    plan: '담보',
  },
  PAIR_BURN_RETURN: {
    flow: 'move',
    pairs: [[COLLATERAL, MM_FUNDS]],
    market: 'required',
    debitsLocked: false,
    plan: '담보',
  },
  TRADE_FILL: {
    flow: 'move',
    pairs: [
      [USER, USER],
      [USER, MM_FUNDS],
      [MM_FUNDS, USER],
    ],
    market: 'required',
    debitsLocked: true,
    plan: '거래',
  },
  SETTLEMENT_PAYOUT: {
    flow: 'move',
    pairs: [
      [COLLATERAL, USER],
      [COLLATERAL, MM_FUNDS],
    ],
    market: 'required',
    debitsLocked: false,
    plan: '정산',
  },
  CLOSURE_FORFEIT: {
    flow: 'burn',
    pairs: [[USER, null]],
    market: 'none',
    debitsLocked: false,
    plan: '소각',
  },
  RECONCILIATION_CORRECTION: {
    flow: 'move',
    pairs: [
      [TREASURY, USER],
      [TREASURY, COLLATERAL],
      [COLLATERAL, TREASURY],
      [TREASURY, MM_FUNDS],
      [MM_FUNDS, TREASURY],
    ],
    market: 'by_account',
    debitsLocked: false,
    plan: '대사 정정',
  },
  DEPOSIT: {
    flow: 'mint',
    pairs: [[null, USER]],
    market: 'none',
    debitsLocked: false,
    plan: '보존',
  },
  BONUS: { flow: 'mint', pairs: [[null, USER]], market: 'none', debitsLocked: false, plan: '보존' },
  PAYMENT_CANCEL: {
    flow: 'burn',
    pairs: [[USER, null]],
    market: 'none',
    debitsLocked: false,
    plan: '보존',
  },
  PAYMENT_CANCEL_REVERSAL: {
    flow: 'mint',
    pairs: [[null, USER]],
    market: 'none',
    debitsLocked: false,
    plan: '보존',
  },
};

/** Whether `type` may move Coin from a `fromKind` account to a `toKind` one (null: mint/burn). */
export function isLedgerDirectionAllowed(
  type: LedgerEntryType,
  fromKind: LedgerSide,
  toKind: LedgerSide,
): boolean {
  return LEDGER_ENTRY_RULES[type].pairs.some(([from, to]) => from === fromKind && to === toKind);
}

const typesWhere = (keep: (rule: LedgerEntryRule) => boolean): LedgerEntryType[] =>
  LEDGER_ENTRY_TYPES.filter((type) => keep(LEDGER_ENTRY_RULES[type]));

/** The types that create Coin (no from-account): #93's 발행 total. */
export const LEDGER_MINT_TYPES: readonly LedgerEntryType[] = typesWhere((r) => r.flow === 'mint');
/** The types that destroy Coin (no to-account): #93's 소각 total. */
export const LEDGER_BURN_TYPES: readonly LedgerEntryType[] = typesWhere((r) => r.flow === 'burn');
/** The kept paid-Coin and coupon types, inactive while sales are closed (#73 2항, D9). */
export const PRESERVED_LEDGER_TYPES: readonly LedgerEntryType[] = typesWhere(
  (r) => r.plan === '보존',
);
/** The grant sources, apart from trading (#116 수용 기준): 재지급 and 보상 join them (#74, #144). */
export const LEDGER_GRANT_TYPES = ['START_GRANT'] as const satisfies readonly LedgerEntryType[];

/**
 * 사용자 계정 유입 (ADR-0107 결정 2 #73 3항): the only types that may increase a user's ledger
 * account — the grants (시작 지급 now; 재지급 and 판정 오류 보상 when #74 and #144 add them), 체결
 * 대금 and 정산 지급. Written out by hand on purpose: 목록을 바꾸려면 ADR이 필요하다. The shared
 * test fails when any type's rule credits a user's account and the type is in neither this list
 * nor USER_INFLOW_EXCEPTIONS.
 */
export const USER_INFLOW_TYPES = [
  'START_GRANT',
  'TRADE_FILL',
  'SETTLEMENT_PAYOUT',
] as const satisfies readonly LedgerEntryType[];

/**
 * The exceptions to the closed list (3항): the kept paid-Coin and coupon mints, which nothing
 * writes while sales are closed (2항), and 대사 정정, which refers to an `audit_failures` row and
 * is approved by another admin (10항).
 */
export const USER_INFLOW_EXCEPTIONS = [
  'DEPOSIT',
  'BONUS',
  'PAYMENT_CANCEL_REVERSAL',
  'RECONCILIATION_CORRECTION',
] as const satisfies readonly LedgerEntryType[];

/**
 * The types a person's ledger can show: those with a user account on a side of some pair. What
 * `GET /me/ledger` answers with (`memberLedgerEntryTypeSchema`), so no treasury or bot type
 * reaches a member's response or the OpenAPI.
 */
export const MEMBER_LEDGER_ENTRY_TYPES = [
  'START_GRANT',
  'PAIR_MINT_COLLATERAL',
  'TRADE_FILL',
  'SETTLEMENT_PAYOUT',
  'CLOSURE_FORFEIT',
  'RECONCILIATION_CORRECTION',
  'DEPOSIT',
  'BONUS',
  'PAYMENT_CANCEL',
  'PAYMENT_CANCEL_REVERSAL',
] as const satisfies readonly LedgerEntryType[];
export type MemberLedgerEntryType = (typeof MEMBER_LEDGER_ENTRY_TYPES)[number];
export const memberLedgerEntryTypeSchema = z.enum(MEMBER_LEDGER_ENTRY_TYPES);

/** What a caller asks one event to be, before any account is looked up. */
export interface LedgerEntryShape {
  type: LedgerEntryType;
  amountCoin: bigint;
  fromKind: LedgerSide;
  toKind: LedgerSide;
  /** The event's market, or null. */
  marketId: string | null;
  /** The market of each side that is a market's account (collateral, 마켓메이커 자금), else null. */
  fromMarketId?: string | null;
  toMarketId?: string | null;
  /** Which bucket of the from-account pays; `locked` only where the rule's `debitsLocked`. */
  debitFrom?: 'available' | 'locked';
}

const isMarketKind = (kind: LedgerSide): boolean => kind === COLLATERAL || kind === MM_FUNDS;

/**
 * Why `shape` is not an event its type allows, or null when it is: the (from, to) pair, a
 * positive amount, the market (the rule's `market`, and every market-scoped side naming the
 * event's market), and `debitFrom: 'locked'` only where the rule allows it. The write API refuses
 * on it before it locks anything; the database checks the same at INSERT.
 */
export function ledgerEntryShapeError(shape: LedgerEntryShape): string | null {
  const rule = LEDGER_ENTRY_RULES[shape.type];
  if (shape.amountCoin <= 0n) return `${shape.type} needs a positive amount`;
  if (!isLedgerDirectionAllowed(shape.type, shape.fromKind, shape.toKind)) {
    return `${shape.type} does not move Coin from ${shape.fromKind ?? 'mint'} to ${shape.toKind ?? 'burn'}`;
  }
  const marketSide = isMarketKind(shape.fromKind) || isMarketKind(shape.toKind);
  const wantsMarket = rule.market === 'required' || (rule.market === 'by_account' && marketSide);
  if (wantsMarket && shape.marketId === null) return `${shape.type} names its market`;
  if (!wantsMarket && shape.marketId !== null) return `${shape.type} names no market`;
  for (const [kind, marketId] of [
    [shape.fromKind, shape.fromMarketId ?? null],
    [shape.toKind, shape.toMarketId ?? null],
  ] as const) {
    if (isMarketKind(kind) && marketId !== shape.marketId) {
      return `${shape.type}: a ${kind} account belongs to the event's own market`;
    }
  }
  if (shape.debitFrom === 'locked' && !rule.debitsLocked) {
    return `${shape.type} is never paid from a lock`;
  }
  return null;
}
