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
--                   market_watch_events, retention_purges: INSERT/SELECT only; release_settings,
--                   approval_requests, start_grants, start_grant_numbers: no DELETE —
--                   approval_requests' retention goes through a SECURITY DEFINER function, 0044;
--                   market_searches, phone_verification_refused_sends, consent_records,
--                   post_revisions, post_comment_revisions, post_likes, comment_likes,
--                   notice_revisions, profile_item_removals, restriction_end_changes,
--                   write_limit_events, link_uses: no UPDATE; link_flags: no UPDATE but of its
--                   review_action_id column; post_comment_counts: SELECT only, written by its
--                   trigger) are applied later by migrations with REVOKE (0001, 0015, 0020, 0021,
--                   0023, 0026, 0030, 0031, 0032, 0033, 0034, 0035, 0036, 0039, 0040, 0041,
--                   0044), see bottom.

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
-- (approval_requests: DELETE), 0023 (market_watch_events: UPDATE, DELETE), 0026
-- (market_searches: UPDATE), 0030 (phone_verification_refused_sends: UPDATE), 0031
-- (start_grants, start_grant_numbers: DELETE), 0032 (consent_records: UPDATE), 0033
-- (post_revisions: UPDATE), 0034 (post_comment_revisions: UPDATE; post_comment_counts: INSERT,
-- UPDATE, DELETE — its SECURITY DEFINER trigger writes it as the owner), 0035 (post_likes,
-- comment_likes: UPDATE), 0036 (notice_revisions: UPDATE), 0039 (profile_item_removals: UPDATE),
-- 0040 (restriction_end_changes: UPDATE), 0041 (write_limit_events, link_uses, link_flags:
-- UPDATE — then GRANT UPDATE (review_action_id) ON link_flags, an operator's mark '확인함') and
-- 0044 (retention_purges: UPDATE, DELETE).
-- Default privileges are applied at CREATE time, so a REVOKE afterwards sticks.
