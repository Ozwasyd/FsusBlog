#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ -z "${FSUSBLOG_TEST_DB:-}" || -z "${PGHOST:-}" || -z "${PGUSER:-}" || -z "${FSUSBLOG_TEST_MIGRATE_DLL:-}" ]]; then
    printf '%s\n' 'Configure a scratch PostgreSQL cluster and the built migration DLL.' >&2
    exit 2
fi

scratch=$(mktemp -d "${TMPDIR:-/tmp}/fsus-site-recovery-key.XXXXXXXX")
database="fsusv2_site_recovery_$(openssl rand -hex 12)"
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
    if (( result == 0 )); then printf '%s\n' 'Removed the Recovery Key test database and scratch files.'; fi
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
[[ $("${query[@]}" "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN
    ('site_recovery_key','site_recovery_flow','site_recovery_rebind')") == 3 ]]

"${migrate[@]}" operator recovery-fixture > /dev/null
"${query[@]}" "INSERT INTO public.passkey_subject(user_id,user_handle)
    SELECT id,decode(repeat('09',32),'hex') FROM public.blog_user WHERE name='recovery-fixture';
    DROP TABLE public.site_recovery_flow, public.site_recovery_rebind, public.site_recovery_key"
"${migrate[@]}" verify

"${query[@]}" 'SELECT pg_advisory_lock(716729109726707501); SELECT pg_sleep(4)' > "$scratch/lease.log" &
lease=$!
for _ in {1..40}; do
    if [[ $("${query[@]}" "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND granted
        AND database=(SELECT oid FROM pg_database WHERE datname=current_database())") -gt 0 ]]; then break; fi
    sleep .05
done
if "${migrate[@]}" recovery-key schema > "$scratch/rejection.log" 2>&1; then
    printf '%s\n' 'Expected schema initialization to require the serving instance to stop.' >&2
    exit 1
fi
rg -qF 'Stop the serving process' "$scratch/rejection.log"
wait "$lease"
lease=''

"${query[@]}" 'CREATE TABLE public.site_recovery_key (unexpected_fixture integer)'
for command in verify 'recovery-key schema'; do
    # Both operations must fail closed on a partial set of component relations.
    read -r -a arguments <<< "$command"
    if "${migrate[@]}" "${arguments[@]}" > "$scratch/rejection.log" 2>&1; then
        printf '%s\n' 'Expected partial Recovery Key component rejection.' >&2
        exit 1
    fi
    rg -qF 'Recovery Key schema is partially installed' "$scratch/rejection.log"
done
"${query[@]}" 'DROP TABLE public.site_recovery_key'
"${migrate[@]}" recovery-key schema
"${migrate[@]}" verify

"${query[@]}" "INSERT INTO public.site_recovery_key
    SELECT user_id,decode(repeat('01',32),'hex'),decode(repeat('02',16),'hex'),decode(repeat('03',32),'hex'),2,clock_timestamp(),NULL,0,clock_timestamp()
    FROM public.passkey_subject;
    INSERT INTO public.site_recovery_rebind(user_id,generation,ticket_digest,expires_at)
    SELECT user_id,1,decode(repeat('04',32),'hex'),clock_timestamp()+interval '1 minute' FROM public.passkey_subject"
"${migrate[@]}" recovery-key schema
[[ $("${query[@]}" 'SELECT version FROM public.site_recovery_key') == 2 ]]
[[ $("${query[@]}" 'SELECT count(*) FROM public.site_recovery_rebind') == 1 ]]
if "${query[@]}" 'UPDATE public.site_recovery_rebind SET completed_at=clock_timestamp()' > "$scratch/rejection.log" 2>&1; then
    printf '%s\n' 'Expected completion metadata to require a matching request digest.' >&2
    exit 1
fi
rg -qF 'check constraint' "$scratch/rejection.log"
if "${query[@]}" "UPDATE public.site_recovery_rebind SET challenge_digest=decode(repeat('05',32),'hex'),options='{}'" > "$scratch/rejection.log" 2>&1; then
    printf '%s\n' 'Expected a stored Passkey challenge to require an explicit expiry.' >&2
    exit 1
fi
rg -qF 'check constraint' "$scratch/rejection.log"
"${query[@]}" 'ALTER TABLE public.site_recovery_key ADD COLUMN unexpected_fixture integer'
if "${migrate[@]}" recovery-key schema > "$scratch/rejection.log" 2>&1; then
    printf '%s\n' 'Expected drifted Recovery Key storage to remain untouched.' >&2
    exit 1
fi
rg -qF 'relation/column shape mismatch' "$scratch/rejection.log"
"${query[@]}" 'ALTER TABLE public.site_recovery_key DROP COLUMN unexpected_fixture'
"${migrate[@]}" verify
printf '%s\n' 'Verified fresh Recovery Key storage, stopped-service upgrade, partial/drifted component rejection, and idempotent state preservation.'
