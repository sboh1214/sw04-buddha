import { describe, expect, it } from 'vitest';
import { LEDGER_ACCOUNT_KINDS, LEDGER_ENTRY_TYPES, type LedgerEntryType } from './enums.js';
import {
  isLedgerDirectionAllowed,
  LEDGER_BURN_TYPES,
  LEDGER_ENTRY_RULES,
  LEDGER_GRANT_TYPES,
  LEDGER_MINT_TYPES,
  ledgerEntryShapeError,
  MEMBER_LEDGER_ENTRY_TYPES,
  memberLedgerEntryTypeSchema,
  PRESERVED_LEDGER_TYPES,
  USER_INFLOW_EXCEPTIONS,
  USER_INFLOW_TYPES,
  type LedgerSide,
} from './ledger.js';

const marketId = '3f1a5b6c-1111-4222-8333-444455556666';
const SIDES: readonly LedgerSide[] = [null, ...LEDGER_ACCOUNT_KINDS];

/** Every (type, from, to) the rules allow. */
function allowed(): [LedgerEntryType, LedgerSide, LedgerSide][] {
  return LEDGER_ENTRY_TYPES.flatMap((type) =>
    SIDES.flatMap((from) =>
      SIDES.filter((to) => isLedgerDirectionAllowed(type, from, to)).map(
        (to) => [type, from, to] as [LedgerEntryType, LedgerSide, LedgerSide],
      ),
    ),
  );
}

describe('ledger entry rules (#116, ADR-0107 결정 2 #73)', () => {
  it('gives every type exactly one rule, with at least one pair', () => {
    expect(Object.keys(LEDGER_ENTRY_RULES).sort()).toEqual([...LEDGER_ENTRY_TYPES].sort());
    for (const type of LEDGER_ENTRY_TYPES) {
      expect(LEDGER_ENTRY_RULES[type].pairs.length, type).toBeGreaterThan(0);
    }
  });

  it('agrees with each flow: a mint has no from-side, a burn no to-side, a move both', () => {
    for (const type of LEDGER_ENTRY_TYPES) {
      const { flow, pairs } = LEDGER_ENTRY_RULES[type];
      for (const [from, to] of pairs) {
        expect([from === null, to === null], type).toEqual([flow === 'mint', flow === 'burn']);
      }
    }
    expect(isLedgerDirectionAllowed('START_GRANT', null, null)).toBe(false);
  });

  it('moves Coin between two holders only through a fill (no direct send path)', () => {
    // #116 수용 기준: 체결 외의 사용자 → 사용자 경로는 없다.
    const userToUser = allowed().filter(([, from, to]) => from === 'user' && to === 'user');
    expect(userToUser.map(([type]) => type)).toEqual(['TRADE_FILL']);
    expect(isLedgerDirectionAllowed('TRADE_FILL', 'market_maker_funds', 'market_maker_funds')).toBe(
      false,
    );
  });

  it('never returns a burned pair to a user, and never takes a user’s Coin by correction', () => {
    // #177 6항: 같은 소유자의 쌍 소각은 봇 자동 소각뿐; #73 10항: 정정은 사용자 잔고를 줄이지 않고
    // 지급한 정산을 되돌리지 않는다 (N03 §7).
    expect(LEDGER_ENTRY_RULES.PAIR_BURN_RETURN.pairs).toEqual([
      ['market_collateral', 'market_maker_funds'],
    ]);
    const correction = LEDGER_ENTRY_RULES.RECONCILIATION_CORRECTION.pairs;
    expect(correction.filter(([from]) => from === 'user')).toEqual([]);
    expect(isLedgerDirectionAllowed('RECONCILIATION_CORRECTION', 'market_collateral', 'user')).toBe(
      false,
    );
    // Its counter-account is always the operating treasury.
    for (const [from, to] of correction) expect([from, to]).toContain('treasury');
  });

  it('lets only a fill or a pair mint be paid from a lock (#177 3항)', () => {
    expect(LEDGER_ENTRY_TYPES.filter((type) => LEDGER_ENTRY_RULES[type].debitsLocked)).toEqual([
      'PAIR_MINT_COLLATERAL',
      'TRADE_FILL',
    ]);
  });

  it('lets only these types increase a user’s ledger account: the closed list (#73 3항)', () => {
    // 목록 밖 유형이 사용자 계정을 늘리면 실패한다: a new type that credits a user's account
    // fails here until an ADR puts it in USER_INFLOW_TYPES (or, for an exception, in
    // USER_INFLOW_EXCEPTIONS).
    const credits = [
      ...new Set(allowed().flatMap(([type, , to]) => (to === 'user' ? [type] : []))),
    ];
    const listed: readonly string[] = [...USER_INFLOW_TYPES, ...USER_INFLOW_EXCEPTIONS];
    expect(credits.filter((type) => !listed.includes(type))).toEqual([]);
    expect([...credits].sort()).toEqual([...listed].sort());
    expect(USER_INFLOW_TYPES).toEqual(['START_GRANT', 'TRADE_FILL', 'SETTLEMENT_PAYOUT']);
    expect(USER_INFLOW_EXCEPTIONS).toEqual([
      'DEPOSIT',
      'BONUS',
      'PAYMENT_CANCEL_REVERSAL',
      'RECONCILIATION_CORRECTION',
    ]);
    // The exceptions are the kept paid-Coin and coupon mints and 대사 정정, nothing else.
    expect(
      USER_INFLOW_EXCEPTIONS.filter(
        (type) => !PRESERVED_LEDGER_TYPES.includes(type) && type !== 'RECONCILIATION_CORRECTION',
      ),
    ).toEqual([]);
  });

  it('names the mints and the burns #93 totals, and the grant sources', () => {
    expect(LEDGER_MINT_TYPES).toEqual([
      'START_GRANT',
      'TREASURY_MINT',
      'DEPOSIT',
      'BONUS',
      'PAYMENT_CANCEL_REVERSAL',
    ]);
    // 실제 소각은 탈퇴 소멸 하나 (#73 16항), plus the kept payment cancel (2항).
    expect(LEDGER_BURN_TYPES).toEqual(['CLOSURE_FORFEIT', 'PAYMENT_CANCEL']);
    expect(PRESERVED_LEDGER_TYPES).toEqual([
      'DEPOSIT',
      'BONUS',
      'PAYMENT_CANCEL',
      'PAYMENT_CANCEL_REVERSAL',
    ]);
    expect(LEDGER_GRANT_TYPES).toEqual(['START_GRANT']);
  });

  it('shows a member exactly the types a user account takes part in', () => {
    const withUser = LEDGER_ENTRY_TYPES.filter((type) =>
      LEDGER_ENTRY_RULES[type].pairs.some(([from, to]) => from === 'user' || to === 'user'),
    );
    expect([...MEMBER_LEDGER_ENTRY_TYPES]).toEqual(withUser);
    expect(memberLedgerEntryTypeSchema.safeParse('TREASURY_MINT').success).toBe(false);
    expect(memberLedgerEntryTypeSchema.safeParse('BOT_ALLOCATION').success).toBe(false);
  });

  it('maps every word of the plan (N01 §2·§9) to its types', () => {
    const byWord = (word: string) =>
      LEDGER_ENTRY_TYPES.filter((type) => LEDGER_ENTRY_RULES[type].plan === word);
    expect(byWord('발행')).toEqual(['START_GRANT', 'TREASURY_MINT']);
    expect(byWord('운영금 이전')).toEqual(['BOT_ALLOCATION', 'BOT_RECALL']);
    expect(byWord('담보')).toEqual(['PAIR_MINT_COLLATERAL', 'PAIR_BURN_RETURN']);
    expect(byWord('거래')).toEqual(['TRADE_FILL']);
    expect(byWord('정산')).toEqual(['SETTLEMENT_PAYOUT']);
    expect(byWord('소각')).toEqual(['CLOSURE_FORFEIT']);
    expect(byWord('대사 정정')).toEqual(['RECONCILIATION_CORRECTION']);
    // 수수료: none while fees are 0 (15항); 보상: #144 adds it.
    expect(LEDGER_ENTRY_TYPES.filter((type) => /FEE|REWARD|TRANSFER/.test(type))).toEqual([]);
  });
});

describe('ledgerEntryShapeError', () => {
  const market = marketId;
  const other = '3f1a5b6c-1111-4222-8333-444455556667';

  it('accepts each type’s own shape', () => {
    expect(
      ledgerEntryShapeError({
        type: 'START_GRANT',
        amountCoin: 1000n,
        fromKind: null,
        toKind: 'user',
        marketId: null,
      }),
    ).toBeNull();
    expect(
      ledgerEntryShapeError({
        type: 'TRADE_FILL',
        amountCoin: 60n,
        fromKind: 'user',
        toKind: 'market_maker_funds',
        marketId: market,
        toMarketId: market,
        debitFrom: 'locked',
      }),
    ).toBeNull();
    expect(
      ledgerEntryShapeError({
        type: 'RECONCILIATION_CORRECTION',
        amountCoin: 5n,
        fromKind: 'treasury',
        toKind: 'user',
        marketId: null,
      }),
    ).toBeNull();
    expect(
      ledgerEntryShapeError({
        type: 'RECONCILIATION_CORRECTION',
        amountCoin: 5n,
        fromKind: 'market_collateral',
        toKind: 'treasury',
        marketId: market,
        fromMarketId: market,
      }),
    ).toBeNull();
  });

  it.each([
    [
      'a zero amount',
      { type: 'START_GRANT', amountCoin: 0n, fromKind: null, toKind: 'user', marketId: null },
    ],
    [
      'a pair the type does not take',
      { type: 'BOT_ALLOCATION', amountCoin: 1n, fromKind: 'treasury', toKind: 'user', marketId },
    ],
    [
      'a market event without its market',
      {
        type: 'TRADE_FILL',
        amountCoin: 1n,
        fromKind: 'user',
        toKind: 'user',
        marketId: null,
      },
    ],
    [
      'a market on an event of none',
      { type: 'START_GRANT', amountCoin: 1n, fromKind: null, toKind: 'user', marketId },
    ],
    [
      'a correction of a user without a market, given one',
      {
        type: 'RECONCILIATION_CORRECTION',
        amountCoin: 1n,
        fromKind: 'treasury',
        toKind: 'user',
        marketId,
      },
    ],
    [
      'another market’s collateral',
      {
        type: 'PAIR_MINT_COLLATERAL',
        amountCoin: 100n,
        fromKind: 'user',
        toKind: 'market_collateral',
        marketId,
        toMarketId: other,
      },
    ],
    [
      'a lock paying a settlement',
      {
        type: 'SETTLEMENT_PAYOUT',
        amountCoin: 100n,
        fromKind: 'market_collateral',
        toKind: 'user',
        marketId,
        fromMarketId: marketId,
        debitFrom: 'locked',
      },
    ],
  ] as const)('refuses %s', (_name, shape) => {
    expect(ledgerEntryShapeError(shape)).toEqual(expect.any(String));
  });
});
