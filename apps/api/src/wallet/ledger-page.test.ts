/**
 * The wallet's page query (#69, ADR-0144) as SQL text: no database. What is fixed here is the
 * shape — which side of the account each kind walks and with which types (from the one table of
 * kinds), the filters as predicates of every walk, UNION ALL only when no kind is asked — and the
 * fill ids picked in JS, never cast in SQL. wallet.controller.test.ts reads the rows.
 */
import {
  LEDGER_FILTER_KINDS,
  LEDGER_KIND_SOURCES,
  RECENT_PERIOD_HOURS,
  type Keyset,
} from '@buddha/shared';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { fillIdsOf, ledgerBranches, ledgerPageIdsSql } from './ledger-page.js';

/** As the app's handle writes it: `casing` is what `createDb` (@buddha/db client.ts) passes. */
const render = (query: ReturnType<typeof ledgerPageIdsSql>) =>
  new PgDialect({ casing: 'snake_case' }).sqlToQuery(query);

const ACCOUNT = 4242;
const MARKET = '3f1a5b6c-1111-4222-8333-444455556666';
const count = (text: string, part: string) => text.split(part).length - 1;

describe('ledgerPageIdsSql (#69)', () => {
  it('walks both sides of the account, every type, and puts them together with UNION ALL', () => {
    const { sql, params } = render(ledgerPageIdsSql(ACCOUNT, {}, undefined, 21));
    expect(count(sql, '"ledger_entries"."from_account_id" = $')).toBe(1);
    expect(count(sql, '"ledger_entries"."to_account_id" = $')).toBe(1);
    expect(count(sql, ' UNION ALL ')).toBe(1);
    // No type is asked, and neither walk is an OR over the two sides.
    expect(sql).not.toContain('"ledger_entries"."type"');
    expect(sql.toLowerCase()).not.toContain(' or ');
    // Each walk and the whole are ordered by the cursor's key and cut at the page size.
    expect(
      count(sql, 'ORDER BY "ledger_entries"."created_at" DESC, "ledger_entries"."id" DESC'),
    ).toBe(2);
    expect(sql).toContain('ORDER BY page.created_at DESC, page.id DESC');
    expect(params).toEqual([ACCOUNT, 21, ACCOUNT, 21, 21]);
    // An array the outer read looks its rows up by, one column.
    expect(sql).toMatch(/^ARRAY\(\s*SELECT page\.id\s/);
  });

  it('walks one side for a kind, with the kind’s types there and no UNION', () => {
    for (const kind of LEDGER_FILTER_KINDS) {
      const [branch, ...rest] = ledgerBranches(kind);
      expect(rest, kind).toEqual([]);
      expect(
        branch!.types?.map((type) => `${type}/${branch!.side}`),
        kind,
      ).toEqual(LEDGER_KIND_SOURCES[kind].map((source) => `${source.type}/${source.side}`));
      const { sql, params } = render(ledgerPageIdsSql(ACCOUNT, { kind }, undefined, 21));
      const other = branch!.side === 'from' ? 'to' : 'from';
      expect(sql, kind).toContain(`"ledger_entries"."${branch!.side}_account_id" = $1`);
      expect(sql, kind).not.toContain(`"ledger_entries"."${other}_account_id"`);
      expect(sql, kind).not.toContain('UNION');
      expect(sql, kind).toContain('"ledger_entries"."type" in (');
      expect(params, kind).toEqual([ACCOUNT, ...branch!.types!, 21, 21]);
    }
    // 매수 체결 is the buyer's side of both a pair mint and a trade (결과 4).
    const { params } = render(ledgerPageIdsSql(ACCOUNT, { kind: 'BUY_FILL' }, undefined, 5));
    expect(params).toEqual([ACCOUNT, 'PAIR_MINT_COLLATERAL', 'TRADE_FILL', 5, 5]);
    expect(ledgerBranches(undefined).map((branch) => branch.side)).toEqual(['from', 'to']);
  });

  it('puts the market, the period and the cursor in every walk, as bound parameters', () => {
    const keyset: Keyset = { createdAt: new Date('2026-11-17T01:02:03.004Z'), id: '99' };
    const { sql, params } = render(
      ledgerPageIdsSql(ACCOUNT, { marketId: MARKET, period: '30d' }, keyset, 11),
    );
    expect(count(sql, '"ledger_entries"."market_id" = $')).toBe(2);
    expect(count(sql, `"ledger_entries"."created_at" > now() - $`)).toBe(2);
    expect(count(sql, '("ledger_entries"."created_at", "ledger_entries"."id") < (')).toBe(2);
    const walk = [
      ACCOUNT,
      MARKET,
      RECENT_PERIOD_HOURS['30d'],
      keyset.createdAt.toISOString(),
      '99',
      11,
    ];
    expect(params).toEqual([...walk, ...walk, 11]);
    // Nothing of the request is spliced into the text.
    expect(sql).not.toContain(MARKET);
    expect(sql).not.toContain('2026-11-17');
  });
});

describe('fillIdsOf (#69)', () => {
  it('picks the fill references shaped as a positive bigint, once each, and nothing else', () => {
    expect(
      fillIdsOf([
        { refType: 'fill', refId: '17' },
        { refType: 'fill', refId: '17' },
        { refType: 'fill', refId: '9007199254740991' },
        // Not a fill's: a grant's uuid, a market's, a payment's, a correction's, an entry's id.
        { refType: 'start_grant', refId: '3f1a5b6c-1111-4222-8333-444455556666' },
        { refType: 'market', refId: MARKET },
        { refType: 'payment', refId: '3f1a5b6c-1111-4222-8333-444455556667' },
        { refType: 'reconciliation_correction', refId: 'legacy:12' },
        { refType: 'ledger_entry', refId: '18' },
        // A fill reference of another shape is never read: no cast may meet it.
        { refType: 'fill', refId: '0' },
        { refType: 'fill', refId: '017' },
        { refType: 'fill', refId: '-3' },
        { refType: 'fill', refId: '1.5' },
        { refType: 'fill', refId: '12 ' },
        { refType: 'fill', refId: '' },
        { refType: 'fill', refId: '9007199254740993' },
        { refType: 'fill', refId: '1234567890123456789' },
      ]),
    ).toEqual([17, 9007199254740991]);
  });
});
