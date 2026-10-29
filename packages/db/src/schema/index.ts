/**
 * Drizzle schema root. Every table/enum module under src/schema/ is re-exported here so
 * that drizzle-kit (drizzle.config.ts -> schema) and the ORM (createDb -> schema) see the
 * same objects.
 *
 * Conventions (PLAN 0.2): Coin amounts are `bigint({ mode: 'bigint' })`, prices are
 * `smallint`, quantities are `integer`, timestamps are the `timestampTz()` helper from
 * columns.ts — never a bare `timestamp()`, whose microseconds a JS Date cannot hold — ids are
 * `uuid().defaultRandom()` or `bigserial` for append-only logs. Column names: TS camelCase -> DB snake_case via
 * `casing: 'snake_case'` (drizzle.config.ts and createDb must agree). better-auth tables
 * (auth.ts) declare explicit snake_case names and are managed by better-auth (PLAN 6.1).
 */
export * from './admin-actions.js';
export * from './approval-requests.js';
export * from './audit-failures.js';
export * from './auth.js';
export * from './balances.js';
export * from './categories.js';
export * from './charge-packages.js';
export * from './consent-records.js';
export * from './coupons.js';
export * from './enums.js';
export * from './fills.js';
export * from './interest-categories.js';
export * from './ledger.js';
export * from './likes.js';
export * from './link-review.js';
export * from './market-events.js';
export * from './market-links.js';
export * from './market-searches.js';
export * from './market-settlement-steps.js';
export * from './markets.js';
export * from './media-deletions.js';
export * from './media-objects.js';
export * from './moderation.js';
export * from './nickname-holds.js';
export * from './notices.js';
export * from './orders.js';
export * from './payment-events.js';
export * from './payments.js';
export * from './phone-verifications.js';
export * from './positions.js';
export * from './post-comments.js';
export * from './posts.js';
export * from './price-ticks.js';
export * from './profiles.js';
export * from './relations.js';
export * from './release-settings.js';
export * from './retention-purges.js';
export * from './start-grants.js';
export * from './themes.js';
export * from './watchlist.js';
export * from './write-limits.js';
