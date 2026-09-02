/**
 * Drizzle schema root. Every table/enum module under src/schema/ is re-exported here so
 * that drizzle-kit (drizzle.config.ts -> schema) and the ORM (createDb -> schema) see the
 * same objects.
 *
 * M0: intentionally empty. M1 adds the better-auth tables and profiles; later milestones
 * add the tables from PLAN 6.2.
 *
 * Conventions (PLAN 0.2): P amounts are `bigint({ mode: "bigint" })`, prices are
 * `smallint`, quantities are `integer`, LMSR liquidity is `numeric`, timestamps are
 * `timestamp({ withTimezone: true, mode: "date" })`, ids are `uuid().defaultRandom()`.
 */
export {};
