#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
if [[ -z "${FSUSBLOG_TEST_DB:-}" || -z "${PGHOST:-}" || -z "${PGUSER:-}" ]]; then
    printf '%s\n' 'Set FSUSBLOG_TEST_DB and libpq variables to the same isolated PostgreSQL cluster.' >&2
    exit 2
fi

dotnet_bin="${DOTNET_BIN:-dotnet}"
if [[ -n "${PG_TOOLS_DIR:-}" ]]; then PATH="$PG_TOOLS_DIR:$PATH"; fi
umask 077
scratch="$(mktemp -d /tmp/fsusv2-backup.XXXXXXXX)"
scratch="$(cd "$scratch" && pwd -P)"
source_db="fsusv2_backup_$(openssl rand -hex 12)"
restore_db="${source_db}_restore"
base="${FSUSBLOG_TEST_DB%;}"
maintenance=(psql -X --no-password -v ON_ERROR_STOP=1 -d postgres)
created_source=0
created_restore=0
media_id=78787a8a12344323875b28dbf8ed16a9
media_leaf="$media_id.media"

cleanup() {
    local code=$?
    if [[ "$created_restore" == 1 ]] && ! "${maintenance[@]}" -c "DROP DATABASE \"$restore_db\""; then
        printf 'Failed to drop owned scratch restore database %s\n' "$restore_db" >&2
        if [[ "$code" == 0 ]]; then code=1; fi
    fi
    if [[ "$created_source" == 1 ]] && ! "${maintenance[@]}" -c "DROP DATABASE \"$source_db\""; then
        printf 'Failed to drop owned scratch source database %s\n' "$source_db" >&2
        if [[ "$code" == 0 ]]; then code=1; fi
    fi
    if ! find "$scratch" -depth -delete; then
        printf 'Failed to remove owned scratch files %s\n' "$scratch" >&2
        if [[ "$code" == 0 ]]; then code=1; fi
    fi
    if [[ "$code" == 0 ]]; then printf '%s\n' 'Owned backup media, files and both test databases removed.'; fi
    exit "$code"
}
trap cleanup EXIT

cli_project="src/Cli/FsusBlog.V2.Cli.csproj"
"$dotnet_bin" restore "$cli_project" --configfile NuGet.Config --locked-mode
"$dotnet_bin" build "$cli_project" --no-restore
export DOTNET_BIN="$dotnet_bin"
export FSUSBLOG_CLI_DLL="src/Cli/bin/Debug/net10.0/FsusBlog.V2.Cli.dll"
migrate=("$DOTNET_BIN" "$FSUSBLOG_CLI_DLL")
backup=(python3 tools/site-backup.py)

"${maintenance[@]}" -c "CREATE DATABASE \"$source_db\" TEMPLATE template0"
created_source=1
"${maintenance[@]}" -c "CREATE DATABASE \"$restore_db\" TEMPLATE template0"
created_restore=1
export FSUSBLOG_DB="$base;Database=$source_db"
export PGDATABASE="$source_db"
"${migrate[@]}" plan > "$scratch/plan.json"
"${migrate[@]}" apply "$scratch/plan.json"
source_sql=(psql -X --no-password -v ON_ERROR_STOP=1 -d "$source_db")
restore_sql=(psql -X --no-password -v ON_ERROR_STOP=1 -d "$restore_db")
mkdir -m 700 "$scratch/input" "$scratch/output" "$scratch/restored"
printf 'Harmless fixture bytes for private recovery verification.\n' > "$scratch/input/$media_leaf"
chmod 400 "$scratch/input/$media_leaf"
bytes="$(wc -c < "$scratch/input/$media_leaf" | tr -d '[:space:]')"
digest="$(shasum -a 256 "$scratch/input/$media_leaf" | awk '{print $1}')"
"${source_sql[@]}" -v bytes="$bytes" -v digest="$digest" -v media_id="$media_id" <<'SQL'
BEGIN;
INSERT INTO public.admin_principal(id,handle,user_handle,enabled,generation)
    VALUES ('20000000-0000-0000-0000-000000000001','backup-test-owner',decode(repeat('11',32),'hex'),true,1);
INSERT INTO public.article(owner_id,revision,title,body,deleted)
    VALUES ('20000000-0000-0000-0000-000000000001',1,'Test title','Fixture private body',false);
INSERT INTO public.article_revision(article_id,revision,title,body,happened_at)
    SELECT id,revision,title,body,clock_timestamp() FROM public.article;
INSERT INTO public.private_media(id,owner_id,command_id,request_hash,content_hash,name,format,length,width,height,phase)
    VALUES (:'media_id','20000000-0000-0000-0000-000000000001',
            '20000000-0000-0000-0000-000000000002',decode(repeat('00',32),'hex'),
            decode(:'digest','hex'),'fixture.png',1,:'bytes',1,1,1);
COMMIT;
SQL

lease_pid=
lease_ready="$scratch/lease-ready"
(
    "${source_sql[@]}" >/dev/null <<SQL
SELECT pg_advisory_lock(716729109726707501);
\! touch '$lease_ready'
SELECT pg_sleep(6);
SQL
) &
lease_pid=$!
for ((iteration=0; iteration<30; ++iteration)); do
    if [[ -f "$lease_ready" ]]; then break; fi
    sleep .1
done
test -f "$lease_ready"
if "${backup[@]}" capture "$scratch/output" live "$scratch/input" > "$scratch/test-error.log" 2>&1; then
    printf '%s\n' 'Live database writer lease unexpectedly accepted.' >&2
    wait "$lease_pid"
    exit 1
fi
wait "$lease_pid"
rg -F 'Stop the v2 writer before measuring a backup.' "$scratch/test-error.log"
test ! -e "$scratch/output/live"

for variable in PGDATABASE PGHOST PGPORT PGSERVICE PGHOSTADDR; do
    if env "$variable=wrong" "${backup[@]}" capture "$scratch/output" wrong-target "$scratch/input" > "$scratch/test-error.log" 2>&1; then
        printf 'Mismatched libpq endpoint variable unexpectedly accepted: %s\n' "$variable" >&2
        exit 1
    fi
    rg -F 'libpq must use the same source database, host and port as FSUSBLOG_DB.' "$scratch/test-error.log"
    test ! -e "$scratch/output/wrong-target"
done
cat > "$scratch/old-pg-dump" <<'SH'
#!/usr/bin/env bash
[[ "${1:-}" == --version ]] || exit 77
printf '%s\n' 'pg_dump (PostgreSQL) 17.0'
SH
chmod 700 "$scratch/old-pg-dump"
if PG_DUMP_BIN="$scratch/old-pg-dump" "${backup[@]}" capture "$scratch/output" wrong-version "$scratch/input" > "$scratch/test-error.log" 2>&1; then
    printf '%s\n' 'Incompatible pg_dump version unexpectedly accepted.' >&2
    exit 1
fi
rg -F 'pg_dump and source PostgreSQL major versions differ.' "$scratch/test-error.log"
test ! -e "$scratch/output/wrong-version"

output=$("${backup[@]}" capture "$scratch/output" candidate "$scratch/input")
manifest="${output##* }"
[[ "$manifest" =~ ^[0-9a-f]{64}$ ]]
candidate="$scratch/output/candidate"
"${backup[@]}" verify "$candidate" "$manifest"
if rg -F 'Fixture private body' "$candidate/manifest.json"; then exit 1; fi
if "${backup[@]}" capture "$scratch/output" candidate "$scratch/input"; then
    printf '%s\n' 'Preexisting candidate unexpectedly overwritten.' >&2
    exit 1
fi
if "${backup[@]}" verify "$candidate" "$(printf '%064d' 0)"; then
    printf '%s\n' 'Wrong manifest digest unexpectedly accepted.' >&2
    exit 1
fi

"${source_sql[@]}" -c 'UPDATE public.private_media SET phase=0'
if "${backup[@]}" capture "$scratch/output" pending "$scratch/input" > "$scratch/test-error.log" 2>&1; then
    printf '%s\n' 'Pending media phase unexpectedly captured.' >&2
    exit 1
fi
rg -F 'Settle pending and removing private media before backup.' "$scratch/test-error.log"
test ! -e "$scratch/output/pending"
"${source_sql[@]}" -c 'UPDATE public.private_media SET phase=1'

if [[ "$("${source_sql[@]}" -qAtc "SELECT pg_catalog.to_regclass('public.private_media_upload_part') IS NOT NULL")" == t ]]; then
    "${source_sql[@]}" <<'SQL'
INSERT INTO public.private_media_upload(id,owner_id,command_id,name,format,length,part_size,digest,expires_at)
    VALUES ('20000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000001',
            '20000000-0000-0000-0000-000000000004','pending.png',1,10,65536,
            decode(repeat('00',32),'hex'),clock_timestamp()+interval '1 hour');
INSERT INTO public.private_media_upload_part(upload_id,part,digest,bytes)
    VALUES ('20000000-0000-0000-0000-000000000003',0,decode(repeat('00',32),'hex'),decode('00','hex'));
SQL
    if "${backup[@]}" capture "$scratch/output" staged "$scratch/input" > "$scratch/test-error.log" 2>&1; then
        printf '%s\n' 'Live upload part unexpectedly captured.' >&2
        exit 1
    fi
    rg -F 'Finish or cancel staged media parts before backup.' "$scratch/test-error.log"
    test ! -e "$scratch/output/staged"
    "${source_sql[@]}" -c 'DELETE FROM public.private_media_upload_part; DELETE FROM public.private_media_upload'
fi

pg_restore --no-password --single-transaction --exit-on-error --no-owner --no-privileges \
    --dbname "$restore_db" "$candidate/database.dump"
cp "$candidate/media/$media_leaf" "$scratch/restored/$media_leaf"
chmod 400 "$scratch/restored/$media_leaf"
export FSUSBLOG_DB="$base;Database=$restore_db"
"${backup[@]}" verify-restored "$candidate" "$manifest" "$scratch/restored"

"${restore_sql[@]}" -c "UPDATE public.article SET body='different restored row'"
if "${backup[@]}" verify-restored "$candidate" "$manifest" "$scratch/restored"; then
    printf '%s\n' 'Different business data unexpectedly verified.' >&2
    exit 1
fi

chmod 600 "$scratch/input/$media_leaf"
printf 'bad data\n' > "$scratch/input/$media_leaf"
export FSUSBLOG_DB="$base;Database=$source_db"
if "${backup[@]}" capture "$scratch/output" changed "$scratch/input"; then
    printf '%s\n' 'Changed media unexpectedly captured.' >&2
    exit 1
fi
test ! -e "$scratch/output/changed"
mv "$candidate/media/$media_leaf" "$scratch/outside.media"
ln -s "$scratch/outside.media" "$candidate/media/$media_leaf"
if "${backup[@]}" verify "$candidate" "$manifest"; then
    printf '%s\n' 'Symlink media unexpectedly accepted.' >&2
    exit 1
fi
printf '%s\n' 'PostgreSQL and media backup candidate drill passed.'
