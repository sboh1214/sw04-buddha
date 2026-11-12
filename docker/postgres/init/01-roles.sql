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
--                   market_watch_events, retention_purges, tags, market_rule_versions,
--                   market_judgements, market_judgement_delays, ledger_accounts, fills, position_settlements, reconciliation_results,
--                   reconciliation_recoveries, market_conflict_declarations, market_liquidity_versions, treasury_issuances,
--                   market_maker_allocations, market_maker_runs, market_maker_recalls, market_maker_controls): INSERT/SELECT only;
--                   reconciliation_corrections: no INSERT, UPDATE, DELETE (only its guarded function writes);
--                   market_maker_supply_pending, market_maker_supply_states,
--                   market_maker_supply_intervals: SELECT only, written by their observer triggers;
--                   balances: SELECT and UPDATE of available_coin,
--                   locked_coin, ledger_coin and updated_at only, its rows opened by a trigger;
--                   release_settings, approval_requests, start_grants, start_grant_numbers,
--                   themes, theme_notices, market_pauses, market_disputes, orders, reconciliation_holds,
--                   market_maker_runtime, market_maker_open_attempts: no DELETE —
--                   approval_requests' retention goes through a SECURITY DEFINER function, 0044,
--                   market_disputes' empties a row in place; market_searches,
--                   phone_verification_refused_sends, consent_records, post_revisions,
--                   post_comment_revisions, post_likes, comment_likes, notice_revisions,
--                   profile_item_removals, restriction_end_changes, write_limit_events,
--                   link_uses: no UPDATE; link_flags: no UPDATE but of its review_action_id
--                   column; post_comment_counts: SELECT only, written by its trigger) are
--                   applied later by migrations with REVOKE
--                   (0001, 0015, 0020, 0021, 0023, 0026, 0030, 0031, 0032, 0033, 0034, 0035,
--                   0036, 0039, 0040, 0041, 0044, 0045, 0049, 0053, 0054, 0055, 0056, 0058,
--                   0060, 0062, 0064, 0065, 0066, 0067, 0069, 0070, 0072, 0073),
--                   see bottom.

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
-- UPDATE — then GRANT UPDATE (review_action_id) ON link_flags, an operator's mark '확인함'),
-- 0044 (retention_purges: UPDATE, DELETE), 0045 (themes, theme_notices: DELETE), 0049 (tags:
-- UPDATE, DELETE — a tag is never renamed or deleted, #17), 0053 (market_rule_versions: UPDATE,
-- DELETE — a rule version is a permanent fact, #80; a trigger refuses both to every role), 0054
-- (market_pauses: DELETE — a pause is a permanent fact, #114; a trigger refuses it to every role
-- and lets an UPDATE only end a lasting pause, once), 0055 (market_judgements: UPDATE, DELETE —
-- a judgement is a permanent fact, #152; a trigger refuses both to every role), 0056
-- (market_disputes: DELETE — a 판정 이의 is a permanent fact, #175; a trigger refuses it to every
-- role and lets an UPDATE only end a pending dispute — decided, retracted or, since 0057 (#176, no
-- REVOKE of its own), closed by a correction — or send an accepted one back to pending (0057), or
-- the retention empty an ended one in place, once), 0058 (market_judgement_delays: UPDATE,
-- DELETE — a 판정 지연 기록 is a permanent fact, #142: a change is a new record, none withdrawn; a
-- trigger refuses both to every role) and 0060 (#116: ledger_accounts: UPDATE, DELETE — a ledger
-- account is never changed or removed, a trigger refuses both to every role and lets only a
-- person's account own a `user` one; balances: INSERT, UPDATE, DELETE — then GRANT UPDATE
-- (available_coin, locked_coin, ledger_coin, updated_at), its rows opened at 0 by a SECURITY
-- DEFINER trigger on ledger_accounts, its total moved only with its ledger total (ledger_coin) at
-- every UPDATE and that held to the ledger at COMMIT; ledger_entries keeps 0001's REVOKE and gains
-- a trigger that refuses UPDATE and DELETE to every role) and 0062 (#119: orders: DELETE — an order
-- is a permanent record, a trigger refuses DELETE to every role and lets an UPDATE only move a
-- resting order forward, its terms frozen; fills: UPDATE, DELETE — a fill is a permanent fact, a
-- trigger refuses both to every role).
-- 0064 (position_settlements: UPDATE, DELETE) and 0065 (reconciliation_results and
-- reconciliation_recoveries: UPDATE, DELETE; reconciliation_holds: DELETE;
-- reconciliation_corrections: INSERT, UPDATE, DELETE). Immutable evidence
-- stays permanent; only a newer failure or approved recovery may advance an active hold.
-- 0066 (market_conflict_declarations: UPDATE, DELETE): a declaration is permanent evidence.
-- 0067 (market_liquidity_versions: UPDATE, DELETE): settings versions are permanent facts.
-- 0069 (treasury_issuances, market_maker_allocations, market_maker_runs: UPDATE, DELETE;
-- market_maker_runtime, market_maker_open_attempts: DELETE): approved financial records and
-- execution observations are retained. Initial runtime is bound to the approved allocation.
-- 0070 (market_maker_recalls: UPDATE, DELETE): each terminal full return or zero completion
-- is permanent and bound to its exact same-transaction BOT_RECALL, if any.
-- 0072 (market_maker_supply_pending, market_maker_supply_states,
-- market_maker_supply_intervals: INSERT, UPDATE, DELETE): only SECURITY DEFINER
-- observation triggers coalesce pending book changes and write final observations.
-- 0073 (market_maker_controls: UPDATE, DELETE): completed two-person controls are permanent.
-- Default privileges are applied at CREATE time, so a REVOKE afterwards sticks.
