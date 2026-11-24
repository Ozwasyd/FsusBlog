#!/usr/bin/env bash
# Run one command in a disposable, socket-only PostgreSQL 18 cluster.
set -euo pipefail
umask 077
[[ $# -gt 0 ]] || { echo 'Usage: with-postgres.sh COMMAND [ARG...]' >&2; exit 2; }
[[ $(id -u) != 0 ]] || { echo 'Run PostgreSQL checks as a non-root user.' >&2; exit 2; }
pg=${PG_TOOLS_DIR:-/usr/lib/postgresql/18/bin}
for tool in initdb pg_ctl postgres psql; do
  [[ -x "$pg/$tool" ]] || { echo "Missing PostgreSQL tool: $pg/$tool" >&2; exit 2; }
done
[[ $("$pg/postgres" --version) =~ PostgreSQL\)\ 18\. ]] || {
  echo 'PostgreSQL 18 is required; refusing a different major version.' >&2; exit 2;
}
command -v setsid >/dev/null
scratch=$(mktemp -d /tmp/fsus-ci-pg.XXXXXXXX)
child= started=0
cleanup() {
  local code=$? stopped=1
  trap - EXIT INT TERM
  if [[ -n "$child" ]] && kill -0 -- "-$child" 2>/dev/null; then
    kill -TERM -- "-$child" 2>/dev/null || true
    for ((i=0; i<50; i++)); do
      kill -0 -- "-$child" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 -- "-$child" 2>/dev/null; then
      kill -KILL -- "-$child" 2>/dev/null || true
    fi
    wait "$child" 2>/dev/null || true
    # A successful command must not leave owned children behind.
    (( code != 0 )) || code=1
  fi
  if (( started )); then
    if ! "$pg/pg_ctl" -D "$scratch/data" -m fast -w stop; then stopped=0; fi
    if "$pg/pg_ctl" -D "$scratch/data" status >/dev/null 2>&1; then stopped=0; fi
  fi
  if (( stopped )); then rm -rf -- "$scratch" || code=1
  else echo "PostgreSQL cleanup failed: $scratch" >&2; code=1; fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir "$scratch/socket"
"$pg/initdb" -D "$scratch/data" -U fsusci --auth-local=trust --auth-host=reject --locale=C -E UTF8 > "$scratch/initdb.log"
started=1
"$pg/pg_ctl" -D "$scratch/data" -l "$scratch/postgres.log" \
  -o "-c listen_addresses='' -c unix_socket_permissions=0700 -k $scratch/socket -p 55432" -w start
unset PGHOSTADDR PGSERVICE PGSERVICEFILE PGPASSWORD PGPASSFILE FSUSBLOG_DB
export PG_TOOLS_DIR="$pg" PATH="$pg:$PATH"
export PGHOST="$scratch/socket" PGPORT=55432 PGUSER=fsusci PGDATABASE=postgres
export FSUSBLOG_TEST_DB="Host=$PGHOST;Port=$PGPORT;Username=$PGUSER;Database=postgres;SSL Mode=Disable"
export FSUSBLOG_TEST_PGHOST="$PGHOST" FSUSBLOG_TEST_PGPORT="$PGPORT" FSUSBLOG_TEST_PGUSER="$PGUSER"
[[ $("$pg/psql" -X -w -Atc 'show server_version_num') =~ ^18[0-9]{4}$ ]]
setsid --wait "$@" &
child=$!
wait "$child"
