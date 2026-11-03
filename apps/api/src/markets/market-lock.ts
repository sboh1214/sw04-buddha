/**
 * Serialises every writer of one market (PLAN 0.2): the review writes, the pause and its next
 * path (#114), the judgement writes (#152) and the worker's open/close/resolve/finalize jobs all
 * take `pg_advisory_xact_lock(hashtext(market_id))` first.
 * The statement lives in @buddha/db (tx-helpers.ts) since M5 so apps/api and apps/worker lock
 * the same key by the same rule — see the notes there (transaction-scoped, `tx` only, canonical
 * uuid text so two spellings never take two locks).
 */
export { lockMarket } from '@buddha/db';
