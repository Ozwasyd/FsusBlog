#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."

provider="${1:-sqlite}"
case "$provider" in
    sqlite|postgres|mysql) ;;
    *) printf 'Usage: %s [sqlite|postgres|mysql]\n' "$0" >&2; exit 2 ;;
esac
if [[ "${PGHOST:-}" != /* || -z "${PGUSER:-}" || -z "${FSUSBLOG_TEST_DB:-}" ]]; then
    printf '%s\n' 'Set a disposable PostgreSQL maintenance DSN and matching Unix socket/client variables.' >&2
    exit 2
fi
if [[ -n "${PG_TOOLS_DIR:-}" ]]; then PATH="$PG_TOOLS_DIR:$PATH"; fi
if [[ "$provider" == mysql ]]; then
    # shellcheck source=tests/Integration/Migration/mysql-scratch.sh
    source tests/Integration/Migration/mysql-scratch.sh
    check_mysql_tools
fi

umask 077
scratch="$(mktemp -d /tmp/fsusv2-admin-import.XXXXXXXX)"
scratch="$(cd "$scratch" && pwd -P)"
candidate="fsusv2_import_admin_$(openssl rand -hex 10)"
same_cluster="${candidate}_source"
restored="${candidate}_restored"
maintenance=(psql -X -q --no-password -v ON_ERROR_STOP=1 -d postgres)
created=()
secondary_started=0
cleanup() {
    local code=$? db
    if [[ "$secondary_started" == 1 && -f "$scratch/source-data/postmaster.pid" ]] &&
        ! pg_ctl -D "$scratch/source-data" -w -t 15 stop -m fast >/dev/null; then
        printf 'Could not stop owned PostgreSQL source. Preserving %s\n' "$scratch" >&2; exit 1
    fi
    if [[ "$provider" == mysql ]] && ! stop_mysql_scratch "$scratch"; then
        printf 'Could not stop owned MySQL source. Preserving %s\n' "$scratch" >&2; exit 1
    fi
    for db in ${created[@]+"${created[@]}"}; do
        "${maintenance[@]}" -c "DROP DATABASE \"$db\" WITH (FORCE)" >/dev/null || code=1
    done
    find "$scratch" -depth -delete || code=1
    exit "$code"
}
trap cleanup EXIT
trap 'printf "Legacy administrator rehearsal failed on %s at line %s.\n" "$provider" "$LINENO" >&2' ERR

"${maintenance[@]}" -c "CREATE DATABASE \"$candidate\" TEMPLATE template0"
created+=("$candidate")
target=(psql -X -q --no-password -v ON_ERROR_STOP=1 -d "$candidate")
export FSUSBLOG_IMPORT_DB="${FSUSBLOG_TEST_DB%;};Database=$candidate"
export FSUSBLOG_DB="$FSUSBLOG_IMPORT_DB" PGDATABASE="$candidate"

fixture=tests/Integration/Migration/legacy-identity-fixture.sql
cat > "$scratch/selected.sql" <<'SQL'
ALTER TABLE admin_principal ADD COLUMN displayname varchar(96);
ALTER TABLE admin_principal ADD COLUMN createdatutc timestamp;
ALTER TABLE admin_principal ADD COLUMN lastloginatutc timestamp;
ALTER TABLE admin_principal ADD COLUMN totpverifiedatutc timestamp;
INSERT INTO admin_principal (id,handle,status,validationversion,isroot,permissions,totpenabled,totpsecretencrypted,totpverifiedatutc) VALUES
    (8,'approved-writer','active',17,false,'article.write
system.config',false,NULL,NULL),
    (9,'factor-history','active',2,false,'article.write',false,NULL,'2026-10-01 00:00:00'),
    (10,'unsupported-audit','active',2,false,'audit.investigate',false,NULL,NULL),
    (11,'unknown-privilege','active',2,false,'fixture-unregistered-grant',false,NULL,NULL);
UPDATE admin_principal SET createdatutc='2026-10-01 00:00:00',displayname='Fixture legacy administrator';
INSERT INTO admin_passkey_credential VALUES
    (3,8,'fixture-selected-old-key-id','fixture-selected-old-user-handle','fixture-selected-old-public-key',3,false,false);
INSERT INTO admin_session VALUES
    ('fixture-selected-old-session-id',8,'fixture-selected-old-session-hash',17,NULL,'2037-10-01 00:00:00','2037-10-02 00:00:00');
SQL
case "$provider" in
    sqlite)
        export FSUSBLOG_V1_SQLITE_PATH="$scratch/source.sqlite"
        source_sql=(sqlite3 -bail "$FSUSBLOG_V1_SQLITE_PATH")
        cat "$fixture" "$scratch/selected.sql" | "${source_sql[@]}"
        cp "$FSUSBLOG_V1_SQLITE_PATH" "$scratch/original.sqlite"
        ;;
    postgres)
        "${maintenance[@]}" -c "CREATE DATABASE \"$same_cluster\" TEMPLATE template0"
        created+=("$same_cluster")
        psql -X -q --no-password -v ON_ERROR_STOP=1 -d "$same_cluster" -f "$fixture" -f "$scratch/selected.sql"
        same_cluster_dsn="${FSUSBLOG_TEST_DB%;};Database=$same_cluster;Options=-c default_transaction_read_only=on"
        mkdir "$scratch/source-socket"
        initdb -D "$scratch/source-data" -U source_owner --auth=trust --no-locale -E UTF8 > "$scratch/source-init.log"
        secondary_started=1
        source_port=54932
        pg_ctl -D "$scratch/source-data" -l "$scratch/source-pg.log" -w -t 15 \
            -o "-c listen_addresses='' -c unix_socket_directories='$scratch/source-socket' -p $source_port" start >/dev/null
        source_admin=(psql -X -q --no-password -v ON_ERROR_STOP=1 -h "$scratch/source-socket" -p "$source_port" -U source_owner -d postgres)
        "${source_admin[@]}" -f "$fixture" -f "$scratch/selected.sql"
        "${source_admin[@]}" -c 'CREATE ROLE fsus_read LOGIN;
            GRANT SELECT ON public.admin_principal TO fsus_read;
            GRANT SELECT (adminprincipalid) ON public.admin_passkey_credential, public.admin_session TO fsus_read;
            GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO fsus_read'
        export FSUSBLOG_V1_DB="Host=$scratch/source-socket;Port=$source_port;Database=postgres;Username=fsus_read;SSL Mode=Disable;Options=-c default_transaction_read_only=on"
        export FSUSBLOG_V1_SCHEMA=public
        source_sql=("${source_admin[@]}" -Atc)
        source_read=(psql -X -q --no-password -v ON_ERROR_STOP=1 -h "$scratch/source-socket" -p "$source_port" -U fsus_read -d postgres -Atc)
        ;;
    mysql)
        start_mysql_scratch "$scratch"
        "${mysql_admin[@]}" -e "CREATE DATABASE $candidate CHARACTER SET utf8mb4; CREATE USER 'fsus_read'@'localhost'"
        cat "$fixture" "$scratch/selected.sql" | "${mysql_admin[@]}" "$candidate"
        "${mysql_admin[@]}" "$candidate" -e "GRANT SELECT ON $candidate.admin_principal TO 'fsus_read'@'localhost';
            GRANT SELECT (adminprincipalid) ON $candidate.admin_passkey_credential TO 'fsus_read'@'localhost';
            GRANT SELECT (adminprincipalid) ON $candidate.admin_session TO 'fsus_read'@'localhost'"
        export FSUSBLOG_V1_DB="Server=$scratch/mysql.sock;Protocol=Unix;User ID=fsus_read;Database=$candidate;SSL Mode=Disabled"
        source_sql=("${mysql_admin[@]}" "$candidate" -NB -e)
        source_read=(mysql --no-defaults --no-login-paths --protocol=SOCKET --socket="$scratch/mysql.sock"
            --user=fsus_read "$candidate" -NB -e)
        ;;
esac

dotnet="${DOTNET_BIN:-dotnet}"
export DOTNET_BIN="$dotnet" FSUSBLOG_MIGRATE_DLL=src/Migrate/bin/Debug/net10.0/FsusBlogV2.Migrate.dll
project=src/Migrate/FsusBlogV2.Migrate.csproj
migrate=("$dotnet" "$FSUSBLOG_MIGRATE_DLL")
"$dotnet" restore "$project" --configfile NuGet.Config --locked-mode
"$dotnet" build "$project" --no-restore
"${migrate[@]}" plan > "$scratch/bootstrap.json"
"${migrate[@]}" apply "$scratch/bootstrap.json"
target_site="$("${target[@]}" -Atc 'SELECT site_id FROM public.authoring_recovery_site WHERE singleton')"
source_site=800f43ec-3c0a-43e9-8ee0-30e2b79fa162
target_first=0672a1fe-2eb5-4a8a-b213-784494f64811
target_second=732800c6-eff3-4a5c-81c2-13f9e9c1d1b1
mkdir "$scratch/backup" "$scratch/media"
result="$(python3 tools/site-backup.py capture "$scratch/backup" before-admin "$scratch/media")"
backup_digest="${result##* }"
backup="$scratch/backup/before-admin"
[[ "$backup_digest" =~ ^[0-9a-f]{64}$ ]]
python3 tools/site-backup.py verify "$backup" "$backup_digest"

digest() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
expect_refused() {
    if "$@" > "$scratch/refused.json" 2> "$scratch/error.log"; then
        printf '%s\n' 'Expected the isolated administrator rehearsal to refuse this invocation.' >&2
        return 1
    fi
    [[ -s "$scratch/error.log" || -s "$scratch/refused.json" ]]
}
if [[ "$provider" != sqlite ]]; then
    expect_refused "${source_read[@]}" 'SELECT credentialid FROM admin_passkey_credential'
    expect_refused "${source_read[@]}" 'SELECT accesstokenhash FROM admin_session'
fi
candidate_state() {
    "${target[@]}" -Atc "SELECT version,
        (SELECT count(*) FROM public.admin_principal),
        (SELECT count(*) FROM public.admin_permission),
        (SELECT count(*) FROM public.admin_passkey_credential),
        (SELECT count(*) FROM public.admin_invitation),
        (SELECT count(*) FROM public.admin_challenge),
        (SELECT count(*) FROM public.admin_session),
        (SELECT count(*) FROM public.blog_user),
        to_regnamespace('fsus_legacy_candidate') IS NOT NULL FROM public.v2_schema"
}
initial="$(candidate_state)"
[[ "$initial" == '1|0|0|0|0|0|0|0|f' ]]
source_state_sql="SELECT id,handle,status,validationversion FROM admin_principal ORDER BY id"
source_before="$("${source_sql[@]}" "$source_state_sql")"

plan=("${migrate[@]}" legacy admin plan "$provider" "$source_site" "$target_site" "$backup" "$backup_digest")
if [[ "$provider" == postgres ]]; then
    FSUSBLOG_V1_DB="$same_cluster_dsn" expect_refused "${plan[@]}" 8 5000000007
    rg -qi 'same.*(instance|cluster)|separate.*(instance|cluster)|distinct.*(instance|cluster)' "$scratch/error.log"
fi
expect_refused "${migrate[@]}" legacy admin plan "$provider" "$source_site" "$source_site" "$backup" "$backup_digest" 8
for id in 7 9 10 11; do
    expect_refused "${plan[@]}" "$id"
    rg -Fq 'root, MFA, or unsupported authority' "$scratch/error.log"
done
expect_refused "${plan[@]}" 12
rg -Fq 'selected old independent administrator is absent' "$scratch/error.log"
expect_refused "${plan[@]}" 8 8
"${plan[@]}" 5000000007 8 > "$scratch/draft.json"
[[ "$(candidate_state)" == "$initial" ]]
python3 - "$scratch/draft.json" "$scratch/review.json" "$scratch/colliding.json" "$scratch/altered.json" \
    "$provider" "$source_site" "$target_site" "$backup_digest" "$target_first" "$target_second" <<'PY'
import copy
import json
import re
import sys
from pathlib import Path

draft_path, review_path, duplicate_path, altered_path, provider, source, target, backup, first, second = sys.argv[1:]
raw = Path(draft_path).read_text()
draft = json.loads(raw)
assert draft["sourceReference"] == "2605b438eed8f16d12ddddf033d08a6fa18fcd12", draft
assert draft["provider"] == provider and draft["readyToApply"] is False, draft
assert draft["sourceSiteId"] == source and draft["targetSiteId"] == target and draft["backupManifestSha256"] == backup, draft
assert all(re.fullmatch(r"[0-9a-f]{64}", draft[key]) for key in (
    "sourceDatabaseSha256", "targetDatabaseSha256", "targetSchemaSha256"
)), draft
assert draft["principals"] == [
    {"sourceAdminId": 8, "sourceHandle": "approved-writer", "sourceStatus": "active", "sourceGeneration": 17,
     "sourceGrants": ["article.write", "system.config"], "sourcePasskeys": 1, "sourceSessions": 1, "targetAdminId": None},
    {"sourceAdminId": 5000000007, "sourceHandle": "fixture-disabled-admin", "sourceStatus": "disabled", "sourceGeneration": 2,
     "sourceGrants": [], "sourcePasskeys": 0, "sourceSessions": 0, "targetAdminId": None},
], draft
assert all(secret not in raw for secret in (
    "fixture-selected-old", "fixture-admin-totp-ciphertext", "fixture-residual-password-hash"
))
for item, target_id in zip(draft["principals"], (first, second)):
    item["targetAdminId"] = target_id
Path(review_path).write_text(json.dumps(draft))
duplicate = copy.deepcopy(draft)
duplicate["principals"][1]["targetAdminId"] = first
Path(duplicate_path).write_text(json.dumps(duplicate))
draft["principals"][0]["sourceGrants"].append("admin.manage")
Path(altered_path).write_text(json.dumps(draft))
PY
chmod 400 "$scratch/review.json"
review_digest="$(digest "$scratch/review.json")"
stage=("${migrate[@]}" legacy admin stage "$scratch/review.json" "$review_digest" "$backup" "$backup_digest")
verify=("${migrate[@]}" legacy admin verify "$scratch/review.json" "$review_digest" "$backup" "$backup_digest")
expect_refused "${verify[@]}" "$review_digest"
expect_refused "${migrate[@]}" legacy admin stage "$scratch/draft.json" "$(digest "$scratch/draft.json")" "$backup" "$backup_digest"
expect_refused "${migrate[@]}" legacy admin stage "$scratch/colliding.json" "$(digest "$scratch/colliding.json")" "$backup" "$backup_digest"
expect_refused "${migrate[@]}" legacy admin stage "$scratch/altered.json" "$(digest "$scratch/altered.json")" "$backup" "$backup_digest"
expect_refused "${migrate[@]}" legacy admin stage "$scratch/review.json" "$backup_digest" "$backup" "$backup_digest"
expect_refused "${migrate[@]}" legacy admin stage "$scratch/review.json" "$review_digest" "$backup" "$review_digest"
ln -s "$scratch/review.json" "$scratch/linked-review.json"
expect_refused "${migrate[@]}" legacy admin stage "$scratch/linked-review.json" "$review_digest" "$backup" "$backup_digest"
"${target[@]}" -c "INSERT INTO public.blog_user VALUES ('$target_first','Unreviewed account',false,true,1)"
expect_refused "${stage[@]}"
"${target[@]}" -c "DELETE FROM public.blog_user WHERE id='$target_first'"
"${target[@]}" -c "UPDATE public.site_page_content SET revision=1, markdown='Unreviewed fixture page' WHERE slug='about'"
expect_refused "${stage[@]}"
"${target[@]}" -c "UPDATE public.site_page_content SET revision=0, markdown=NULL WHERE slug='about'"
"${source_sql[@]}" 'UPDATE admin_principal SET validationversion=18 WHERE id=8' >/dev/null
expect_refused "${stage[@]}"
rg -Fq 'old administrator records no longer match the reviewed source' "$scratch/error.log"
if [[ "$provider" == sqlite ]]; then
    cp "$scratch/original.sqlite" "$FSUSBLOG_V1_SQLITE_PATH"
else
    "${source_sql[@]}" 'UPDATE admin_principal SET validationversion=17 WHERE id=8' >/dev/null
fi
[[ "$(candidate_state)" == "$initial" ]]

"${stage[@]}" > "$scratch/staged.json"
"${stage[@]}" > "$scratch/revalidated.json"
candidate_digest="$(python3 -c 'import json, sys; print(json.load(sys.stdin)["candidateSha256"])' < "$scratch/staged.json")"
[[ "$candidate_digest" =~ ^[0-9a-f]{64}$ ]]
expect_refused "${verify[@]}" "$review_digest"
verify+=("$candidate_digest")
(
    unset FSUSBLOG_V1_DB FSUSBLOG_V1_SCHEMA FSUSBLOG_V1_SQLITE_PATH
    FSUSBLOG_IMPORT_DB="$FSUSBLOG_IMPORT_DB;Options=-c default_transaction_read_only=on" "${verify[@]}"
) > "$scratch/verified.json"
python3 - "$review_digest" "$scratch/staged.json" "$scratch/revalidated.json" "$scratch/verified.json" <<'PY'
import json
import re
import sys
from pathlib import Path

receipts = [json.loads(Path(path).read_text()) for path in sys.argv[2:]]
assert [item["result"] for item in receipts] == ["staged", "revalidated", "verified"]
assert all(item["reviewSha256"] == sys.argv[1] and item["readyToApply"] is False and item["principals"] == 2
           for item in receipts), receipts
assert len({item["candidateSha256"] for item in receipts}) == 1
assert re.fullmatch(r"[0-9a-f]{64}", receipts[0]["candidateSha256"])
PY
[[ "$(candidate_state)" == '-1|2|0|0|0|0|0|0|t' ]]
principals="$("${target[@]}" -Atc "SELECT id,handle,enabled,generation,octet_length(user_handle)
    FROM public.admin_principal ORDER BY handle")"
[[ "$principals" == "$target_first|approved-writer|f|17|32"$'\n'"$target_second|fixture-disabled-admin|f|2|32" ]]
[[ "$("${target[@]}" -Atc 'SELECT count(DISTINCT user_handle) FROM public.admin_principal')" == 2 ]]
[[ "$("${target[@]}" -Atc 'SELECT count(*) FROM fsus_legacy_candidate.admin_rehearsal_principal')" == 2 ]]
[[ "$("${target[@]}" -Atc 'SELECT count(*) FROM fsus_legacy_candidate.admin_rehearsal_receipt')" == 1 ]]
expect_refused "${migrate[@]}" verify
rg -F 'isolated legacy import candidate and cannot serve' "$scratch/error.log"
expect_refused "${migrate[@]}" admin-identity bootstrap do-not-activate admin.manage
[[ "$(candidate_state)" == '-1|2|0|0|0|0|0|0|t' ]]

"${target[@]}" -c "UPDATE public.admin_principal SET enabled=true WHERE id='$target_first'"
expect_refused "${verify[@]}"
expect_refused "${stage[@]}"
"${target[@]}" -c "UPDATE public.admin_principal SET enabled=false WHERE id='$target_first'"
"${target[@]}" -c "UPDATE fsus_legacy_candidate.admin_rehearsal_principal SET source_passkeys=2 WHERE source_admin_id=8"
expect_refused "${verify[@]}"
"${target[@]}" -c "UPDATE fsus_legacy_candidate.admin_rehearsal_principal SET source_passkeys=1 WHERE source_admin_id=8"
"${target[@]}" -c "UPDATE fsus_legacy_candidate.admin_rehearsal_receipt SET candidate_sha256='$review_digest' WHERE singleton"
expect_refused "${verify[@]}"
"${target[@]}" -c "UPDATE fsus_legacy_candidate.admin_rehearsal_receipt SET candidate_sha256='$candidate_digest' WHERE singleton"
"${target[@]}" -c 'ALTER TABLE fsus_legacy_candidate.admin_rehearsal_receipt
    DROP CONSTRAINT admin_rehearsal_nonserving,
    ADD CONSTRAINT admin_rehearsal_nonserving CHECK (true)'
expect_refused "${verify[@]}"
"${target[@]}" -c 'ALTER TABLE fsus_legacy_candidate.admin_rehearsal_receipt
    DROP CONSTRAINT admin_rehearsal_nonserving,
    ADD CONSTRAINT admin_rehearsal_nonserving CHECK (serving=false)'
"${verify[@]}" > /dev/null
[[ "$("${source_sql[@]}" "$source_state_sql")" == "$source_before" ]]
if [[ "$provider" == sqlite ]]; then
    cmp "$scratch/original.sqlite" "$FSUSBLOG_V1_SQLITE_PATH"
fi
"${maintenance[@]}" -c "CREATE DATABASE \"$restored\" TEMPLATE template0"
created+=("$restored")
pg_restore --no-password --single-transaction --exit-on-error --no-owner --no-privileges \
    --dbname "$restored" "$backup/database.dump"
FSUSBLOG_DB="${FSUSBLOG_TEST_DB%;};Database=$restored" PGDATABASE="$restored" \
    python3 tools/site-backup.py verify-restored "$backup" "$backup_digest" "$scratch/media"
printf 'Legacy administrator rehearsal passed on %s, with explicit identities, source-independent verification, permanent quarantine and independent restore.\n' "$provider"
