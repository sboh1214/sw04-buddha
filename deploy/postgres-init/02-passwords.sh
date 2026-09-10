#!/bin/sh
# Runs once, on the first start of the postgres container (empty data directory), right after the
# unchanged repo file 01-roles.sql created buddha_migrate / buddha_app with the LOCAL-ONLY password
# 'buddha'. Replaces both with the Terraform-generated values from the environment. The temporary
# server that runs init scripts listens on the unix socket only, so the interim password is never
# reachable over the network. psql `:'var'` quoting keeps the values out of SQL string parsing.
set -eu
: "${BUDDHA_APP_PASSWORD:?BUDDHA_APP_PASSWORD is not set}"
: "${BUDDHA_MIGRATE_PASSWORD:?BUDDHA_MIGRATE_PASSWORD is not set}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_pw="$BUDDHA_APP_PASSWORD" -v migrate_pw="$BUDDHA_MIGRATE_PASSWORD" <<'SQL'
ALTER ROLE buddha_app PASSWORD :'app_pw';
ALTER ROLE buddha_migrate PASSWORD :'migrate_pw';
SQL
