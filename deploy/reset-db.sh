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
# it starts.
#
# The dump lives exactly as long as it can be needed (owner decision, ADR-0048): deleted once every
# step has succeeded, kept — and its path printed — when any step fails or the run is interrupted,
# for the restore in docs/RESET.md. Safe to re-run after a failure: a second run dumps, wipes and
# seeds again, and deletes only its own dump; the failed run's stays until it is removed by hand.
set -euo pipefail

ROOT=/data/buddha
# Where the pre-reset dump goes: the data volume, beside ROOT, as terraform/README.md's manual
# pg_dump does.
DUMPS=/data

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

# The dump holds the testers' emails, names and phone numbers: owner-only. It sits on /data, so
# the daily snapshots carry it while it exists.
umask 077
DUMP="$DUMPS/buddha-pre-reset-$(date +%Y%m%d-%H%M%S).dump"
# A dump that did not finish restores nothing, and nothing has been touched yet: any way out of
# this step, a failure or an interruption, drops it.
trap 'rm -f "$DUMP"' EXIT
if ! docker compose exec -T postgres pg_dump -U postgres -Fc buddha >"$DUMP"; then
  echo "reset-db.sh: pg_dump failed; nothing was changed" >&2
  exit 1
fi
echo "reset-db.sh: dump written to $DUMP"

# From here on the dump is the way back. EXIT rather than ERR: an interrupted run (Ctrl-C, a
# dropped SSM session) keeps it too.
trap 'echo "reset-db.sh: failed; the pre-reset dump is kept at $DUMP for the restore in docs/RESET.md. api and worker may be stopped: fix the cause and re-run, or start them with: docker compose -f $ROOT/compose.yaml up -d" >&2' EXIT

docker compose stop api worker
docker compose run --rm --no-deps migrate node packages/db/dist/wipe-cli.js --yes
docker compose exec -T redis redis-cli FLUSHALL
# The service's own command: pending migrations (normally none), then the seed.
docker compose run --rm migrate
docker compose up -d --wait --wait-timeout 300

# Every step succeeded: the data the dump held is gone on purpose, so the dump goes too.
trap - EXIT
rm -f "$DUMP"
docker compose ps
echo "reset-db.sh: done; deleted the pre-reset dump $DUMP. Check the site (docs/RESET.md)."
# A failed run's dump outlives the re-run that finished its job; name it, never delete it here.
for kept in "$DUMPS"/buddha-pre-reset-*.dump; do
  if [ -e "$kept" ]; then echo "reset-db.sh: an earlier run's dump is still on disk: $kept"; fi
done
