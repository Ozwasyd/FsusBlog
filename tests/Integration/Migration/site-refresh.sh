#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ -z "${FSUSBLOG_TEST_DB:-}" || -z "${PGHOST:-}" || -z "${PGUSER:-}" || -z "${FSUSBLOG_TEST_MIGRATE_DLL:-}" ]]; then
    printf '%s\n' 'Configure a scratch PostgreSQL cluster and the built migration DLL.' >&2
    exit 2
fi

scratch=$(mktemp -d "${TMPDIR:-/tmp}/fsus-site-refresh.XXXXXXXX")
database="fsusv2_site_refresh_$(openssl rand -hex 12)"
pg=(psql -X --no-password -v ON_ERROR_STOP=1)
migrate=("${DOTNET_BIN:-dotnet}" "$FSUSBLOG_TEST_MIGRATE_DLL")
created=0
lease=''
cleanup() {
    local result=$?
    trap - EXIT
    if [[ -n "$lease" ]]; then
        kill "$lease" 2>/dev/null || true
        wait "$lease" 2>/dev/null || true
    fi
    if (( created == 1 )) && ! "${pg[@]}" -d postgres -qc "DROP DATABASE \"$database\" WITH (FORCE)"; then result=1; fi
    if ! rm -f "$scratch/plan.json" "$scratch/rejection.log" "$scratch/lease.log" || ! rmdir "$scratch"; then result=1; fi
    if (( result == 0 )); then printf '%s\n' 'Removed the site refresh test database and scratch files.'; fi
    exit "$result"
}
trap cleanup EXIT

"${pg[@]}" -d postgres -qc "CREATE DATABASE \"$database\" TEMPLATE template0"
created=1
export FSUSBLOG_DB="${FSUSBLOG_TEST_DB%;};Database=$database"
query=("${pg[@]}" -d "$database" -qAtc)
"${migrate[@]}" plan > "$scratch/plan.json"
"${migrate[@]}" apply "$scratch/plan.json"
"${migrate[@]}" verify
"${migrate[@]}" operator refresh-fixture > /dev/null

"${query[@]}" "INSERT INTO public.user_session(digest,user_id,generation,expires_at)
    SELECT decode(repeat('01',32),'hex'),id,generation,clock_timestamp()+interval '1 hour'
    FROM public.blog_user WHERE name='refresh-fixture';
    DROP TABLE public.site_session_refresh_tombstone"
if "${migrate[@]}" site-refresh schema > "$scratch/rejection.log" 2>&1; then
    printf '%s\n' 'Expected the partial site refresh component to be rejected.' >&2
    exit 1
fi
rg -qF 'The site refresh schema is partially installed.' "$scratch/rejection.log"
"${query[@]}" 'DROP TABLE public.site_session_refresh'
"${migrate[@]}" verify

"${query[@]}" 'SELECT pg_advisory_lock(716729109726707501); SELECT pg_sleep(4)' > "$scratch/lease.log" &
lease=$!
for _ in {1..40}; do
    if [[ $("${query[@]}" "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND granted
        AND database=(SELECT oid FROM pg_database WHERE datname=current_database())") -gt 0 ]]; then break; fi
    sleep .05
done
if "${migrate[@]}" site-refresh schema > "$scratch/rejection.log" 2>&1; then
    printf '%s\n' 'Expected installation to require the serving instance to stop.' >&2
    exit 1
fi
rg -qF 'Stop the serving process' "$scratch/rejection.log"
wait "$lease"
lease=''

"${migrate[@]}" site-refresh schema
"${query[@]}" "INSERT INTO public.site_session_refresh(family_id,access_digest,refresh_digest,generation,
    idle_expires_at,absolute_expires_at,rotated_at)
    SELECT gen_random_uuid(),digest,decode(repeat('02',32),'hex'),1,statement_timestamp()+interval '1 day',
        statement_timestamp()+interval '2 days',statement_timestamp() FROM public.user_session;
    INSERT INTO public.site_session_refresh_tombstone(refresh_digest,family_id,generation,used_at,expires_at)
    SELECT decode(repeat('03',32),'hex'),family_id,0,statement_timestamp(),statement_timestamp()+interval '1 day'
    FROM public.site_session_refresh"
"${migrate[@]}" site-refresh schema
"${migrate[@]}" verify
[[ $("${query[@]}" 'SELECT generation FROM public.site_session_refresh') == 1 ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.site_session_refresh_tombstone') == 1 ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.user_session') == 1 ]]

"${query[@]}" 'ALTER TABLE public.site_session_refresh ADD COLUMN unexpected_fixture integer'
if "${migrate[@]}" site-refresh schema > "$scratch/rejection.log" 2>&1; then
    printf '%s\n' 'Expected drifted site refresh storage to remain untouched.' >&2
    exit 1
fi
rg -qF 'relation/column shape mismatch' "$scratch/rejection.log"
"${query[@]}" 'ALTER TABLE public.site_session_refresh DROP COLUMN unexpected_fixture'
"${migrate[@]}" verify
printf '%s\n' 'Verified fresh site refresh storage, stopped-service upgrade, partial and drifted schema rejection, and idempotent state preservation.'
