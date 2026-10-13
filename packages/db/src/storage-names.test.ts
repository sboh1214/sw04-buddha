import {
  ADMIN_ACTION_TYPES,
  ALL_CATEGORY_SLUGS,
  AUDIT_FAILURE_KINDS,
  LEDGER_REF_TYPES,
  MARKET_EVENT_TYPES,
  PAYMENT_EVENT_TYPES,
  PAYMENT_PROVIDERS,
  RELEASE_SETTINGS,
  SETTLEMENT_STEPS,
  SETTLEMENT_STEP_STATUSES,
  findExcludedIdentifier,
  identifierWords,
  namesPersonalProbability,
  tokenForms,
} from '@buddha/shared';
import { is } from 'drizzle-orm';
import { PgTable, getTableConfig, isPgEnum } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from './schema/index.js';

/**
 * What the plan leaves out must not come back as stored data (#113): no table, column,
 * constraint, index or enum, and no value a varchar column holds from a fixed list, names an
 * excluded feature of EXCLUDED_FEATURES (@buddha/shared) — a Forecast or a belief, a score, rank
 * or badge, an activity reward, a transfer between users, a cash withdrawal. An activity reward
 * or a transfer would most likely arrive as a ledger entry type, which is an enum value here:
 * named for a reward, a check-in or a transfer it fails on the tokens, and named for a bonus
 * (LIKE_BONUS, TRADE_VOLUME_BONUS) it fails unless BONUS_VALUES lists it.
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
};

/**
 * The stored values that may name a bonus, with why. 'bonus' cannot be a token of the activity
 * reward: the starting Coin is the product's own (N01 §2), and so a bonus-named value is held to
 * this list instead. A new one is added here with its reason, which a reviewer reads.
 */
const BONUS_VALUES: Readonly<Record<string, string>> = {
  BONUS:
    'ledger_entry_type: the starting Coin every verified account gets once (N01 §2, ' +
    'SIGNUP_BONUS_COIN) and the kept coupon redemption (D9, ADR-0049)',
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

/**
 * The tables whose rows belong to one person: the user row itself and every table that points at
 * it or at one of their orders (a fill is the order's).
 */
function personalTables() {
  return TABLES.filter(
    (table) =>
      table.name === 'user' ||
      table.foreignKeys.some((fk) =>
        ['user', 'orders'].includes(getTableConfig(fk.reference().foreignTable).name),
      ),
  );
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

  it('names a bonus in a stored value only where BONUS_VALUES says why', () => {
    const values = storageNames().filter(({ where }) => where.endsWith(' value'));
    expect(values.map(({ name }) => name)).toEqual(
      expect.arrayContaining(Object.keys(BONUS_VALUES)),
    );
    const hits = values
      .filter(({ name }) => identifierWords(name).some((word) => BONUS_FORMS.includes(word)))
      .filter(({ name }) => !(name in BONUS_VALUES))
      .map(({ where, name }) => `${where} ${name}`);
    expect(hits).toEqual([]);
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

  it('keeps no buy input or fill price as a personal probability (N02 §10, N04 §5)', () => {
    const tables = personalTables();
    expect(tables.map((table) => table.name)).toEqual(
      expect.arrayContaining(['user', 'profiles', 'balances', 'orders', 'fills', 'positions']),
    );
    const hits = tables.flatMap((table) => [
      ...(namesPersonalProbability(table.name) ? [table.name] : []),
      ...table.columns
        .filter((column) => namesPersonalProbability(column.name))
        .map((column) => `${table.name}.${column.name}`),
    ]);
    expect(hits).toEqual([]);
  });
});
