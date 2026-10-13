#!/usr/bin/env bash
# Wipe the deployed database and Redis, then refill them with the seed: the reset #149 runs before
# the first market opens, by the procedure in docs/RESET.md. Run as root on the host, from an SSM
# session (`sudo bash /data/buddha/reset-db.sh --yes`). Every account, session, market, order,
# fill, ledger entry and payment row goes; the only way back is the dump this script takes first.
#
#   reset-db.sh --yes     # dump, stop api + worker, wipe Postgres and Redis, migrate + seed, start
#
# The wipe is WIPE_PUBLIC_TABLES_SQL (packages/db/src/wipe.ts), the very statement migration 0017
# ran once when #125 deployed, run by packages/db/dist/wipe-cli.js as buddha_migrate inside the
# deployed api image. Redis is flushed whole: the delayed close/finalize jobs of the deleted
# markets would otherwise fail as "not found", and the worker re-installs its repeatable jobs when
# it starts. Safe to re-run after a failure: a second run dumps, wipes and seeds again.
set -euo pipefail

ROOT=/data/buddha

if [ "${1:-}" != "--yes" ]; then
  echo "reset-db.sh: this deletes every account and all data on this host; pass --yes to run it" >&2
  exit 1
fi

# Same guard as deploy.sh: without /data, compose would start an empty postgres on the root disk.
findmnt -rno TARGET /data >/dev/null || { echo "reset-db.sh: /data is not mounted" >&2; exit 1; }
cd "$ROOT"

# Never while a deploy runs: deploy.sh holds the same lock.
exec 9>"$ROOT/.deploy.lock"
flock -w 600 9

docker compose up -d --wait postgres redis

# The deployed image must carry the wipe CLI (every image built since #125 does). Checked before
# anything is stopped, so an old tag leaves the site serving.
if ! docker compose run --rm --no-deps migrate test -f packages/db/dist/wipe-cli.js; then
  echo "reset-db.sh: the deployed api image has no packages/db/dist/wipe-cli.js; deploy a newer tag first" >&2
  exit 1
fi

# The dump holds the testers' emails, names and phone numbers: owner-only, and delete it once the
# reset is confirmed (docs/RESET.md). It sits on /data, so the daily snapshots carry it meanwhile.
umask 077
DUMP="/data/buddha-pre-reset-$(date +%Y%m%d-%H%M%S).dump"
docker compose exec -T postgres pg_dump -U postgres -Fc buddha >"$DUMP"
echo "reset-db.sh: dump written to $DUMP"

trap 'echo "reset-db.sh: failed; api and worker may be stopped. Fix the cause and re-run, or start them with: docker compose -f $ROOT/compose.yaml up -d" >&2' ERR

docker compose stop api worker
docker compose run --rm --no-deps migrate node packages/db/dist/wipe-cli.js --yes
docker compose exec -T redis redis-cli FLUSHALL
# The service's own command: pending migrations (normally none), then the seed.
docker compose run --rm migrate
docker compose up -d --wait --wait-timeout 300

trap - ERR
docker compose ps
echo "reset-db.sh: done. Check the site, then delete $DUMP"
