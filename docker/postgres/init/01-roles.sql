-- Runs once, on the first start of the postgres container (empty data directory), via
-- psql -v ON_ERROR_STOP=1 as the superuser (POSTGRES_USER) connected to POSTGRES_DB.
-- :"DBNAME" is psql's built-in variable for the connected database, so this file does not
-- hard-code the database name and also serves the `test` profile container.
--
-- Roles (PLAN 6.4):
--   buddha_migrate  DDL. Owns the database (and therefore schema "public" through
--                   pg_database_owner, PG15+) and may create the "drizzle" schema that
--                   holds drizzle.__drizzle_migrations.
--   buddha_app      DML only. No CREATE anywhere. Per-table restrictions
--                   (ledger_entries, market_events, admin_actions, payment_events,
--                   market_watch_events: INSERT/SELECT only; release_settings,
--                   approval_requests: no DELETE) are applied later by migrations with
--                   REVOKE (0001, 0015, 0020, 0021, 0023), see bottom.

CREATE ROLE buddha_migrate LOGIN PASSWORD 'buddha';
CREATE ROLE buddha_app LOGIN PASSWORD 'buddha';

-- Owner of the database == pg_database_owner == owner of schema "public" (PostgreSQL 15+),
-- and the owner implicitly holds CREATE on the database (needed for CREATE SCHEMA drizzle).
ALTER DATABASE :"DBNAME" OWNER TO buddha_migrate;

-- buddha_app: connect + resolve objects in "public"; nothing else (PG15+ already revoked
-- CREATE ON SCHEMA public FROM PUBLIC, so buddha_app cannot create tables).
GRANT CONNECT ON DATABASE :"DBNAME" TO buddha_app;
GRANT USAGE ON SCHEMA public TO buddha_app;

-- Default privileges apply only to objects created by the named role (buddha_migrate),
-- i.e. everything drizzle migrations create in "public" from now on.
ALTER DEFAULT PRIVILEGES FOR ROLE buddha_migrate IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO buddha_app;
ALTER DEFAULT PRIVILEGES FOR ROLE buddha_migrate IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO buddha_app;
ALTER DEFAULT PRIVILEGES FOR ROLE buddha_migrate IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO buddha_app;
ALTER DEFAULT PRIVILEGES FOR ROLE buddha_migrate IN SCHEMA public
  GRANT USAGE ON TYPES TO buddha_app;

-- Objects that might already exist (e.g. a restored dump). No-op on a fresh database.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO buddha_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO buddha_app;

-- Later (M2+), the migration that creates the append-only tables adds, in the same
-- migration file, as buddha_migrate (table owner):
--   REVOKE UPDATE, DELETE ON TABLE ledger_entries, market_events, admin_actions FROM buddha_app;
-- and so do 0015 (payment_events: UPDATE, DELETE), 0020 (release_settings: DELETE), 0021
-- (approval_requests: DELETE) and 0023 (market_watch_events: UPDATE, DELETE).
-- Default privileges are applied at CREATE time, so a REVOKE afterwards sticks.
