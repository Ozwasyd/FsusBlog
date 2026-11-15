#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/../../.."

if [[ -n ${PG_TOOLS_DIR:-} ]]; then export PATH="$PG_TOOLS_DIR:$PATH"; fi
migrate=("${DOTNET_BIN:-dotnet}" "${FSUSBLOG_MIGRATE_DLL:-src/Migrate/bin/Release/net10.0/FsusBlogV2.Migrate.dll}")
if [[ ! -f ${migrate[1]} ]]; then
    printf 'Missing prebuilt migration DLL %s\n' "${migrate[1]}" >&2
    exit 2
fi
for command in initdb pg_ctl psql "${migrate[0]}"; do command -v "$command" >/dev/null; done

scratch=$(mktemp -d /tmp/fsusv2-read-total.XXXXXXXX)
scratch=$(cd "$scratch" && pwd -P)
cleanup() {
    local status=$?
    trap - EXIT
    if pg_ctl -D "$scratch/data" status >/dev/null 2>&1; then
        if ! pg_ctl -D "$scratch/data" -m fast -w -t 20 stop >> "$scratch/postgres.log" 2>&1; then
            printf 'Could not stop the owned test cluster at %s\n' "$scratch" >&2
            exit 1
        fi
    fi
    find "$scratch" -depth -delete || status=1
    if (( status == 0 )); then printf '%s\n' 'Removed the owned PostgreSQL cluster and scratch files.'; fi
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

unset PGHOSTADDR PGSERVICE PGSERVICEFILE PGOPTIONS PGPASSWORD PGPASSFILE PGSSLMODE
export LC_ALL=C PGHOST="$scratch/socket" PGPORT=54935 PGUSER=fsusv2_read_fixture PGDATABASE=postgres
export FSUSBLOG_DB="Host=$PGHOST;Port=$PGPORT;Username=$PGUSER;Database=$PGDATABASE;SSL Mode=Disable"
mkdir "$PGHOST"
initdb -D "$scratch/data" -U "$PGUSER" --auth-local=trust --auth-host=reject --locale=C -E UTF8 > "$scratch/init.log"
pg_ctl -D "$scratch/data" -l "$scratch/postgres.log" -w -t 20 \
    -o "-c listen_addresses='' -p $PGPORT -k $PGHOST -c unix_socket_permissions=0700" start
sql=(psql -X -qAt --no-password -v ON_ERROR_STOP=1)

"${migrate[@]}" plan > "$scratch/plan.json"
"${migrate[@]}" apply "$scratch/plan.json"
"${migrate[@]}" verify
[[ $("${sql[@]}" -c 'SELECT count(*) FROM public.article_read_total') == 0 ]]

# Recreate the previously supported aggregate-only shape without changing the schema marker.
"${sql[@]}" <<'SQL'
BEGIN;
DROP TABLE public.article_read_total;
INSERT INTO public.blog_user VALUES ('65235b8e-5d95-411a-8a9c-d1036d319b71','Read total fixture',true,true,1);
INSERT INTO public.article(id,owner_id,revision,title,body,deleted) OVERRIDING SYSTEM VALUE
    SELECT id,'65235b8e-5d95-411a-8a9c-d1036d319b71',1,'Fixture ' || id,'',false FROM generate_series(42,45) AS articles(id);
INSERT INTO public.article_revision (article_id,revision,title,body,happened_at)
    SELECT id,revision,title,body,'2026-11-13T00:00:00Z' FROM public.article;

INSERT INTO public.article_read_hour VALUES
    (42,'2026-11-13T00:00:00Z',9223372036854775807),
    (42,'2026-11-13T01:00:00Z',9223372036854775807),
    (43,'2026-11-13T00:00:00Z',7),
    (43,'2026-11-13T01:00:00Z',12),
    (44,'2026-11-13T00:00:00Z',19);
INSERT INTO public.article_read_dwell VALUES
    (42,'2026-11-13',0,7),(42,'2026-11-13',1,2),(43,'2026-11-13',3,8),(44,'2026-11-13',1,19);
UPDATE public.article_read_epoch SET last_epoch=42 WHERE singleton;

-- Synthetic legacy seed inputs belong to a distinct relation and must never enter this rollup.
CREATE TABLE public.article_view_seed (article_id integer PRIMARY KEY, views integer NOT NULL);
INSERT INTO public.article_view_seed VALUES (43,1000),(45,2000);
COMMIT;
SQL
"${migrate[@]}" verify
[[ $("${sql[@]}" -c "SELECT to_regclass('public.article_read_total') IS NULL") == t ]]
[[ $("${sql[@]}" -c 'SELECT sum(count) > 9223372036854775807::numeric FROM public.article_read_hour WHERE article_id=42') == t ]]

aggregate_dump() {
    "${sql[@]}" <<'SQL'
SET TIME ZONE 'UTC';
SET DateStyle TO 'ISO, YMD';
COPY (SELECT * FROM public.article_read_hour ORDER BY article_id,hour_utc) TO STDOUT (FORMAT csv, HEADER true);
COPY (SELECT * FROM public.article_read_dwell ORDER BY article_id,day_utc,bucket) TO STDOUT (FORMAT csv, HEADER true);
COPY (SELECT * FROM public.article_read_epoch ORDER BY singleton) TO STDOUT (FORMAT csv, HEADER true);
COPY (SELECT * FROM public.article_view_seed ORDER BY article_id) TO STDOUT (FORMAT csv, HEADER true);
SQL
}

assert_totals() {
    [[ $("${sql[@]}" -c 'SELECT article_id,views FROM public.article_read_total ORDER BY views DESC,article_id DESC') == \
        $'42|2147483647\n44|19\n43|19' ]]
    aggregate_dump > "$scratch/current.csv"
    cmp "$scratch/prior.csv" "$scratch/current.csv"
}

aggregate_dump > "$scratch/prior.csv"
"${migrate[@]}" article read-proof-schema
assert_totals
[[ $("${sql[@]}" -c "SELECT pg_get_indexdef('public.article_read_total_rank'::regclass)") == \
    *'USING btree (views DESC, article_id DESC)' ]]

total_oid=$("${sql[@]}" -c "SELECT 'public.article_read_total'::regclass::oid")
"${sql[@]}" -c 'UPDATE public.article_read_total SET views=1 WHERE article_id=43; INSERT INTO public.article_read_total VALUES (45,900)'
"${migrate[@]}" article read-proof-schema
assert_totals
"${migrate[@]}" article read-proof-schema
assert_totals
[[ $("${sql[@]}" -c "SELECT 'public.article_read_total'::regclass::oid") == "$total_oid" ]]

"${sql[@]}" -c 'DROP INDEX public.article_read_total_rank; CREATE INDEX article_read_total_rank ON public.article_read_total (views DESC,article_id)'
if "${migrate[@]}" article read-proof-schema > "$scratch/rejection.log" 2>&1; then
    printf '%s\n' 'An incorrectly ordered article read total index was accepted.' >&2
    exit 1
fi
if ! grep -Fq 'descending btree index' "$scratch/rejection.log"; then
    cat "$scratch/rejection.log" >&2
    exit 1
fi
assert_totals
"${sql[@]}" -c 'DROP INDEX public.article_read_total_rank; CREATE INDEX article_read_total_rank ON public.article_read_total (views DESC,article_id DESC)'
"${migrate[@]}" verify
printf '%s\n' 'Verified fresh and older read schemas, saturating backfill, descending rank, reconciliation, and unchanged source aggregates.'
