import {
  ADMIN_ACTION_TYPES,
  ALL_CATEGORY_SLUGS,
  AUDIT_FAILURE_KINDS,
  CONSENT_ITEMS,
  LEDGER_REF_TYPES,
  MARKET_EVENT_TYPES,
  PAYMENT_EVENT_TYPES,
  PAYMENT_PROVIDERS,
  PHONE_VERIFICATION_SEND_OUTCOMES,
  RELEASE_SETTINGS,
  SETTLEMENT_STEPS,
  SETTLEMENT_STEP_STATUSES,
  START_GRANT_NUMBER_SOURCES,
  WATCH_EVENT_ACTIONS,
  findExcludedIdentifier,
  identifierWords,
  namesPersonalProbability,
  tokenForms,
} from '@buddha/shared';
import { is } from 'drizzle-orm';
import {
  PgTable,
  getTableConfig,
  integer,
  isPgEnum,
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from './schema/index.js';

/**
 * What the plan leaves out must not come back as stored data (#113): no table, column,
 * constraint, index or enum, and no value a varchar column holds from a fixed list, names an
 * excluded feature of EXCLUDED_FEATURES (@buddha/shared) — a Forecast or a belief, a score, rank
 * or badge, an activity reward, a transfer between users, a cash withdrawal. An activity reward
 * or a transfer would most likely arrive as a ledger entry type, which is an enum value here, or
 * as a table or column of its own: named for a reward, a check-in or a transfer it fails on the
 * tokens, and named for a bonus (LIKE_BONUS, TRADE_VOLUME_BONUS, daily_bonuses,
 * bonusClaimedAt) it fails unless BONUS_NAMES lists it.
 *
 * Read from the Drizzle schema objects, the same ones drizzle-kit generates the migrations from,
 * so no database is needed.
 *
 * Paid purchase is not looked for in storage: the payment, charge package and coupon tables,
 * their ledger types and their admin action types stay while sales are closed (D9, ADR-0049) —
 * only screens and public responses must not show them.
 */

const EXPORTS: unknown[] = Object.values(schema);
const TABLES = EXPORTS.filter((value): value is PgTable => is(value, PgTable)).map((table) =>
  getTableConfig(table),
);
const ENUMS = EXPORTS.filter(isPgEnum);

/**
 * The fixed value lists varchar columns hold (a Postgres enum's values come with the enum). A
 * varchar column that takes its values from a new list adds the list here. Left out: each
 * consumer's `approval_requests.kind` (no list yet, #171) and `admin_actions.target_type`, the
 * name of the target's table.
 */
const VARCHAR_VALUES: Readonly<Record<string, readonly string[]>> = {
  'ledger_entries.ref_type': LEDGER_REF_TYPES,
  'payments.provider': PAYMENT_PROVIDERS,
  'payment_events.type': PAYMENT_EVENT_TYPES,
  'market_events.type': MARKET_EVENT_TYPES,
  'market_settlement_steps.step': SETTLEMENT_STEPS,
  'market_settlement_steps.status': SETTLEMENT_STEP_STATUSES,
  'admin_actions.type': ADMIN_ACTION_TYPES,
  'audit_failures.kind': AUDIT_FAILURE_KINDS,
  'categories.slug': ALL_CATEGORY_SLUGS,
  'release_settings.key': [...RELEASE_SETTINGS.keys()],
  'market_watch_events.action': WATCH_EVENT_ACTIONS,
  'phone_verification_codes.send_outcome': PHONE_VERIFICATION_SEND_OUTCOMES,
  'start_grant_numbers.source': START_GRANT_NUMBER_SOURCES,
  'consent_records.item': CONSENT_ITEMS,
};

/**
 * The stored names that may name a bonus — a table, column, constraint, enum or stored value,
 * keyed as storageNames() places them — with why. 'bonus' is a path token of the activity reward
 * only: the coupon's BONUS ledger type is the product's own (ADR-0026), and so a bonus-named
 * stored name is held to this list instead. A new one is added here with its reason, which a
 * reviewer reads.
 */
const BONUS_NAMES: Readonly<Record<string, string>> = {
  'ledger_entry_type value BONUS':
    'the kept coupon redemption (D9, ADR-0049), and the sign-up grant of accounts created before ' +
    '#70. The start Coin has its own START_GRANT type (ADR-0069 decision 4 #70, ADR-0071)',
};
const BONUS_FORMS = tokenForms('bonus');

/** Every stored name, with where it is. */
function storageNames(): { where: string; name: string }[] {
  const names: { where: string; name: string }[] = [];
  for (const table of TABLES) {
    names.push({ where: 'table', name: table.name });
    for (const column of table.columns) {
      names.push({ where: `${table.name} column`, name: column.name });
    }
    const constraints = [
      ...table.indexes.map((index) => index.config.name),
      ...table.checks.map((check) => check.name),
      ...table.uniqueConstraints.map((unique) => unique.name),
      ...table.foreignKeys.map((fk) => fk.getName()),
      ...table.primaryKeys.map((pk) => pk.getName()),
    ];
    for (const name of constraints) {
      if (name !== undefined) names.push({ where: `${table.name} constraint`, name });
    }
  }
  for (const pgEnum of ENUMS) {
    names.push({ where: 'enum', name: pgEnum.enumName });
    for (const value of pgEnum.enumValues) {
      names.push({ where: `${pgEnum.enumName} value`, name: value });
    }
  }
  for (const [column, values] of Object.entries(VARCHAR_VALUES)) {
    for (const value of values) names.push({ where: `${column} value`, name: value });
  }
  return names;
}

/** A column that holds an account, constrained or not: `userId`, `user_id`, `accountId`. */
function holdsAccount(column: string): boolean {
  const words = identifierWords(column);
  return words.some(
    (word, index) => (word === 'user' || word === 'account') && words[index + 1] === 'id',
  );
}

/**
 * The tables whose rows may belong to one person: the user row itself, every table with an
 * account column (a foreign key or not), and every table that points at one of those, directly or
 * through another (a fill is its order's, a payment event its payment's, and so on down).
 */
function personalTables(tables: typeof TABLES = TABLES) {
  const personal = new Set(
    tables.filter(
      (table) => table.name === 'user' || table.columns.some((column) => holdsAccount(column.name)),
    ),
  );
  for (let grew = true; grew;) {
    grew = false;
    for (const table of tables) {
      if (personal.has(table)) continue;
      const points = table.foreignKeys.some((fk) =>
        [...personal].some(
          (owner) => owner.name === getTableConfig(fk.reference().foreignTable).name,
        ),
      );
      if (points) {
        personal.add(table);
        grew = true;
      }
    }
  }
  return [...personal];
}

describe('excluded features in stored data (#113)', () => {
  it('reads the whole schema', () => {
    const tables = TABLES.map((table) => table.name);
    expect(tables).toEqual(
      expect.arrayContaining(['user', 'orders', 'fills', 'positions', 'ledger_entries']),
    );
    expect(ENUMS.map((pgEnum) => pgEnum.enumName)).toContain('ledger_entry_type');
    // Every varchar list names a real column.
    for (const column of Object.keys(VARCHAR_VALUES)) {
      const [table, name] = column.split('.');
      const config = TABLES.find((t) => t.name === table);
      expect(
        config?.columns.some(
          (c) => c.name.replace(/[A-Z]/g, (l) => `_${l.toLowerCase()}`) === name,
        ),
        column,
      ).toBe(true);
    }
  });

  it('names no excluded feature in a table, column, constraint, enum or stored value', () => {
    const hits = storageNames().flatMap(({ where, name }) =>
      findExcludedIdentifier(name, 'storage').map(
        (hit) => `${where} ${name}: ${hit.feature} '${hit.word}'`,
      ),
    );
    expect(hits).toEqual([]);
  });

  it('names a bonus in a stored name only where BONUS_NAMES says why', () => {
    const named = storageNames()
      .filter(({ name }) => identifierWords(name).some((word) => BONUS_FORMS.includes(word)))
      .map(({ where, name }) => `${where} ${name}`);
    // Every line is still needed, and nothing else names a bonus.
    expect(named.sort()).toEqual(Object.keys(BONUS_NAMES).sort());
  });

  it('passes with the payment and coupon structures kept for paid Coin (D9)', () => {
    const tables = TABLES.map((table) => table.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'payments',
        'payment_events',
        'charge_packages',
        'coupons',
        'coupon_redemptions',
      ]),
    );
    // They would name paid purchase on a screen or in a public response, where it is looked for.
    expect(findExcludedIdentifier('charge_packages', 'api').map((hit) => hit.feature)).toEqual([
      'paid-purchase',
    ]);
    expect(findExcludedIdentifier('charge_packages', 'storage')).toEqual([]);
  });

  it('knows a table of one person through another table, or by an unconstrained account', () => {
    const planted = [
      ...TABLES,
      getTableConfig(
        pgTable('fill_marks', {
          fillId: uuid('fill_id').references(() => schema.fills.id),
          probabilityBp: integer('probability_bp'),
        }),
      ),
      getTableConfig(
        pgTable('watch_notes', { ownerUserId: text('owner_user_id'), note: text('note') }),
      ),
    ];
    expect(
      personalTables(planted)
        .map((table) => table.name)
        .filter((name) => ['fill_marks', 'watch_notes'].includes(name))
        .sort(),
    ).toEqual(['fill_marks', 'watch_notes']);
    expect(personalTables().map((table) => table.name)).not.toContain('categories');
  });

  it('keeps no buy input or fill price as a personal probability (N02 §10, N04 §5)', () => {
    const tables = personalTables();
    expect(tables.map((table) => table.name)).toEqual(
      expect.arrayContaining([
        'user',
        'profiles',
        'balances',
        'orders',
        'fills',
        'positions',
        'payment_events',
      ]),
    );
    expect(holdsAccount('userId') && holdsAccount('account_id')).toBe(true);
    expect(holdsAccount('userAgent') || holdsAccount('accountIdentifier')).toBe(false);
    const hits = tables.flatMap((table) => [
      ...(namesPersonalProbability(table.name) ? [table.name] : []),
      ...table.columns
        .filter((column) => namesPersonalProbability(column.name))
        .map((column) => `${table.name}.${column.name}`),
    ]);
    expect(hits).toEqual([]);
  });
});
