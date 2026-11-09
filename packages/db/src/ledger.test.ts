import { randomUUID } from 'node:crypto';
import {
  isLedgerDirectionAllowed,
  LEDGER_ACCOUNT_KINDS,
  LEDGER_ENTRY_RULES,
  LEDGER_ENTRY_TYPES,
  type LedgerSide,
} from '@buddha/shared';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isHumanAccountSql } from './account-types.js';
import { burnMarketMakerPairs } from './contracts.js';
import {
  ensureLedgerAccount,
  findLedgerAccount,
  findLedgerEntry,
  LedgerEntryError,
  ledgerKeys,
  lockCoin,
  lockLedgerAccounts,
  recordLedgerEntry,
  releaseCoin,
  type LedgerAccountRef,
  type LedgerEntryInput,
} from './ledger.js';
import { balances, ledgerAccounts, ledgerEntries } from './schema/index.js';
import {
  closeAccount,
  createMarket,
  createMarketMakerAccount,
  createUser,
} from './test/factories.js';
import { connectTestDb, hasTestDb, testDbUrls, type TestDb } from './test/harness.js';
import { createFillRecord, priceAndQtyOf } from './test/orders.js';
import {
  fundMarketMakerFunds,
  ledgerAccountBalance,
  ledgerOf,
  ledgerSupply,
  mintTestPairs,
  recordLegacyCorrectionForTest,
  withLedgerGuardsOff,
} from './test/ledger.js';
import { waitForLockWaiter } from './test/wait.js';

/** Postgres SQLSTATE, wrapped (drizzle) or bare. */
function sqlState(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.cause?.code ?? e?.code;
}

/** The constraint a refusal names. */
function sqlConstraint(error: unknown): string | undefined {
  const e = error as { constraint?: string; cause?: { constraint?: string } } | null;
  return e?.cause?.constraint ?? e?.constraint;
}

/** The Postgres message (a trigger's RAISE), wrapped or bare. */
function errorMessage(error: unknown): string {
  const e = error as { message?: string; cause?: { message?: string } } | null;
  return e?.cause?.message ?? e?.message ?? '';
}

const codeOf = (error: unknown) => (error instanceof LedgerEntryError ? error.code : undefined);

const SIDES: readonly LedgerSide[] = [null, ...LEDGER_ACCOUNT_KINDS];

/**
 * The ledger write API and migration 0060's guards (#116, ADR-0109; ADR-0107 결정 2 #73): every
 * type's directions, the keys that make a source one event, the locks that keep a balance from
 * going below 0, the UPDATE and COMMIT checks that no balance moves without its event (and that an
 * account whose total left its ledger keeps that gap and its events, ADR-0107 결정 2 #73 10항), the
 * records that never change, and the conservation of Coin across every kind of event.
 */
describe.skipIf(!hasTestDb())('the ledger (#116, docker test profile)', () => {
  let t: TestDb;
  let migrate: Client;

  beforeAll(async () => {
    t = await connectTestDb();
    migrate = new Client({ connectionString: testDbUrls()!.migrateUrl });
    await migrate.connect();
  });
  afterAll(async () => {
    await migrate?.end();
    await t?.close();
  });
  beforeEach(async () => {
    await t.reset();
  });

  type RecordInput = Omit<LedgerEntryInput, 'idempotencyKey' | 'refType' | 'refId'> &
    Partial<Pick<LedgerEntryInput, 'idempotencyKey' | 'refType' | 'refId'>>;

  /**
   * The fill a TRADE_FILL or PAIR_MINT_COLLATERAL refers to, as migration 0062 binds them (#119):
   * a fill record (`createFillRecord`) of the event's owners — a trade from its buyer to its
   * seller, a pair mint's YES leg from its payer, the NO buyer a fresh member — at a price × qty of
   * its amount, with its ref and key. Null for an event no fill can stand for (no market, one
   * owner, an amount no price × qty makes): the write API or 0060's trigger refuses it first.
   */
  async function fillRefOf(
    input: RecordInput,
  ): Promise<Pick<LedgerEntryInput, 'refType' | 'refId' | 'idempotencyKey'> | null> {
    if (input.type !== 'TRADE_FILL' && input.type !== 'PAIR_MINT_COLLATERAL') return null;
    const ownerOf = async (ref: LedgerAccountRef | null) =>
      ref?.kind === 'user'
        ? ref.userId
        : ref?.kind === 'market_maker_funds'
          ? await createMarketMakerAccount(t.db)
          : null;
    let size: { priceCoin: number; qty: number };
    try {
      size = priceAndQtyOf(input.amountCoin);
    } catch {
      return null;
    }
    const payer = await ownerOf(input.from);
    if (input.type === 'TRADE_FILL') {
      const payee = await ownerOf(input.to);
      if (!payer || !payee || payer === payee || !input.marketId) return null;
      const { fill } = await createFillRecord(t.db, {
        marketId: input.marketId,
        incomingOwnerId: payer,
        restingOwnerId: payee,
        kind: 'trade',
        ...size,
      });
      return {
        refType: 'fill',
        refId: String(fill.id),
        idempotencyKey: ledgerKeys.fill(String(fill.id)),
      };
    }
    if (!payer || input.to?.kind !== 'market_collateral') return null;
    const { fill } = await createFillRecord(t.db, {
      marketId: input.to.marketId,
      incomingOwnerId: payer,
      restingOwnerId: (await createUser(t.db)).user.id,
      ...size,
    });
    const refId = String(fill.id);
    return { refType: 'fill', refId, idempotencyKey: ledgerKeys.fillLeg(refId, 'YES') };
  }

  /**
   * One event in a transaction of its own, under a fresh key unless one is given — a fill event
   * against its own fill record (`fillRefOf`) unless its ref or key is given.
   */
  const record = async (input: RecordInput) => {
    const bound =
      input.refId === undefined && input.idempotencyKey === undefined
        ? await fillRefOf(input)
        : null;
    return t.db.transaction((tx) =>
      recordLedgerEntry(tx, {
        refType: 'fill',
        refId: randomUUID(),
        idempotencyKey: randomUUID(),
        ...bound,
        ...input,
      }),
    );
  };

  /** A ledger account's balance row, made if new. */
  async function balanceOf(ref: LedgerAccountRef) {
    const account = await t.db.transaction((tx) => ensureLedgerAccount(tx, ref));
    const [row] = await t.db.select().from(balances).where(eq(balances.accountId, account.id));
    return row!;
  }

  /** Gives `ref` `amountCoin` the way production does for its kind. */
  async function fund(ref: LedgerAccountRef, amountCoin: bigint): Promise<void> {
    switch (ref.kind) {
      case 'user':
        await record({
          type: 'START_GRANT',
          amountCoin,
          from: null,
          to: ref,
          refType: 'start_grant',
        });
        return;
      case 'treasury':
        await record({ type: 'TREASURY_MINT', amountCoin, from: null, to: ref });
        return;
      case 'market_maker_funds':
        await fundMarketMakerFunds(t.db, ref.marketId, amountCoin);
        return;
      case 'market_collateral': {
        const { user: payer } = await createUser(t.db, { balanceCoin: amountCoin });
        await record({
          type: 'PAIR_MINT_COLLATERAL',
          amountCoin,
          from: { kind: 'user', userId: payer.id },
          to: ref,
        });
      }
    }
  }

  /**
   * Every account's total and its ledger-total copy (`ledger_coin`) against its ledger: Σ in − Σ
   * out, per ledger account — the accounts where either differs.
   */
  async function accountsAgainstLedger() {
    const { rows } = await t.db.execute<{
      id: string;
      total: string;
      carried: string;
      ledger: string;
    }>(sql`
      SELECT a.id::text AS id, (b.available_coin + b.locked_coin)::text AS total,
        b.ledger_coin::text AS carried,
        (coalesce((SELECT sum(e.amount_coin) FROM ledger_entries e WHERE e.to_account_id = a.id), 0)
         - coalesce((SELECT sum(e.amount_coin) FROM ledger_entries e
                      WHERE e.from_account_id = a.id), 0))::text AS ledger
      FROM ledger_accounts a JOIN balances b ON b.account_id = a.id`);
    return rows.filter((row) => row.total !== row.ledger || row.carried !== row.ledger);
  }

  describe('directions', () => {
    it('agrees with LEDGER_ENTRY_RULES for every type and every pair of sides (drift)', async () => {
      // The SQL copy of the pairs (`ledger_entry_direction_allowed`, migration 0060) and the shared
      // table answer alike for each of the 14 × 5 × 5 combinations, mint and burn sides included.
      const combos = LEDGER_ENTRY_TYPES.flatMap((type) =>
        SIDES.flatMap((from) => SIDES.map((to) => [type, from, to] as const)),
      );
      const values = sql.join(
        combos.map(
          ([type, from, to], n) => sql`(${n}::int, ${type}::text, ${from}::text, ${to}::text)`,
        ),
        sql`, `,
      );
      const { rows } = await t.db.execute<{ allowed: boolean }>(
        sql`SELECT ledger_entry_direction_allowed(c.t, c.f, c.k) AS allowed
            FROM (VALUES ${values}) AS c(n, t, f, k) ORDER BY c.n`,
      );
      expect(rows.map((row) => row.allowed)).toEqual(
        combos.map(([type, from, to]) => isLedgerDirectionAllowed(type, from, to)),
      );
      expect(rows.filter((row) => row.allowed)).toHaveLength(
        LEDGER_ENTRY_TYPES.reduce((n, type) => n + LEDGER_ENTRY_RULES[type].pairs.length, 0),
      );
    });

    it('records every allowed pair of every type, moving the amount and each side’s total', async () => {
      await createMarketMakerAccount(t.db);
      // A forfeiture is the closure's own (schema.test.ts, and the conservation case below).
      for (const type of LEDGER_ENTRY_TYPES.filter((type) => type !== 'CLOSURE_FORFEIT')) {
        for (const [fromKind, toKind] of LEDGER_ENTRY_RULES[type].pairs) {
          const market = await createMarket(t.db);
          const refOf = async (kind: LedgerSide): Promise<LedgerAccountRef | null> => {
            if (kind === null) return null;
            if (kind === 'user') return { kind, userId: (await createUser(t.db)).user.id };
            if (kind === 'treasury') return { kind };
            return { kind, marketId: market.id };
          };
          const from = await refOf(fromKind);
          const to = await refOf(toKind);
          if (from) await fund(from, 1_000n);
          const before = {
            from: from && (await balanceOf(from)),
            to: to && (await balanceOf(to)),
          };
          // #93 keeps the direction table, but no ordinary caller may execute a correction
          // without the exact permanent two-admin record. Its four modes have dedicated tests.
          if (type === 'RECONCILIATION_CORRECTION') {
            await expect(record({ type, amountCoin: 100n, from, to })).rejects.toThrow();
            continue;
          }
          const done = await record({
            type,
            amountCoin: 100n,
            from,
            to,
            ...(type === 'TRADE_FILL' ? { marketId: market.id } : {}),
          });
          const what = `${type} ${fromKind ?? 'mint'} → ${toKind ?? 'burn'}`;
          expect(done.outcome, what).toBe('recorded');
          if (done.outcome !== 'recorded') continue;
          expect(done.entry.amountCoin, what).toBe(100n);
          if (from) {
            expect(done.from!.availableCoin, what).toBe(before.from!.availableCoin - 100n);
            expect(done.entry.fromBalanceAfterCoin, what).toBe(
              done.from!.availableCoin + done.from!.lockedCoin,
            );
          } else {
            expect([done.from, done.entry.fromAccountId], what).toEqual([null, null]);
          }
          if (to) {
            expect(done.to!.availableCoin, what).toBe(before.to!.availableCoin + 100n);
            expect(done.entry.toBalanceAfterCoin, what).toBe(
              done.to!.availableCoin + done.to!.lockedCoin,
            );
          } else {
            expect([done.to, done.entry.toAccountId], what).toEqual([null, null]);
          }
          const marketSide = [fromKind, toKind].some(
            (kind) => kind === 'market_collateral' || kind === 'market_maker_funds',
          );
          expect(done.entry.marketId, what).toBe(
            marketSide || type === 'TRADE_FILL' ? market.id : null,
          );
        }
      }
      expect(await accountsAgainstLedger()).toEqual([]);
    });

    it('refuses a pair, a market or a lock its type does not take, writing nothing', async () => {
      const { user: a } = await createUser(t.db, { balanceCoin: 1_000n });
      const { user: b } = await createUser(t.db);
      const market = await createMarket(t.db);
      const other = await createMarket(t.db);
      const userA = { kind: 'user', userId: a.id } as const;
      const userB = { kind: 'user', userId: b.id } as const;
      const refused: Parameters<typeof record>[0][] = [
        // A direct send between two people: only a fill moves Coin from one to another.
        { type: 'BOT_ALLOCATION', amountCoin: 1n, from: userA, to: userB, marketId: market.id },
        // A correction that takes a person's Coin (#73 10항).
        {
          type: 'RECONCILIATION_CORRECTION',
          amountCoin: 1n,
          from: userA,
          to: { kind: 'treasury' },
        },
        // A grant of a market, a fill of none, a collateral of another market.
        { type: 'START_GRANT', amountCoin: 1n, from: null, to: userB, marketId: market.id },
        { type: 'TRADE_FILL', amountCoin: 1n, from: userA, to: userB },
        {
          type: 'PAIR_MINT_COLLATERAL',
          amountCoin: 1n,
          from: userA,
          to: { kind: 'market_collateral', marketId: other.id },
          marketId: market.id,
        },
        // A forfeiture paid out of a lock; a zero amount.
        {
          type: 'CLOSURE_FORFEIT',
          amountCoin: 1n,
          from: userA,
          to: null,
          debitFrom: 'locked',
        },
        { type: 'START_GRANT', amountCoin: 0n, from: null, to: userB },
        // An empty key: every source's key would be one event, and its second a duplicate.
        { type: 'START_GRANT', amountCoin: 1n, from: null, to: userB, idempotencyKey: '' },
      ];
      for (const input of refused) {
        await expect(record(input), input.type).rejects.toSatisfy((e) => codeOf(e) === 'refused');
      }
      expect((await ledgerOf(t.db, a.id)).map((e) => e.type)).toEqual(['START_GRANT']);
      expect(await ledgerOf(t.db, b.id)).toEqual([]);
    });

    it('refuses at INSERT an event the write API would refuse, whoever writes it', async () => {
      // The database's own copy of the rules (migration 0060's BEFORE INSERT trigger): a raw row
      // with the wrong pair, market or total after is refused before anything else.
      await createMarketMakerAccount(t.db);
      const { user: a } = await createUser(t.db);
      const { user: p } = await createUser(t.db, { balanceCoin: 500n });
      const market = await createMarket(t.db);
      const other = await createMarket(t.db);
      await fund({ kind: 'market_collateral', marketId: market.id }, 500n);
      await fund({ kind: 'treasury' }, 500n);
      const id = async (ref: LedgerAccountRef) =>
        (await t.db.transaction((tx) => ensureLedgerAccount(tx, ref))).id;
      const user = await id({ kind: 'user', userId: a.id });
      const payer = await id({ kind: 'user', userId: p.id });
      const treasury = await id({ kind: 'treasury' });
      const collateral = await id({ kind: 'market_collateral', marketId: market.id });
      const row = {
        amountCoin: 10n,
        refType: 'fill',
        refId: randomUUID(),
        idempotencyKey: randomUUID(),
      };
      const raw = (values: Partial<typeof ledgerEntries.$inferInsert>) =>
        t.db.insert(ledgerEntries).values({ type: 'START_GRANT', ...row, ...values });
      const cases: [string, Partial<typeof ledgerEntries.$inferInsert>, RegExp][] = [
        [
          'a type outside the closed list crediting a person (금고 발행)',
          { type: 'TREASURY_MINT', toAccountId: user, toBalanceAfterCoin: 10n },
          /does not move Coin/,
        ],
        [
          'a correction from the collateral to a person',
          {
            type: 'RECONCILIATION_CORRECTION',
            fromAccountId: collateral,
            fromBalanceAfterCoin: 490n,
            toAccountId: user,
            toBalanceAfterCoin: 10n,
            marketId: market.id,
          },
          /does not move Coin/,
        ],
        [
          'a bot allocation to a person',
          {
            type: 'BOT_ALLOCATION',
            fromAccountId: treasury,
            fromBalanceAfterCoin: 490n,
            toAccountId: user,
            toBalanceAfterCoin: 10n,
            marketId: market.id,
          },
          /does not move Coin/,
        ],
        [
          'a settlement out of another market’s collateral',
          {
            type: 'SETTLEMENT_PAYOUT',
            fromAccountId: collateral,
            fromBalanceAfterCoin: 490n,
            toAccountId: user,
            toBalanceAfterCoin: 10n,
            marketId: other.id,
          },
          /names the market of its accounts/,
        ],
        [
          'a grant naming a market',
          { toAccountId: user, toBalanceAfterCoin: 10n, marketId: market.id },
          /names the market of its accounts/,
        ],
        [
          'a fill between two people naming no market',
          {
            type: 'TRADE_FILL',
            fromAccountId: payer,
            fromBalanceAfterCoin: 490n,
            toAccountId: user,
            toBalanceAfterCoin: 10n,
          },
          /names the market of its accounts/,
        ],
        [
          'collateral into a market’s account naming no market',
          {
            type: 'PAIR_MINT_COLLATERAL',
            fromAccountId: payer,
            fromBalanceAfterCoin: 490n,
            toAccountId: collateral,
            toBalanceAfterCoin: 510n,
          },
          /names the market of its accounts/,
        ],
        [
          // Below the account's latest event: the COMMIT check, which reads the latest, would
          // never see it, and the ledger would say Coin the balance never got.
          'an id of its own below the account’s latest',
          { id: 0, toAccountId: payer, toBalanceAfterCoin: 510n },
          /takes an id after its accounts' latest events/,
        ],
        [
          // Past what the sequence has handed out: every later event of the account would look
          // older than it, and the COMMIT check would refuse them all.
          'an id of its own far ahead of the sequence',
          { id: Number.MAX_SAFE_INTEGER, toAccountId: user, toBalanceAfterCoin: 10n },
          /takes an id after its accounts' latest events/,
        ],
        [
          'a forged total after',
          { toAccountId: user, toBalanceAfterCoin: 1_000n },
          /does not continue its accounts' totals/,
        ],
        [
          // The payer's side: its total before the event, as if the 10 Coin never left it.
          'a forged payer’s total after',
          {
            type: 'TRADE_FILL',
            fromAccountId: payer,
            fromBalanceAfterCoin: 500n,
            toAccountId: user,
            toBalanceAfterCoin: 10n,
            marketId: market.id,
          },
          /does not continue its accounts' totals/,
        ],
      ];
      const refusedAtInsert = (message: RegExp) => (e: unknown) =>
        sqlState(e) === '23000' &&
        sqlConstraint(e) === 'ledger_entries_check' &&
        message.test(errorMessage(e));
      for (const [what, values, message] of cases) {
        await expect(raw(values), what).rejects.toSatisfy(refusedAtInsert(message));
      }
      // The same forged payer with only the payee's balance moved, as a writer would that took the
      // fill's 10 Coin out of nothing: the COMMIT check alone would pass it (the payer still
      // carries 500 against a ledger that says 500), so the INSERT check is what refuses it.
      await expect(
        t.db.transaction(async (tx) => {
          await tx
            .update(balances)
            .set({
              availableCoin: sql`${balances.availableCoin} + 10`,
              ledgerCoin: sql`${balances.ledgerCoin} + 10`,
            })
            .where(eq(balances.accountId, user));
          await tx.insert(ledgerEntries).values({
            ...row,
            type: 'TRADE_FILL',
            fromAccountId: payer,
            fromBalanceAfterCoin: 500n,
            toAccountId: user,
            toBalanceAfterCoin: 10n,
            marketId: market.id,
          });
        }),
      ).rejects.toSatisfy(refusedAtInsert(/a TRADE_FILL event does not continue/));
      // An empty key, past the trigger: the table's CHECK refuses it.
      await expect(
        raw({ toAccountId: user, toBalanceAfterCoin: 10n, idempotencyKey: '' }),
      ).rejects.toSatisfy(
        (e) =>
          sqlState(e) === '23514' && sqlConstraint(e) === 'ledger_entries_idempotency_key_check',
      );
      expect(await ledgerOf(t.db, a.id)).toEqual([]);
      expect(await accountsAgainstLedger()).toEqual([]);
    });
  });

  describe('keys', () => {
    it('reflects a request, a fill and a settlement key once, however often it is recorded', async () => {
      // #116 수용 기준: 같은 요청 ID·체결 ID·정산 키를 두 번 기록해도 한 번만 반영된다 (the start
      // grant's key: schema.test.ts 'pays a grant once').
      await createMarketMakerAccount(t.db);
      const market = await createMarket(t.db);
      const other = await createMarket(t.db);
      const { user: a } = await createUser(t.db, { balanceCoin: 1_000n });
      const { user: b } = await createUser(t.db);
      const { user: c } = await createUser(t.db);
      await fund({ kind: 'market_collateral', marketId: market.id }, 1_000n);
      const requestId = randomUUID();
      // The fill the TRADE_FILL records (#119: migration 0062 binds it): a buys 1 @ 60 of b.
      const { fill: traded } = await createFillRecord(t.db, {
        marketId: market.id,
        incomingOwnerId: a.id,
        restingOwnerId: b.id,
        kind: 'trade',
        priceCoin: 60,
      });
      const fillId = String(traded.id);
      const events: Parameters<typeof record>[0][] = [
        {
          type: 'TREASURY_MINT',
          amountCoin: 500n,
          from: null,
          to: { kind: 'treasury' },
          refType: 'approval_request',
          refId: requestId,
          idempotencyKey: ledgerKeys.approvalRequest(requestId),
        },
        {
          type: 'TRADE_FILL',
          amountCoin: 60n,
          from: { kind: 'user', userId: a.id },
          to: { kind: 'user', userId: b.id },
          marketId: market.id,
          refType: 'fill',
          refId: fillId,
          idempotencyKey: ledgerKeys.fill(fillId),
        },
        {
          type: 'SETTLEMENT_PAYOUT',
          amountCoin: 300n,
          from: { kind: 'market_collateral', marketId: market.id },
          to: { kind: 'user', userId: b.id },
          refType: 'market',
          refId: market.id,
          idempotencyKey: ledgerKeys.settlement(market.id, 1, b.id, 'YES'),
        },
      ];
      const recorded: unknown[] = [];
      for (const event of events) {
        const first = await record(event);
        expect(first.outcome, event.type).toBe('recorded');
        const again = await record(event);
        expect(again, event.type).toEqual({ outcome: 'duplicate', entry: first.entry });
        recorded.push(first.entry);
      }
      // a's and the collateral payer's start grants, the payer's collateral, and the three.
      expect(await t.db.select().from(ledgerEntries)).toHaveLength(2 + 1 + 3);
      expect((await ledgerAccountBalance(t.db, { kind: 'treasury' }))?.availableCoin).toBe(500n);
      expect((await balanceOf({ kind: 'user', userId: a.id })).availableCoin).toBe(940n);
      expect((await balanceOf({ kind: 'user', userId: b.id })).availableCoin).toBe(360n);
      // The same key as another event — another payer, payee, amount or market, each alone — is a
      // caller's bug. The key is looked up before the funds: c holds nothing and is still told so.
      for (const [what, changed] of [
        ['another payer', { from: { kind: 'user', userId: c.id } as const }],
        ['another payee', { to: { kind: 'market_maker_funds', marketId: market.id } as const }],
        ['another amount', { amountCoin: 61n }],
        ['another market', { marketId: other.id }],
      ] as const) {
        await expect(record({ ...events[1]!, ...changed }), what).rejects.toSatisfy(
          (e) => codeOf(e) === 'key_conflict',
        );
      }
      // Unique per type, and since #119 bound to its fill: a pair-mint leg never takes a trade
      // fill's key (migration 0062's `ledger_entries_fill_binding`; a fill and its legs differ).
      await expect(
        record({
          type: 'PAIR_MINT_COLLATERAL',
          amountCoin: 40n,
          from: { kind: 'user', userId: a.id },
          to: { kind: 'market_collateral', marketId: market.id },
          refId: fillId,
          idempotencyKey: ledgerKeys.fill(fillId),
        }),
      ).rejects.toSatisfy((e) => sqlConstraint(e) === 'ledger_entries_fill_binding');
      expect(
        (
          await record({
            type: 'PAIR_MINT_COLLATERAL',
            amountCoin: 40n,
            from: { kind: 'user', userId: a.id },
            to: { kind: 'market_collateral', marketId: market.id },
          })
        ).outcome,
      ).toBe('recorded');
      // A retried fill is the same event even once its payer has spent the rest: the key is found
      // before the funds are counted, so it is `duplicate`, not `insufficient_coin`.
      await record({
        type: 'PAIR_MINT_COLLATERAL',
        amountCoin: 900n,
        from: { kind: 'user', userId: a.id },
        to: { kind: 'market_collateral', marketId: market.id },
      });
      expect(await balanceOf({ kind: 'user', userId: a.id })).toMatchObject({
        availableCoin: 0n,
        ledgerCoin: 0n,
      });
      expect(await record(events[1]!)).toEqual({ outcome: 'duplicate', entry: recorded[1] });
      // And the database holds the key whoever writes, its other checks off.
      await expect(
        withLedgerGuardsOff(
          (client) =>
            client.query(`INSERT INTO ledger_entries (type, amount_coin, to_account_id,
                to_balance_after_coin, market_id, ref_type, ref_id, idempotency_key)
              SELECT type, amount_coin, to_account_id, to_balance_after_coin, market_id, ref_type,
                ref_id, idempotency_key
              FROM ledger_entries WHERE type = 'TRADE_FILL'`),
          { entries: true },
        ),
      ).rejects.toSatisfy((e) => sqlConstraint(e) === 'ledger_entries_type_idempotency_key_unique');
    });

    it('finds an event by its type and key, and keys a burn by its market', async () => {
      const market = await createMarket(t.db);
      const burnId = randomUUID();
      expect(ledgerKeys.pairBurn(market.id, burnId)).toBe(`${market.id}:${burnId}`);
      // A burn id is the caller's (#129): the same one in two markets is two keys.
      const other = await createMarket(t.db);
      expect(ledgerKeys.pairBurn(other.id, burnId)).not.toBe(
        ledgerKeys.pairBurn(market.id, burnId),
      );
      const key = randomUUID();
      expect(await findLedgerEntry(t.db, 'TREASURY_MINT', key)).toBeNull();
      const done = await record({
        type: 'TREASURY_MINT',
        amountCoin: 5n,
        from: null,
        to: { kind: 'treasury' },
        idempotencyKey: key,
      });
      expect(await findLedgerEntry(t.db, 'TREASURY_MINT', key)).toEqual(done.entry);
      expect(await findLedgerEntry(t.db, 'BOT_ALLOCATION', key)).toBeNull();
    });

    it('records one event when the same key is recorded by two transactions at once', async () => {
      await fund({ kind: 'treasury' }, 1n);
      const requestId = randomUUID();
      const mint = (tx: Parameters<Parameters<typeof t.db.transaction>[0]>[0]) =>
        recordLedgerEntry(tx, {
          type: 'TREASURY_MINT',
          amountCoin: 700n,
          from: null,
          to: { kind: 'treasury' },
          refType: 'approval_request',
          refId: requestId,
          idempotencyKey: ledgerKeys.approvalRequest(requestId),
        });
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let written!: () => void;
      const wrote = new Promise<void>((resolve) => (written = resolve));
      const first = t.db.transaction(async (tx) => {
        const done = await mint(tx);
        written();
        await released;
        return done;
      });
      await wrote;
      const second = t.db.transaction((tx) => mint(tx));
      await waitForLockWaiter(t.db.$client, 'the second mint waits on the treasury');
      release();
      const [one, two] = await Promise.all([first, second]);
      expect([one.outcome, two.outcome]).toEqual(['recorded', 'duplicate']);
      expect(two.entry.id).toBe(one.entry.id);
      expect((await ledgerAccountBalance(t.db, { kind: 'treasury' }))?.availableCoin).toBe(701n);
    });
  });

  describe('balances', () => {
    it('never pays more than an account holds, however many debits race (no negative balance)', async () => {
      await createMarketMakerAccount(t.db);
      const market = await createMarket(t.db);
      const { user: a } = await createUser(t.db, { balanceCoin: 100n });
      await fund({ kind: 'market_maker_funds', marketId: market.id }, 100n);
      await fund({ kind: 'market_collateral', marketId: market.id }, 100n);
      const { user: holder } = await createUser(t.db);
      const collateral = { kind: 'market_collateral', marketId: market.id } as const;
      const funds = { kind: 'market_maker_funds', marketId: market.id } as const;
      const racing: [string, Parameters<typeof record>[0], LedgerAccountRef][] = [
        [
          'a person',
          {
            type: 'PAIR_MINT_COLLATERAL',
            amountCoin: 100n,
            from: { kind: 'user', userId: a.id },
            to: collateral,
          },
          { kind: 'user', userId: a.id },
        ],
        [
          'a 마켓메이커 자금',
          { type: 'BOT_RECALL', amountCoin: 100n, from: funds, to: { kind: 'treasury' } },
          funds,
        ],
        [
          'a collateral',
          {
            type: 'SETTLEMENT_PAYOUT',
            amountCoin: 150n, // 200 by now: its own 100 and the person's above
            from: collateral,
            to: { kind: 'user', userId: holder.id },
          },
          collateral,
        ],
      ];
      for (const [what, input, payer] of racing) {
        const outcomes = await Promise.allSettled([record(input), record(input), record(input)]);
        const recorded = outcomes.filter((o) => o.status === 'fulfilled');
        const refused = outcomes.flatMap((o) =>
          o.status === 'rejected' ? [codeOf(o.reason)] : [],
        );
        expect(recorded.length, what).toBeGreaterThanOrEqual(1);
        expect(
          refused.every((code) => code === 'insufficient_coin'),
          what,
        ).toBe(true);
        expect((await balanceOf(payer)).availableCoin >= 0n, what).toBe(true);
      }
      expect((await balanceOf({ kind: 'user', userId: a.id })).availableCoin).toBe(0n);
      expect((await balanceOf(funds)).availableCoin).toBe(0n);
      expect((await balanceOf(collateral)).availableCoin).toBe(50n);
      expect(await accountsAgainstLedger()).toEqual([]);
    });

    it('commits two fills in opposite directions at once: the accounts lock in one order', async () => {
      const market = await createMarket(t.db);
      const { user: a } = await createUser(t.db, { balanceCoin: 1_000n });
      const { user: b } = await createUser(t.db, { balanceCoin: 1_000n });
      const fill = (from: string, to: string) =>
        record({
          type: 'TRADE_FILL',
          amountCoin: 10n,
          from: { kind: 'user', userId: from },
          to: { kind: 'user', userId: to },
          marketId: market.id,
        });
      const done = await Promise.all(
        Array.from({ length: 6 }, (_, i) => (i % 2 === 0 ? fill(a.id, b.id) : fill(b.id, a.id))),
      );
      expect(done.map((d) => d.outcome)).toEqual(Array(6).fill('recorded'));
      expect((await balanceOf({ kind: 'user', userId: a.id })).availableCoin).toBe(1_000n);
      expect((await balanceOf({ kind: 'user', userId: b.id })).availableCoin).toBe(1_000n);
      // Each account's chain of totals holds in id order, the one 0060's guards follow.
      for (const id of [a.id, b.id]) {
        let total = 0n;
        for (const entry of await ledgerOf(t.db, id)) {
          total += entry.amountCoin;
          expect(entry.balanceAfterCoin).toBe(total);
        }
      }
    });

    it('locks and releases Coin within one account: no event, the total and the ledger stay', async () => {
      // #118 (ADR-0110; ADR-0107 결정 2 #73 1항 주문 잠금): available ↔ locked of one ledger account
      // — a person's own or a market's 마켓메이커 자금 — any positive amount, never below 0.
      await createMarketMakerAccount(t.db);
      const market = await createMarket(t.db);
      const { user: a } = await createUser(t.db, { balanceCoin: 2_000n });
      const own: LedgerAccountRef = { kind: 'user', userId: a.id };
      const funds: LedgerAccountRef = { kind: 'market_maker_funds', marketId: market.id };
      await fund(funds, 500n);
      const entriesBefore = await t.db.select().from(ledgerEntries);
      const lock = (ref: LedgerAccountRef, coin: bigint) =>
        t.db.transaction((tx) => lockCoin(tx, ref, coin));
      const release = (ref: LedgerAccountRef, coin: bigint) =>
        t.db.transaction((tx) => releaseCoin(tx, ref, coin));

      // An odd budget (#177 3항) as well as a limit × qty.
      expect(await lock(own, 1_234n)).toMatchObject({
        availableCoin: 766n,
        lockedCoin: 1_234n,
        ledgerCoin: 2_000n,
      });
      expect(await lock(own, 600n)).toMatchObject({ availableCoin: 166n, lockedCoin: 1_834n });
      await expect(lock(own, 167n)).rejects.toSatisfy((e) => codeOf(e) === 'insufficient_coin');
      expect(await release(own, 944n)).toMatchObject({ availableCoin: 1_110n, lockedCoin: 890n });
      await expect(release(own, 891n)).rejects.toSatisfy((e) => codeOf(e) === 'refused');
      for (const coin of [0n, -1n]) {
        await expect(lock(own, coin)).rejects.toSatisfy((e) => codeOf(e) === 'refused');
        await expect(release(own, coin)).rejects.toSatisfy((e) => codeOf(e) === 'refused');
      }
      expect(await release(own, 890n)).toMatchObject({
        availableCoin: 2_000n,
        lockedCoin: 0n,
        ledgerCoin: 2_000n,
      });
      // The 운영 마켓메이커's Coin is locked in its market's funds (#73 11항).
      expect(await lock(funds, 500n)).toMatchObject({ availableCoin: 0n, lockedCoin: 500n });
      await expect(lock(funds, 1n)).rejects.toSatisfy((e) => codeOf(e) === 'insufficient_coin');
      await release(funds, 500n);
      // No event, and every account still agrees with its ledger.
      expect(await t.db.select().from(ledgerEntries)).toEqual(entriesBefore);
      expect(await accountsAgainstLedger()).toEqual([]);
    });

    it('bounds a lock by the ledger too on an account whose total left it, and keeps the gap', async () => {
      // #73 10항: a lock or a release keeps available + locked, so the gap. A lock takes no more
      // than the ledger's part not locked yet: Coin a gap added is not the ledger's to pay later.
      const { user: up } = await createUser(t.db, { balanceCoin: 100n });
      const { user: down } = await createUser(t.db, { balanceCoin: 100n });
      await withLedgerGuardsOff(async (client) => {
        await client.query(
          'UPDATE balances SET available_coin = available_coin + 50 WHERE user_id = $1',
          [up.id],
        );
        await client.query(
          'UPDATE balances SET available_coin = available_coin - 50 WHERE user_id = $1',
          [down.id],
        );
      });
      const gap = async (userId: string) => {
        const row = await balanceOf({ kind: 'user', userId });
        return row.availableCoin + row.lockedCoin - row.ledgerCoin;
      };
      const lock = (userId: string, coin: bigint) =>
        t.db.transaction((tx) => lockCoin(tx, { kind: 'user', userId }, coin));
      // 150 available, a ledger of 100: at most 100.
      await expect(lock(up.id, 101n)).rejects.toSatisfy((e) => codeOf(e) === 'insufficient_coin');
      expect(await lock(up.id, 60n)).toMatchObject({ availableCoin: 90n, lockedCoin: 60n });
      await expect(lock(up.id, 41n)).rejects.toSatisfy((e) => codeOf(e) === 'insufficient_coin');
      expect(await lock(up.id, 40n)).toMatchObject({ availableCoin: 50n, lockedCoin: 100n });
      expect(await gap(up.id)).toBe(50n);
      // 50 available, a ledger of 100: at most 50.
      await expect(lock(down.id, 51n)).rejects.toSatisfy((e) => codeOf(e) === 'insufficient_coin');
      expect(await lock(down.id, 50n)).toMatchObject({ availableCoin: 0n, lockedCoin: 50n });
      await t.db.transaction((tx) => releaseCoin(tx, { kind: 'user', userId: down.id }, 50n));
      expect(await gap(down.id)).toBe(-50n);
      await t.db.transaction((tx) => releaseCoin(tx, { kind: 'user', userId: up.id }, 100n));
      expect(await gap(up.id)).toBe(50n);
    });

    it('pays a fill or a pair mint out of a lock only where the type allows it', async () => {
      const market = await createMarket(t.db);
      const { user: a } = await createUser(t.db, { balanceCoin: 100n });
      // An order's lock (#118): available → locked of one account, no event — the total stays,
      // so the COMMIT check lets it through.
      await t.db.transaction((tx) => lockCoin(tx, { kind: 'user', userId: a.id }, 60n));
      const collateral = { kind: 'market_collateral', marketId: market.id } as const;
      const fromLock = {
        type: 'PAIR_MINT_COLLATERAL',
        from: { kind: 'user', userId: a.id },
        to: collateral,
        debitFrom: 'locked',
      } as const;
      await expect(record({ ...fromLock, amountCoin: 61n })).rejects.toSatisfy(
        (e) => codeOf(e) === 'insufficient_coin',
      );
      const done = await record({ ...fromLock, amountCoin: 60n });
      expect(done.outcome === 'recorded' && done.from).toMatchObject({
        availableCoin: 40n,
        lockedCoin: 0n,
      });
      expect(done.entry.fromBalanceAfterCoin).toBe(40n);
      expect(await accountsAgainstLedger()).toEqual([]);
    });

    it('refuses a total changed alone at once, and at COMMIT a ledger total or an event alone', async () => {
      const { user: a } = await createUser(t.db, { balanceCoin: 100n });
      const atOnce = (e: unknown) =>
        sqlState(e) === '23000' && sqlConstraint(e) === 'balances_keep_ledger_gap';
      const atCommit = (e: unknown) =>
        sqlState(e) === '23000' && /but its ledger says/.test(errorMessage(e));
      const ofA = eq(balances.userId, a.id);
      // A total moved without its ledger total, or the ledger total without the total: the
      // UPDATE itself is refused, whoever writes.
      await expect(
        t.db
          .update(balances)
          .set({ availableCoin: sql`${balances.availableCoin} + 1` })
          .where(ofA),
      ).rejects.toSatisfy(atOnce);
      await expect(
        t.db
          .update(balances)
          .set({ ledgerCoin: sql`${balances.ledgerCoin} + 1` })
          .where(ofA),
      ).rejects.toSatisfy(atOnce);
      // Both moved together but no event: refused at COMMIT.
      await expect(
        t.db
          .update(balances)
          .set({
            availableCoin: sql`${balances.availableCoin} + 1`,
            ledgerCoin: sql`${balances.ledgerCoin} + 1`,
          })
          .where(ofA),
      ).rejects.toSatisfy(atCommit);
      const [own] = await t.db.select().from(balances).where(ofA);
      const grant = () => ({
        type: 'START_GRANT' as const,
        amountCoin: 5n,
        toAccountId: own!.accountId,
        toBalanceAfterCoin: 105n,
        refType: 'start_grant',
        refId: randomUUID(),
        idempotencyKey: randomUUID(),
      });
      // An event without its balance change: refused at COMMIT.
      await expect(t.db.insert(ledgerEntries).values(grant())).rejects.toSatisfy(atCommit);
      // Either side of a move: a fill whose payer's balance did not move (Coin made from nothing)
      // or whose payee's did not (Coin gone) — each refused naming the side that stayed.
      const { user: b } = await createUser(t.db);
      const market = await createMarket(t.db);
      const [ownB] = await t.db.select().from(balances).where(eq(balances.userId, b.id));
      // A real fill of 10 Coin from a to b (#119: migration 0062 binds the event to it).
      const { fill: record10 } = await createFillRecord(t.db, {
        marketId: market.id,
        incomingOwnerId: a.id,
        restingOwnerId: b.id,
        kind: 'trade',
        priceCoin: 10,
      });
      const fill = {
        type: 'TRADE_FILL' as const,
        amountCoin: 10n,
        fromAccountId: own!.accountId,
        fromBalanceAfterCoin: 90n,
        toAccountId: ownB!.accountId,
        toBalanceAfterCoin: 10n,
        marketId: market.id,
        refType: 'fill',
        refId: String(record10.id),
        idempotencyKey: String(record10.id),
      };
      for (const [moved, stayed, by] of [
        [ownB!.accountId, own!.accountId, 10],
        [own!.accountId, ownB!.accountId, -10],
      ] as const) {
        await expect(
          t.db.transaction(async (tx) => {
            await tx.insert(ledgerEntries).values(fill);
            await tx
              .update(balances)
              .set({
                availableCoin: sql`${balances.availableCoin} + ${by}`,
                ledgerCoin: sql`${balances.ledgerCoin} + ${by}`,
              })
              .where(eq(balances.accountId, moved));
          }),
        ).rejects.toSatisfy(
          (e) =>
            atCommit(e) && errorMessage(e).startsWith(`ledger account ${String(stayed)} carries`),
        );
      }
      // Changed together, in either order, it commits.
      await t.db.transaction(async (tx) => {
        await tx
          .update(balances)
          .set({
            availableCoin: sql`${balances.availableCoin} + 5`,
            ledgerCoin: sql`${balances.ledgerCoin} + 5`,
          })
          .where(ofA);
        await tx.insert(ledgerEntries).values(grant());
      });
      expect(await balanceOf({ kind: 'user', userId: a.id })).toMatchObject({
        availableCoin: 105n,
        ledgerCoin: 105n,
      });
      expect(await accountsAgainstLedger()).toEqual([]);
    });

    it('locks an event’s balance rows for a writer that did not: a raw event racing the write API', async () => {
      // 0060's INSERT check takes the balance rows itself, so a writer that skips
      // `lockLedgerAccounts` waits for the write API and reads its event, or makes it wait.
      const { user: a } = await createUser(t.db, { balanceCoin: 100n });
      const own: LedgerAccountRef = { kind: 'user', userId: a.id };
      const [row] = await t.db.select().from(balances).where(eq(balances.userId, a.id));
      const grant = (amountCoin: bigint): LedgerEntryInput => ({
        type: 'START_GRANT',
        amountCoin,
        from: null,
        to: own,
        refType: 'start_grant',
        refId: randomUUID(),
        idempotencyKey: randomUUID(),
      });
      const gate = () => {
        let open!: () => void;
        const opened = new Promise<void>((resolve) => (open = resolve));
        return { open, opened };
      };
      const raw = new Client({ connectionString: testDbUrls()!.appUrl });
      await raw.connect();
      // A coupon's 30 Coin with no balance change, its total after given; the error, if refused.
      const insertRaw = (afterCoin: bigint) =>
        raw
          .query(
            `INSERT INTO ledger_entries (type, amount_coin, to_account_id, to_balance_after_coin,
               ref_type, ref_id, idempotency_key)
             VALUES ('BONUS', 30, $1, $2, 'coupon', $3, $3)`,
            [row!.accountId, afterCoin.toString(), randomUUID()],
          )
          .then(
            () => undefined,
            (error: unknown) => error,
          );
      try {
        // 1. Held open, it makes the write API wait, and at its COMMIT it is refused: no later
        //    event of the write API's covers it.
        await raw.query('BEGIN');
        expect(await insertRaw(130n)).toBeUndefined();
        const after = record(grant(5n));
        await waitForLockWaiter(t.db.$client, 'the write API waits on the raw event');
        await expect(raw.query('COMMIT')).rejects.toSatisfy(
          (e) => sqlState(e) === '23000' && /but its ledger says 130/.test(errorMessage(e)),
        );
        expect((await after).outcome).toBe('recorded');
        // 2. While the write API holds the account, it waits, then reads the write API's event:
        //    a total chained from before it is refused at once.
        for (const [what, lockOnly, afterCoin, message] of [
          ['a stale total', false, 135n, /does not continue its accounts' totals/],
          // 3. Its id drawn before the wait, below the write API's event written after it:
          //    refused though its total would continue the chain.
          ['an id drawn before the wait', true, 235n, /takes an id after/],
        ] as const) {
          const locked = gate();
          const release = gate();
          const held = t.db.transaction(async (tx) => {
            if (lockOnly) await lockLedgerAccounts(tx, [own]);
            else await recordLedgerEntry(tx, grant(50n));
            locked.open();
            await release.opened;
            if (lockOnly) await recordLedgerEntry(tx, grant(50n));
          });
          await locked.opened;
          await raw.query('BEGIN');
          const refused = insertRaw(afterCoin);
          await waitForLockWaiter(t.db.$client, `the raw event waits (${what})`);
          release.open();
          await held;
          const error = await refused;
          expect(
            sqlConstraint(error) === 'ledger_entries_check' && message.test(errorMessage(error)),
            what,
          ).toBe(true);
          await raw.query('ROLLBACK');
        }
      } finally {
        await raw.end();
      }
      expect((await ledgerOf(t.db, a.id)).map((e) => e.amountCoin)).toEqual([100n, 5n, 50n, 50n]);
      expect((await balanceOf(own)).availableCoin).toBe(205n);
      expect(await accountsAgainstLedger()).toEqual([]);
    });

    it('follows an account’s chain by id, not the clock: a clock stepped back refuses nothing', async () => {
      const { user: a } = await createUser(t.db);
      const own: LedgerAccountRef = { kind: 'user', userId: a.id };
      const first = await record({
        type: 'START_GRANT',
        amountCoin: 100n,
        from: null,
        to: own,
        refType: 'start_grant',
      });
      // The database's clock stepped back half a second (an NTP step, a resumed VM): the next
      // event is stamped before the last. By (created_at, id) the first would stay the latest and
      // the COMMIT check would refuse this one, and every later one, until the clock caught up.
      await record({
        type: 'START_GRANT',
        amountCoin: 50n,
        from: null,
        to: own,
        refType: 'start_grant',
        at: new Date(first.entry.createdAt.getTime() - 500),
      });
      await record({
        type: 'START_GRANT',
        amountCoin: 1n,
        from: null,
        to: own,
        refType: 'start_grant',
      });
      expect((await balanceOf(own)).availableCoin).toBe(151n);
      expect(await accountsAgainstLedger()).toEqual([]);
    });

    it('keeps an account whose total left its ledger taking its events, the gap unchanged (10항)', async () => {
      // ADR-0107 결정 2 #73 10항: an account mismatch refuses that account's new orders only (#93)
      // — a settlement payout, a grant, a fill and an order's lock still land. Each event moves the
      // buckets and the ledger total (`ledger_coin`) together and takes its total after from the
      // ledger, so the chain goes on and the gap stays as it was, for #93's 대사 정정 to close.
      const market = await createMarket(t.db);
      const { user: a } = await createUser(t.db, { balanceCoin: 100n });
      const { user: b } = await createUser(t.db, { balanceCoin: 100n });
      const own: LedgerAccountRef = { kind: 'user', userId: a.id };
      const other: LedgerAccountRef = { kind: 'user', userId: b.id };
      const collateral = { kind: 'market_collateral', marketId: market.id } as const;
      await fund(collateral, 300n);
      await withLedgerGuardsOff((client) =>
        client.query(
          'UPDATE balances SET available_coin = available_coin + 50 WHERE user_id = $1',
          [a.id],
        ),
      );
      const gap = async () => {
        const row = await balanceOf(own);
        return row.availableCoin + row.lockedCoin - row.ledgerCoin;
      };
      expect(await gap()).toBe(50n);

      const payout = await record({
        type: 'SETTLEMENT_PAYOUT',
        amountCoin: 200n,
        from: collateral,
        to: own,
        idempotencyKey: ledgerKeys.settlement(market.id, 1, a.id, 'YES'),
      });
      expect(payout.outcome === 'recorded' && payout.entry.toBalanceAfterCoin).toBe(300n);
      expect(payout.outcome === 'recorded' && payout.to).toMatchObject({
        availableCoin: 350n,
        ledgerCoin: 300n,
      });
      await record({
        type: 'START_GRANT',
        amountCoin: 1n,
        from: null,
        to: own,
        refType: 'start_grant',
      });
      const fill = (from: LedgerAccountRef, to: LedgerAccountRef, amountCoin: bigint) =>
        record({ type: 'TRADE_FILL', amountCoin, from, to, marketId: market.id });
      await fill(own, other, 30n);
      await fill(other, own, 10n);
      // An order's lock and its release (#118): no event, neither the total nor the gap moves.
      await t.db.transaction((tx) => lockCoin(tx, own, 100n));
      expect(await gap()).toBe(50n);
      await t.db.transaction((tx) => releaseCoin(tx, own, 100n));
      expect(await balanceOf(own)).toMatchObject({
        availableCoin: 331n,
        lockedCoin: 0n,
        ledgerCoin: 281n,
      });
      expect(await gap()).toBe(50n);
      // Each event's total after continued the ledger's chain, not the buckets'.
      let total = 0n;
      for (const entry of await ledgerOf(t.db, a.id)) {
        total += entry.amountCoin;
        expect(entry.balanceAfterCoin).toBe(total);
      }
      expect(total).toBe(281n);
      // Coin the gap added is not the ledger's to pay: the ledger total is short of 300.
      await expect(fill(own, other, 300n)).rejects.toSatisfy(
        (e) => codeOf(e) === 'insufficient_coin',
      );
      // Every other account agrees with its ledger, and the ledger totals still sum to the books.
      expect(await accountsAgainstLedger()).toEqual([
        expect.objectContaining({ total: '331', carried: '281', ledger: '281' }),
      ]);
      const supply = await ledgerSupply(t.db);
      expect(supply.carriedCoin).toBe(supply.mintedCoin - supply.burnedCoin);
      expect(supply.heldCoin).toBe(supply.carriedCoin + 50n);
    });

    it('takes no event into an account whose ledger-total copy left its ledger, until it is reset', async () => {
      // ADR-0109 결정 12-8 and 결과 5: the gap above is between the buckets and `ledger_coin`. When
      // `ledger_coin` itself left the ledger (a `balances` row restored from an older backup), the
      // event's total after continues the ledger's chain at INSERT and `ledger_coin` must equal it
      // at COMMIT, so no event lands — a payout included — until the copy is reset to the ledger's
      // total: the owner-level step OPERATIONS.md gives, run here as written. The gap that leaves
      // then rides along as above, for #93's 대사 정정.
      const { user: a } = await createUser(t.db, { balanceCoin: 1_200n });
      const own: LedgerAccountRef = { kind: 'user', userId: a.id };
      const { accountId } = await balanceOf(own);
      await withLedgerGuardsOff((client) =>
        client.query(
          'UPDATE balances SET available_coin = 1000, ledger_coin = 1000 WHERE account_id = $1',
          [accountId],
        ),
      );
      expect(await accountsAgainstLedger()).toEqual([
        expect.objectContaining({ total: '1000', carried: '1000', ledger: '1200' }),
      ]);
      const grant = () =>
        record({
          type: 'START_GRANT',
          amountCoin: 200n,
          from: null,
          to: own,
          refType: 'start_grant',
        });
      await expect(grant()).rejects.toSatisfy(
        (e) =>
          sqlState(e) === '23000' && /does not continue its accounts' totals/.test(errorMessage(e)),
      );
      expect(await ledgerOf(t.db, a.id)).toHaveLength(1);

      // OPERATIONS.md '사본이 어긋났을 때': the copy alone, back to the ledger's total; the buckets
      // stay.
      await migrate.query('BEGIN');
      try {
        await migrate.query('ALTER TABLE balances DISABLE TRIGGER balances_keep_ledger_gap');
        const reset = await migrate.query(
          `UPDATE balances SET ledger_coin = ledger_account_last_after(account_id), updated_at = now()
            WHERE account_id = $1`,
          [accountId],
        );
        expect(reset.rowCount).toBe(1);
        await migrate.query('SET CONSTRAINTS ALL IMMEDIATE');
        await migrate.query('ALTER TABLE balances ENABLE TRIGGER balances_keep_ledger_gap');
        await migrate.query('COMMIT');
      } catch (error) {
        await migrate.query('ROLLBACK');
        throw error;
      }
      expect(await accountsAgainstLedger()).toEqual([
        expect.objectContaining({ total: '1000', carried: '1200', ledger: '1200' }),
      ]);
      const granted = await grant();
      expect(granted.outcome === 'recorded' && granted.entry.toBalanceAfterCoin).toBe(1_400n);
      expect(await balanceOf(own)).toMatchObject({ availableCoin: 1_200n, ledgerCoin: 1_400n });
      expect(await accountsAgainstLedger()).toEqual([
        expect.objectContaining({ total: '1200', carried: '1400', ledger: '1400' }),
      ]);
    });

    it('closes no account whose total left its ledger: a closed account ends at 0 on both', async () => {
      // ADR-0109 결정 12-8, migration 0060's copy of 0043's closure check (#140, ADR-0086): a
      // forfeiture moves the buckets and the ledger total by one amount, so it cannot take both to
      // 0 while they differ — the closure waits for #93's 대사 정정.
      const { user: short } = await createUser(t.db, { balanceCoin: 100n });
      const { user: over } = await createUser(t.db, { balanceCoin: 100n });
      await withLedgerGuardsOff(async (client) => {
        await client.query(
          'UPDATE balances SET available_coin = available_coin - 100 WHERE user_id = $1',
          [short.id],
        );
        await client.query(
          'UPDATE balances SET available_coin = available_coin + 30 WHERE user_id = $1',
          [over.id],
        );
      });
      // Nothing left in the buckets, 100 by the ledger: nothing to forfeit, and the closure's
      // COMMIT check finds the ledger total off 0.
      await expect(closeAccount(t.db, short.id)).rejects.toSatisfy(
        (e) => sqlState(e) === '23000' && /closed keeping Coin/.test(errorMessage(e)),
      );
      // 130 in the buckets, 100 by the ledger: the ledger cannot burn 130.
      await expect(closeAccount(t.db, over.id)).rejects.toSatisfy(
        (e) => codeOf(e) === 'insufficient_coin',
      );
      for (const id of [short.id, over.id]) expect(await ledgerOf(t.db, id)).toHaveLength(1);
    });

    it('lets a test break the books on purpose, and only through withLedgerGuardsOff', async () => {
      // The ledger audit's mismatch cases (worker) need a balance that disagrees with its ledger:
      // the migrate role, the UPDATE and COMMIT checks off for one transaction, then on again.
      const { user: a } = await createUser(t.db, { balanceCoin: 100n });
      await withLedgerGuardsOff((client) =>
        client.query('UPDATE balances SET available_coin = available_coin + 7 WHERE user_id = $1', [
          a.id,
        ]),
      );
      expect(await accountsAgainstLedger()).toEqual([
        expect.objectContaining({ total: '107', carried: '100', ledger: '100' }),
      ]);
      const { rows } = await migrate.query<{ name: string; enabled: string }>(
        `SELECT tgname AS name, tgenabled AS enabled FROM pg_trigger
          WHERE tgname IN ('balances_keep_ledger_gap', 'balances_follow_ledger') ORDER BY 1`,
      );
      expect(rows).toEqual([
        { name: 'balances_follow_ledger', enabled: 'O' },
        { name: 'balances_keep_ledger_gap', enabled: 'O' },
      ]);
      // With `entries`, a forged event commits too — one that moved no balance — though
      // `ledger_entries_closed_account`, deferred and left on, has queued its check meanwhile.
      const [own] = await t.db.select().from(balances).where(eq(balances.userId, a.id));
      await withLedgerGuardsOff(
        (client) =>
          client.query(
            `INSERT INTO ledger_entries (type, amount_coin, to_account_id, to_balance_after_coin,
               ref_type, ref_id, idempotency_key)
             VALUES ('BONUS', 5, $1, 105, 'coupon', $2, $2)`,
            [own!.accountId, randomUUID()],
          ),
        { entries: true },
      );
      expect(await accountsAgainstLedger()).toEqual([
        expect.objectContaining({ total: '107', carried: '100', ledger: '105' }),
      ]);
      const { rows: all } = await migrate.query<{ enabled: string }>(
        `SELECT tgenabled AS enabled FROM pg_trigger
          WHERE tgname IN ('balances_keep_ledger_gap', 'balances_follow_ledger',
                           'ledger_entries_check', 'ledger_entries_follow_balances')`,
      );
      expect(all).toEqual(Array(4).fill({ enabled: 'O' }));
    });

    it('lets the app neither make, remove nor re-key a balance row', async () => {
      const { user: a } = await createUser(t.db);
      const { user: b } = await createUser(t.db);
      const [own] = await t.db.select().from(balances).where(eq(balances.userId, a.id));
      const denied = (e: unknown) => sqlState(e) === '42501';
      await expect(
        t.db.insert(balances).values({ accountId: own!.accountId + 1_000, userId: null }),
      ).rejects.toSatisfy(denied);
      await expect(t.db.delete(balances).where(eq(balances.userId, a.id))).rejects.toSatisfy(
        denied,
      );
      await expect(
        t.db.update(balances).set({ userId: b.id }).where(eq(balances.userId, a.id)),
      ).rejects.toSatisfy(denied);
      await expect(
        t.db.update(balances).set({ accountId: 0 }).where(eq(balances.userId, a.id)),
      ).rejects.toSatisfy(denied);
      const { rows } = await t.db.execute<{ column: string }>(sql`
        SELECT column_name AS "column" FROM information_schema.column_privileges
        WHERE grantee = 'buddha_app' AND table_name = 'balances' AND privilege_type = 'UPDATE'
        ORDER BY 1`);
      expect(rows.map((row) => row.column)).toEqual([
        'available_coin',
        'ledger_coin',
        'locked_coin',
        'updated_at',
      ]);
      // Nor through the trigger function that opens one (SECURITY DEFINER), fired from a temporary
      // table of its own: nobody may EXECUTE it, while the ledger accounts' trigger, checked only
      // when it was made, keeps opening each row (a and b above, made as buddha_app).
      const session = new Client({ connectionString: testDbUrls()!.appUrl });
      await session.connect();
      try {
        await session.query('CREATE TEMP TABLE shim (id bigint, kind text, owner_id text)');
        await expect(
          session.query(`CREATE TRIGGER shim_open AFTER INSERT ON shim FOR EACH ROW
            EXECUTE FUNCTION public.ledger_accounts_open_balance()`),
        ).rejects.toSatisfy(denied);
      } finally {
        await session.end();
      }
      const { rows: grants } = await t.db.execute<{ role: string; allowed: boolean }>(sql`
        SELECT r.role, has_function_privilege(r.role, 'ledger_accounts_open_balance()',
          'EXECUTE') AS allowed
        FROM (VALUES ('public'), ('buddha_app')) AS r(role) ORDER BY 1`);
      expect(grants).toEqual([
        { role: 'buddha_app', allowed: false },
        { role: 'public', allowed: false },
      ]);
      expect(
        await t.db
          .select({ userId: balances.userId })
          .from(balances)
          .where(inArray(balances.userId, [a.id, b.id])),
      ).toHaveLength(2);
    });
  });

  describe('records', () => {
    it('never changes or removes an event or a ledger account, whoever writes', async () => {
      const { user: a } = await createUser(t.db, { balanceCoin: 100n });
      const [entry] = await t.db.select().from(ledgerEntries);
      const [account] = await t.db.select().from(ledgerAccounts);
      for (const statement of [
        sql`UPDATE ledger_entries SET memo = 'x' WHERE id = ${entry!.id}`,
        sql`DELETE FROM ledger_entries WHERE id = ${entry!.id}`,
        sql`UPDATE ledger_accounts SET owner_id = owner_id WHERE id = ${account!.id}`,
        sql`DELETE FROM ledger_accounts WHERE id = ${account!.id}`,
      ]) {
        await expect(t.db.execute(statement)).rejects.toSatisfy((e) => sqlState(e) === '42501');
      }
      for (const statement of [
        `UPDATE ledger_entries SET memo = 'x' WHERE id = ${entry!.id}`,
        `DELETE FROM ledger_entries WHERE id = ${entry!.id}`,
        `UPDATE ledger_accounts SET created_at = now() WHERE id = ${account!.id}`,
        `DELETE FROM ledger_accounts WHERE id = ${account!.id}`,
      ]) {
        await expect(migrate.query(statement), statement).rejects.toSatisfy(
          (e) => sqlState(e) === '23000' && /is a permanent record/.test(errorMessage(e)),
        );
      }
      expect(await ledgerOf(t.db, a.id)).toHaveLength(1);
    });

    it('gives a person a user ledger account, and the 운영 마켓메이커 none but its funds', async () => {
      const { user: member } = await createUser(t.db);
      const { user: admin } = await createUser(t.db, { role: 'admin' });
      const marketMaker = await createMarketMakerAccount(t.db);
      const market = await createMarket(t.db);
      for (const id of [member.id, admin.id]) {
        expect(await findLedgerAccount(t.db, { kind: 'user', userId: id })).toMatchObject({
          kind: 'user',
          ownerId: id,
        });
      }
      expect(await findLedgerAccount(t.db, { kind: 'user', userId: marketMaker })).toBeNull();
      await expect(
        t.db.transaction((tx) => ensureLedgerAccount(tx, { kind: 'user', userId: marketMaker })),
      ).rejects.toSatisfy((e) => codeOf(e) === 'account_missing');
      // Whoever writes: a user account is a person's, a 마켓메이커 자금 the operating account's.
      const refused = (e: unknown) => sqlState(e) === '23000';
      await expect(
        t.db.insert(ledgerAccounts).values({ kind: 'user', ownerId: marketMaker }),
      ).rejects.toSatisfy(refused);
      await expect(
        t.db
          .insert(ledgerAccounts)
          .values({ kind: 'market_maker_funds', ownerId: member.id, marketId: market.id }),
      ).rejects.toSatisfy(refused);
      await expect(
        t.db.insert(ledgerAccounts).values({ kind: 'user', ownerId: member.id }),
      ).rejects.toSatisfy((e) => sqlConstraint(e) === 'ledger_accounts_user_uidx');
      await expect(
        t.db.insert(ledgerAccounts).values({ kind: 'treasury', marketId: market.id }),
      ).rejects.toSatisfy((e) => sqlConstraint(e) === 'ledger_accounts_shape_check');
      // Whose an account is, by the one rule (#115): the treasury, the collateral and the funds
      // belong to no person.
      await fund({ kind: 'market_maker_funds', marketId: market.id }, 10n);
      await t.db.transaction((tx) =>
        ensureLedgerAccount(tx, { kind: 'market_collateral', marketId: market.id }),
      );
      const rows = await t.db
        .select({ kind: ledgerAccounts.kind, human: isHumanAccountSql(ledgerAccounts.ownerId) })
        .from(ledgerAccounts);
      expect(
        Object.fromEntries(rows.map((row) => [`${row.kind}:${String(row.human)}`, true])),
      ).toEqual({
        'user:true': true,
        'treasury:false': true,
        'market_maker_funds:false': true,
        'market_collateral:false': true,
      });
      expect(
        await t.db
          .select()
          .from(ledgerAccounts)
          .where(
            and(
              eq(ledgerAccounts.kind, 'market_maker_funds'),
              eq(ledgerAccounts.ownerId, marketMaker),
            ),
          ),
      ).toHaveLength(1);
    });

    it('makes one treasury and one collateral and funds per market, however many race', async () => {
      await createMarketMakerAccount(t.db);
      const market = await createMarket(t.db);
      const refs: LedgerAccountRef[] = [
        { kind: 'treasury' },
        { kind: 'market_collateral', marketId: market.id },
        { kind: 'market_maker_funds', marketId: market.id },
      ];
      for (const ref of refs) {
        const made = await Promise.all(
          Array.from({ length: 4 }, () => t.db.transaction((tx) => ensureLedgerAccount(tx, ref))),
        );
        expect(new Set(made.map((account) => account.id)).size, ref.kind).toBe(1);
      }
      // Besides the user account of the market's creator.
      const system = await t.db
        .select({ id: ledgerAccounts.id })
        .from(ledgerAccounts)
        .where(ne(ledgerAccounts.kind, 'user'));
      expect(system).toHaveLength(3);
      expect(
        await t.db
          .select()
          .from(balances)
          .where(
            inArray(
              balances.accountId,
              system.map((row) => row.id),
            ),
          ),
      ).toHaveLength(3);
      // Locked in ascending id whatever the order asked, each with its balance.
      const locked = await t.db.transaction((tx) => lockLedgerAccounts(tx, [...refs].reverse()));
      expect(locked.map(({ account }) => account.kind)).toEqual([
        'market_maker_funds',
        'market_collateral',
        'treasury',
      ]);
    });

    it('reads its own tables, never an app session’s temporary ones by the same names', async () => {
      // PUBLIC may create temporary tables, and a session's pg_temp is searched first for a
      // relation unless the search path puts it last: 0060's guards fix theirs, and
      // `ledger_account_last_after` names its table's schema, so tables of buddha_app's own answer
      // none of them (0034, Codex review on PR #220).
      const operating = await createMarketMakerAccount(t.db);
      const { user: a } = await createUser(t.db, { balanceCoin: 100n });
      const [own] = await t.db.select().from(balances).where(eq(balances.userId, a.id));
      const session = new Client({ connectionString: testDbUrls()!.appUrl });
      await session.connect();
      try {
        for (const statement of [
          `CREATE TEMP TABLE ledger_entries (id bigint, from_account_id bigint, to_account_id bigint,
             from_balance_after_coin bigint, to_balance_after_coin bigint)`,
          'CREATE TEMP TABLE balances (account_id bigint, ledger_coin bigint)',
          'CREATE TEMP TABLE ledger_accounts (id bigint, kind text, owner_id text, market_id uuid)',
          'CREATE TEMP TABLE "user" (id text, account_type account_type)',
        ]) {
          await session.query(statement);
        }
        await session.query('INSERT INTO pg_temp.balances VALUES ($1, 100)', [own!.accountId]);
        await session.query(
          `INSERT INTO pg_temp.ledger_accounts VALUES ($1, 'treasury', NULL, NULL)`,
          [own!.accountId],
        );
        await session.query(`INSERT INTO pg_temp."user" VALUES ($1, 'member')`, [operating]);
        // A balance changed with no event, its own `balances` keeping the ledger total at 100.
        await expect(
          session.query(
            `UPDATE public.balances SET available_coin = available_coin + 1000000,
               ledger_coin = ledger_coin + 1000000 WHERE account_id = $1`,
            [own!.accountId],
          ),
        ).rejects.toSatisfy(
          (e) =>
            sqlState(e) === '23000' &&
            /carries 1000100 Coin as its ledger total, but its ledger says 100$/.test(
              errorMessage(e),
            ),
        );
        // A 금고 발행 into a person's account, its own `ledger_accounts` calling it the treasury.
        await session.query('BEGIN');
        await session.query(
          `UPDATE public.balances SET available_coin = available_coin + 5,
             ledger_coin = ledger_coin + 5 WHERE account_id = $1`,
          [own!.accountId],
        );
        await expect(
          session.query(
            `INSERT INTO public.ledger_entries (type, amount_coin, to_account_id,
               to_balance_after_coin, ref_type, ref_id, idempotency_key)
             VALUES ('TREASURY_MINT', 5, $1, 105, 'approval_request', $2, $2)`,
            [own!.accountId, randomUUID()],
          ),
        ).rejects.toSatisfy((e) => /does not move Coin from a mint to user/.test(errorMessage(e)));
        await session.query('ROLLBACK');
        // A user ledger account for the 운영 마켓메이커, a member by its own "user".
        await expect(
          session.query(`INSERT INTO public.ledger_accounts (kind, owner_id) VALUES ('user', $1)`, [
            operating,
          ]),
        ).rejects.toSatisfy((e) => /is not a person's/.test(errorMessage(e)));
      } finally {
        await session.end();
      }
      expect(await ledgerOf(t.db, a.id)).toHaveLength(1);
      expect(await accountsAgainstLedger()).toEqual([]);
      const { rows } = await t.db.execute<{ name: string; config: string[] | null }>(sql`
        SELECT proname AS name, proconfig AS config FROM pg_proc
        WHERE proname IN ('create_profile_for_user', 'ledger_accounts_check',
          'ledger_accounts_open_balance', 'ledger_balances_agree', 'ledger_entries_check',
          'ledger_entries_closed_account', 'profiles_closed_completely', 'start_grants_keep_record')
        ORDER BY proname`);
      expect(rows).toEqual(
        [
          'create_profile_for_user',
          'ledger_accounts_check',
          'ledger_accounts_open_balance',
          'ledger_balances_agree',
          'ledger_entries_check',
          'ledger_entries_closed_account',
          'profiles_closed_completely',
          'start_grants_keep_record',
        ].map((name) => ({ name, config: ['search_path=pg_catalog, public, pg_temp'] })),
      );
    });

    it('takes no fill or settlement payout into a closed account (#126 relies on it)', async () => {
      const market = await createMarket(t.db);
      const { user: a } = await createUser(t.db, { balanceCoin: 100n });
      const { user: gone } = await createUser(t.db);
      await closeAccount(t.db, gone.id);
      await fund({ kind: 'market_collateral', marketId: market.id }, 100n);
      const closed = (e: unknown) => /takes no entry after the closure/.test(errorMessage(e));
      await expect(
        record({
          type: 'TRADE_FILL',
          amountCoin: 10n,
          from: { kind: 'user', userId: a.id },
          to: { kind: 'user', userId: gone.id },
          marketId: market.id,
        }),
      ).rejects.toSatisfy(closed);
      await expect(
        record({
          type: 'SETTLEMENT_PAYOUT',
          amountCoin: 10n,
          from: { kind: 'market_collateral', marketId: market.id },
          to: { kind: 'user', userId: gone.id },
        }),
      ).rejects.toSatisfy(closed);
      expect(await ledgerOf(t.db, gone.id)).toEqual([]);
    });
  });

  it('conserves Coin through every kind of event: held = minted − burned, collateral = pairs × 100', async () => {
    // ADR-0107 결정 2 #73: 모든 원장 계정 합 = 발행 − 소각, 시장 담보 = 미정산 쌍 × 100.
    await createMarketMakerAccount(t.db);
    const market = await createMarket(t.db);
    const collateral = { kind: 'market_collateral', marketId: market.id } as const;
    const funds = { kind: 'market_maker_funds', marketId: market.id } as const;
    let pairs = 0n;
    const check = async (step: string) => {
      const supply = await ledgerSupply(t.db);
      expect(supply.heldCoin, step).toBe(supply.mintedCoin - supply.burnedCoin);
      expect(supply.carriedCoin, step).toBe(supply.mintedCoin - supply.burnedCoin);
      expect((await ledgerAccountBalance(t.db, collateral))?.availableCoin ?? 0n, step).toBe(
        pairs * 100n,
      );
      expect(await accountsAgainstLedger(), step).toEqual([]);
    };

    await fund({ kind: 'treasury' }, 1_000n); // 금고 발행
    await record({
      type: 'BOT_ALLOCATION',
      amountCoin: 600n,
      from: { kind: 'treasury' },
      to: funds,
    });
    await check('allocation');
    const { user: a } = await createUser(t.db, { balanceCoin: 1_000n });
    const { user: b } = await createUser(t.db, { balanceCoin: 1_000n });
    await check('start grants');
    const userB = { kind: 'user', userId: b.id } as const;
    await t.db.transaction((tx) => lockCoin(tx, userB, 400n));
    await check('order lock (no event)');
    await t.db.transaction((tx) => releaseCoin(tx, userB, 400n));
    await check('order lock released');
    const marketMaker = await createMarketMakerAccount(t.db);
    await mintTestPairs(t.db, {
      marketId: market.id,
      yesHolderId: a.id,
      noHolderId: marketMaker,
      qty: 3,
      yesPriceCoin: 60,
    });
    pairs += 3n;
    await check('pair mint (a 60 × 3, the bot 40 × 3)');
    await mintTestPairs(t.db, {
      marketId: market.id,
      yesHolderId: marketMaker,
      noHolderId: b.id,
      qty: 1,
    });
    pairs += 1n;
    await check('pair mint (the bot 50 × 1, b 50 × 1)');
    await record({
      type: 'TRADE_FILL',
      amountCoin: 50n,
      from: { kind: 'user', userId: b.id },
      to: { kind: 'user', userId: a.id },
      marketId: market.id,
    });
    await check('fill');
    const burned = await t.db.transaction((tx) =>
      burnMarketMakerPairs(tx, { marketId: market.id, burnId: randomUUID(), qty: 1 }),
    );
    expect(burned.outcome).toBe('burned');
    pairs -= 1n;
    await check('pair burn (the bot’s one YES·NO pair)');
    await record({
      type: 'SETTLEMENT_PAYOUT',
      amountCoin: 200n,
      from: collateral,
      to: { kind: 'user', userId: b.id },
      idempotencyKey: ledgerKeys.settlement(market.id, 1, b.id, 'YES'),
    });
    pairs -= 2n;
    await check('settlement');
    const left = (await ledgerAccountBalance(t.db, funds))!.availableCoin;
    await record({ type: 'BOT_RECALL', amountCoin: left, from: funds, to: { kind: 'treasury' } });
    await check('recall');
    await recordLegacyCorrectionForTest({
      amountCoin: 5n,
      from: { kind: 'treasury' },
      to: { kind: 'user', userId: b.id },
      refType: 'audit_failure',
      refId: randomUUID(),
      idempotencyKey: randomUUID(),
    });
    await check('correction');
    await record({ type: 'DEPOSIT', amountCoin: 300n, from: null, to: userB, refType: 'payment' });
    await record({ type: 'BONUS', amountCoin: 20n, from: null, to: userB, refType: 'coupon' });
    const cancel = await record({
      type: 'PAYMENT_CANCEL',
      amountCoin: 300n,
      from: userB,
      to: null,
      refType: 'payment',
    });
    await record({
      type: 'PAYMENT_CANCEL_REVERSAL',
      amountCoin: 300n,
      from: null,
      to: userB,
      refType: 'payment',
      idempotencyKey: ledgerKeys.paymentCancelReversal(cancel.entry.id),
    });
    await check('kept payment types');
    await closeAccount(t.db, a.id);
    await check('closure');
    const supply = await ledgerSupply(t.db);
    // Minted: the treasury 1,000, two grants 2,000 and the kept 620; burned: a's forfeiture and
    // the cancelled 300.
    expect(supply.mintedCoin).toBe(1_000n + 2_000n + 300n + 20n + 300n);
    const forfeited = (await ledgerOf(t.db, a.id)).at(-1)!;
    expect(forfeited).toMatchObject({ type: 'CLOSURE_FORFEIT', balanceAfterCoin: 0n });
    expect(supply.burnedCoin).toBe(-forfeited.amountCoin + 300n);
  });
});
