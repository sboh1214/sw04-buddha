/**
 * Empties every table in schema `public` — accounts, sessions and categories included — and
 * restarts their sequences. The schema, the grants and `drizzle.__drizzle_migrations` (another
 * schema) are left alone, so `db:migrate` has nothing to redo and the seed refills the rest. The
 * table list is read from `pg_tables` when the statement runs, so a table a later migration
 * adds is never missed.
 *
 * Migration 0017 runs exactly this statement, once, before it drops the direct AMM's columns and
 * enum values (#125: the deployed database is wiped, accounts too). deploy/reset-db.sh runs it
 * again through wipe-cli.ts (docs/RESET.md; #149 uses that procedure in the scope #133 decides,
 * narrowed first if anything is kept), and the test harness's `reset()` runs it before every
 * DB-backed case; wipe.test.ts fails if the migration's copy drifts from this one or the reset
 * script stops calling the CLI. TRUNCATE is the table owner's privilege: run it as buddha_migrate
 * (or the superuser), never as buddha_app.
 */
export const WIPE_PUBLIC_TABLES_SQL = `DO $$
DECLARE
  table_list text;
BEGIN
  SELECT string_agg(format('%I.%I', schemaname, tablename), ', ' ORDER BY tablename)
    INTO table_list
    FROM pg_tables
   WHERE schemaname = 'public';
  IF table_list IS NOT NULL THEN
    EXECUTE 'TRUNCATE TABLE ' || table_list || ' RESTART IDENTITY CASCADE';
  END IF;
END
$$;`;
