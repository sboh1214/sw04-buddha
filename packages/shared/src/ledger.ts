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
 * - 발행: START_GRANT (mint → user), REGRANT (재지급, mint → user, #74, ADR-0155),
 *   JUDGEMENT_COMPENSATION (판정 오류 보상, mint → user naming its market, #144, ADR-0166) and
 *   TREASURY_MINT (mint → treasury);
 * - 운영금 이전: BOT_ALLOCATION (treasury → 마켓메이커 자금) and BOT_RECALL (back);
 * - 지원 (N01 §9): BOT_ALLOCATION — a recall is 운영금 이전, not 지원 — and REGRANT (#74; ADR-0107
 *   결정 2 #73 1항);
 * - 담보: PAIR_MINT_COLLATERAL (buyer → collateral), released by PAIR_BURN_RETURN (collateral →
 *   the bot's funds; a user's pair is never burned, #177 6항);
 * - 거래: TRADE_FILL (buyer → seller), the one move between two holders — no user sends Coin to
 *   another any other way;
 * - 수수료: none while fees are 0 (15항, #91): no FEE type and no fee row;
 * - 정산: SETTLEMENT_PAYOUT (collateral → holder, VOID's 50·50 too);
 * - 보상: 판정 오류 보상 (#144, ADR-0166) — JUDGEMENT_COMPENSATION, whose plan word is 발행 (#73
 *   8항 "받는 계정에 신규 발행한다"): 보상 is the source's name, which the wallet's label carries
 *   ('판정 오류 보상', 144-10), not a LedgerPlanWord of its own;
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
  /** 재지급 (#74, ADR-0155): a new issue straight into the applying member's account. */
  REGRANT: {
    flow: 'mint',
    pairs: [[null, USER]],
    market: 'none',
    debitsLocked: false,
    plan: '발행',
  },
  /**
   * 판정 오류 보상 (#144, ADR-0166; #73 8항): a new issue straight into the compensated account,
   * naming the market it compensates (144-12's 시장 링크 and the wallet's `?marketId=` filter read
   * `ledger_entries.market_id`; migration 0081 lets this type name one, as TRADE_FILL does).
   */
  JUDGEMENT_COMPENSATION: {
    flow: 'mint',
    pairs: [[null, USER]],
    market: 'required',
    debitsLocked: false,
    plan: '발행',
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
/**
 * The grant sources, apart from trading (#116 수용 기준): 시작 지급, 재지급 (#74, ADR-0155) and 판정
 * 오류 보상 (#144, ADR-0166).
 */
export const LEDGER_GRANT_TYPES = [
  'START_GRANT',
  'REGRANT',
  'JUDGEMENT_COMPENSATION',
] as const satisfies readonly LedgerEntryType[];

/**
 * 사용자 계정 유입 (ADR-0107 결정 2 #73 3항): the only types that may increase a user's ledger
 * account — the grants (시작 지급, 재지급 since #74 by ADR-0155, 판정 오류 보상 since #144 by
 * ADR-0166 — "시작 지급·재지급·판정 오류 보상 셋뿐인 닫힌 목록"), 체결 대금 and 정산 지급. Written
 * out by hand on purpose: 목록을 바꾸려면 ADR이 필요하다. The shared test fails when any type's rule
 * credits a user's account and the type is in neither this list nor USER_INFLOW_EXCEPTIONS.
 */
export const USER_INFLOW_TYPES = [
  'START_GRANT',
  'REGRANT',
  'JUDGEMENT_COMPENSATION',
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
 * 사용자 계정 차감 (#144 AC 3, ADR-0166; N03 §7 "자동 회수·음수 잔액을 만들지 않는다"): the only
 * types whose rule takes Coin out of a user's ledger account — a buyer's collateral and payment
 * (paid from the order's lock), 탈퇴 소멸 and the kept payment cancel. None is written because of a
 * judgement or a settlement: no type claws a paid settlement or a compensation back, and 대사 정정
 * only ever credits a user. Written out by hand: the shared test fails when a type's rule debits a
 * user's account and the type is not here, so a recovery path cannot be added without an ADR.
 */
export const USER_DEBIT_TYPES = [
  'PAIR_MINT_COLLATERAL',
  'TRADE_FILL',
  'CLOSURE_FORFEIT',
  'PAYMENT_CANCEL',
] as const satisfies readonly LedgerEntryType[];

/**
 * The types a person's ledger can show: those with a user account on a side of some pair. What
 * `GET /me/ledger` reads (LEDGER_KIND_SOURCES below maps each, with the person's side, to the
 * kind it answers with), so no treasury or bot type reaches a member's response or the OpenAPI.
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
  'REGRANT',
  'JUDGEMENT_COMPENSATION',
] as const satisfies readonly LedgerEntryType[];
export type MemberLedgerEntryType = (typeof MEMBER_LEDGER_ENTRY_TYPES)[number];
export const memberLedgerEntryTypeSchema = z.enum(MEMBER_LEDGER_ENTRY_TYPES);

/** The side of an event a person's account stands on: `from` pays, `to` is paid. */
export type LedgerAccountSide = 'from' | 'to';

/**
 * What the wallet calls an event of a person's ledger (#69, ADR-0144; ADR-0135 H1·H5·결과 4): the
 * stored type and the side the person's account stands on, one kind for each pair of them. The
 * first seven, in this order, are the wallet's filter (LEDGER_FILTER_KINDS); the kept paid-Coin
 * and coupon types and 탈퇴 소멸 are kinds too — the kept payment answers carry the same entry — but
 * no filter offers them. 재지급 (#74, ADR-0155) came after the first five as the sixth, 판정 오류
 * 보상 (#144, ADR-0166; 144-10 "별도 출처와 유형 필터") after it as the seventh.
 */
export const LEDGER_ENTRY_KINDS = [
  'BUY_FILL',
  'SELL_FILL',
  'SETTLEMENT_PAYOUT',
  'START_GRANT',
  'RECONCILIATION_CORRECTION',
  'REGRANT',
  'JUDGEMENT_COMPENSATION',
  'CLOSURE_FORFEIT',
  'DEPOSIT',
  'BONUS',
  'PAYMENT_CANCEL',
  'PAYMENT_CANCEL_REVERSAL',
] as const;
export type LedgerEntryKind = (typeof LEDGER_ENTRY_KINDS)[number];
export const ledgerEntryKindSchema = z.enum(LEDGER_ENTRY_KINDS);

/** One (type, side) a kind is made of. */
export interface LedgerKindSource {
  readonly type: MemberLedgerEntryType;
  readonly side: LedgerAccountSide;
}

/**
 * The one table of kinds (#69, ADR-0144): the answer's `kind`, the filter's SQL and the wallet's
 * labels all come from it. 매수 체결 is the buyer's Coin of a fill — a pair mint's collateral and a
 * trade's payment alike, which the answer never tells apart (ADR-0135 결과 4, ADR-0112 결정 2);
 * 매도 체결 the seller's. Every other kind is its own type, on the side a user account takes in
 * the type's rule (LEDGER_ENTRY_RULES). Each kind stands on one side, so the filter reads one of
 * the account's two indexes; the shared test keeps the table equal to the rules.
 */
export const LEDGER_KIND_SOURCES: { readonly [K in LedgerEntryKind]: readonly LedgerKindSource[] } =
  {
    BUY_FILL: [
      { type: 'PAIR_MINT_COLLATERAL', side: 'from' },
      { type: 'TRADE_FILL', side: 'from' },
    ],
    SELL_FILL: [{ type: 'TRADE_FILL', side: 'to' }],
    SETTLEMENT_PAYOUT: [{ type: 'SETTLEMENT_PAYOUT', side: 'to' }],
    START_GRANT: [{ type: 'START_GRANT', side: 'to' }],
    RECONCILIATION_CORRECTION: [{ type: 'RECONCILIATION_CORRECTION', side: 'to' }],
    REGRANT: [{ type: 'REGRANT', side: 'to' }],
    JUDGEMENT_COMPENSATION: [{ type: 'JUDGEMENT_COMPENSATION', side: 'to' }],
    CLOSURE_FORFEIT: [{ type: 'CLOSURE_FORFEIT', side: 'from' }],
    DEPOSIT: [{ type: 'DEPOSIT', side: 'to' }],
    BONUS: [{ type: 'BONUS', side: 'to' }],
    PAYMENT_CANCEL: [{ type: 'PAYMENT_CANCEL', side: 'from' }],
    PAYMENT_CANCEL_REVERSAL: [{ type: 'PAYMENT_CANCEL_REVERSAL', side: 'to' }],
  };

/**
 * The kind of an event of `type` seen from the `side` a person's account stands on. Throws for a
 * pair no rule lets a user account take (START_GRANT from a person, a treasury type …): a broken
 * row, never a kind made up for it.
 */
export function ledgerEntryKind(type: LedgerEntryType, side: LedgerAccountSide): LedgerEntryKind {
  const kind = LEDGER_ENTRY_KINDS.find((candidate) =>
    LEDGER_KIND_SOURCES[candidate].some((source) => source.type === type && source.side === side),
  );
  if (kind === undefined) throw new Error(`no ledger kind for ${type} on the ${side} side`);
  return kind;
}

/**
 * The wallet's kind filter (ADR-0135 H5): '전체' is no value, then these seven in this order —
 * 재지급 (#74, ADR-0155) the sixth, 판정 오류 보상 (#144, ADR-0166; 144-10) the seventh.
 */
export const LEDGER_FILTER_KINDS = [
  'BUY_FILL',
  'SELL_FILL',
  'SETTLEMENT_PAYOUT',
  'START_GRANT',
  'RECONCILIATION_CORRECTION',
  'REGRANT',
  'JUDGEMENT_COMPENSATION',
] as const satisfies readonly LedgerEntryKind[];
export type LedgerFilterKind = (typeof LEDGER_FILTER_KINDS)[number];

/**
 * The kinds no filter offers — listed under '전체' only: the kept paid-Coin and coupon kinds,
 * inactive while sales are closed (D4·D13), and 탈퇴 소멸, which no open account holds. A kind
 * added to LEDGER_ENTRY_KINDS lands in the filter unless it is named here (the shared test).
 */
export const LEDGER_FILTER_EXCLUDED = [
  'CLOSURE_FORFEIT',
  'DEPOSIT',
  'BONUS',
  'PAYMENT_CANCEL',
  'PAYMENT_CANCEL_REVERSAL',
] as const satisfies readonly LedgerEntryKind[];

/**
 * What one kind reads (#69, ADR-0144 결정 2-3): the one side of the person's account it stands
 * on and its types there. `GET /me/ledger?kind=` turns it into `<side>_account_id = $account AND
 * type IN (…)`. Throws for a kind whose sources stand on two sides, which no kind does.
 */
export function ledgerKindBranch(kind: LedgerEntryKind): {
  side: LedgerAccountSide;
  types: MemberLedgerEntryType[];
} {
  const sources = LEDGER_KIND_SOURCES[kind];
  const side = sources[0]!.side;
  if (sources.some((source) => source.side !== side)) {
    throw new Error(`ledger kind ${kind} stands on both sides`);
  }
  return { side, types: sources.map((source) => source.type) };
}

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
