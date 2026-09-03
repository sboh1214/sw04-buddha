-- Custom SQL migration file, put your code below! --

-- PLAN 5.6 / 6.4: ledger_entries, market_events and admin_actions are append-only.
-- docker/postgres/init/01-roles.sql grants buddha_app SELECT/INSERT/UPDATE/DELETE on every
-- table buddha_migrate creates (default privileges, applied at CREATE time in 0000_init), so
-- this REVOKE, issued by the table owner, leaves INSERT/SELECT only. The role must exist in
-- every environment the migrations run against (docker, CI, and later RDS).
REVOKE UPDATE, DELETE ON TABLE "ledger_entries", "market_events", "admin_actions" FROM buddha_app;
