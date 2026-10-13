/**
 * Serialises every writer of one market (PLAN 0.2): open, close, resolve and the worker's
 * close/finalize jobs all take `pg_advisory_xact_lock(hashtext(market_id))` first.
 * The statement lives in @buddha/db (tx-helpers.ts) since M5 so apps/api and apps/worker lock
 * the same key by the same rule — see the notes there (transaction-scoped, `tx` only, canonical
 * uuid text so two spellings never take two locks).
 */
export { lockMarket } from '@buddha/db';
