#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."

if [[ -n "${PG_TOOLS_DIR:-}" ]]; then PATH="$PG_TOOLS_DIR:$PATH"; fi
export DOTNET_BIN="${DOTNET_BIN:-dotnet}"
export FSUSBLOG_MIGRATE_DLL="${FSUSBLOG_MIGRATE_DLL:-$PWD/src/Migrate/bin/Debug/net10.0/FsusBlogV2.Migrate.dll}"
migrate=("$DOTNET_BIN" "$FSUSBLOG_MIGRATE_DLL")
prepared=false
activate=false
batch=false
case "$# ${1:-}" in
    '0 ') ;;
    '1 --prepared') prepared=true ;;
    '1 --activate') prepared=true; activate=true ;;
    '1 --activate-batch') prepared=true; activate=true; batch=true ;;
    *) printf 'Usage: %s [--prepared|--activate|--activate-batch]\n' "$0" >&2; exit 2 ;;
esac
[[ -f "$FSUSBLOG_MIGRATE_DLL" ]]
if [[ "$prepared" == true ]]; then
    server_dll="${FSUSBLOG_PREPARER_DLL:?Set FSUSBLOG_PREPARER_DLL to the trusted built Server DLL.}"
    [[ "$server_dll" == /* && -f "$server_dll" ]]
    preparer=(env -i PATH="$PATH" LC_ALL=C TZ=UTC "$DOTNET_BIN" "$server_dll" legacy-media)
fi
if [[ "$activate" == true ]]; then
    runtime_web="${FSUSBLOG_ACTIVATION_TEST_WEB_DIST:?Set FSUSBLOG_ACTIVATION_TEST_WEB_DIST to built web assets.}"
    [[ "$runtime_web" == /* && -f "$runtime_web/index.html" ]]
fi
umask 077
scratch="$(mktemp -d /tmp/fsus-media-join.XXXXXXXX)"
scratch="$(cd "$scratch" && pwd -P)"
runtime_pid=
cleanup() {
    local status=$? lane
    if [[ -n "$runtime_pid" ]]; then stop_runtime || status=1; fi
    for lane in target source; do
        if [[ -f "$scratch/$lane/postmaster.pid" ]] && ! pg_ctl -D "$scratch/$lane" -w -m fast stop; then
            status=1
        fi
    done
    if [[ "$status" != 0 ]]; then
        printf 'Owned joined-media fixture stopped. Evidence retained at %s\n' "$scratch" >&2
    elif find "$scratch" -name '*.blob' -type f -exec chmod u+w {} + &&
         find "$scratch" -type d -exec chmod u+w {} + && find "$scratch" -depth -delete; then
        printf '%s\n' 'Both native PostgreSQL clusters stopped and owned files removed.'
    else
        status=1
    fi
    exit "$status"
}
trap cleanup EXIT

# Each PostgreSQL server uses an exclusive pathname socket and has no TCP listener.
export PGUSER=joined_media_test PGPORT=54996
unset PGSERVICE PGSERVICEFILE PGPASSWORD PGPASSFILE PGOPTIONS PGHOSTADDR
for lane in source target; do
    mkdir -m 700 "$scratch/$lane-s"
    initdb --no-locale --encoding=UTF8 --auth=trust -D "$scratch/$lane" -U "$PGUSER" > "$scratch/$lane-init.log"
    pg_ctl -D "$scratch/$lane" -l "$scratch/$lane.log" -o "-k $scratch/$lane-s -p $PGPORT -c listen_addresses=''" -w start
done
pg() {
    local lane="$1" db="$2"
    shift 2
    psql -Xq --no-password -v ON_ERROR_STOP=1 -h "$scratch/$lane-s" -p "$PGPORT" -U "$PGUSER" -d "$db" "$@"
}
dsn() {
    printf 'Host=%s/%s-s;Port=%s;Username=%s;Database=%s;SSL Mode=Disable' "$scratch" "$1" "$PGPORT" "$PGUSER" "$2"
}
json_value() {
    python3 -c 'import json,sys; print(json.load(sys.stdin)[sys.argv[1]])' "$1" < "$2"
}
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
refuse() {
    local reason="$1" name="$2"
    shift 2
    if "$@" > "$scratch/$name.out" 2> "$scratch/$name.err"; then
        printf 'Unexpected admission in %s\n' "$name" >&2
        exit 1
    fi
    rg -F -- "$reason" "$scratch/$name.err"
}

prefix="fsusv2_import_$(openssl rand -hex 12)"
source="${prefix}_source"
restored="${prefix}_source_restore"
target="$prefix"
rollback="${prefix}_rollback"
owner=968ffb2b-77ef-4868-89ec-6a0a19b28b95
source_site=87bcdd48-255d-49dd-a984-dd4c4ee6f9d4
asset=2b550000-0000-4000-8000-000000000002
payload=2b550000000040008000000000000002
asset_sha=cb8379ac2098aa165029e3938a51da0bcecfc008fd6795f401178647f96c5b34
asset_bytes=3
article_count=1
asset_count=1
reference_count=1
owner2=
if [[ "$batch" == true ]]; then
    owner2=3cc70000-0000-4000-b000-000000000008
    historical_asset=3c550000-0000-4000-8000-000000000003
    current_asset=4d550000-0000-4000-8000-000000000004
    historical_leaf="${historical_asset//-/}"
    current_leaf="${current_asset//-/}"
    article_count=2
    asset_count=3
    reference_count=4
fi
extension=txt
if [[ "$prepared" == true ]]; then
    extension=png
    asset_bytes=86
    asset_sha=141fca9a4be8a4b68c34eb2d951298694fab21e4ec05bcbe9cf2487b2af55abc
    alternate_sha=5b2148c370ecb7f76a8fe0daa832f5dd51057a43340a75f6adf5c0a67abc7c19
fi
for db in "$source" "$restored"; do pg source postgres -c "CREATE DATABASE $db TEMPLATE template0"; done
for db in "$target" "$rollback"; do pg target postgres -c "CREATE DATABASE $db TEMPLATE template0"; done
pg source "$source" -f tests/Integration/Migration/legacy-source-fixture.sql \
    -f tests/Integration/Migration/legacy-shared-rights-fixture.sql \
    -f tests/Integration/Migration/legacy-assets-fixture.sql
# Match the original article lifecycle writer's immediate transition and release timestamps.
pg source "$source" -c "UPDATE article_publication SET transition_kind='immediate-publish';
    UPDATE article SET last_published_at='2026-10-02 00:00:00',public_updated_at='2026-10-02 00:00:00';
    DELETE FROM content_asset_reference WHERE asset_id<>'$asset'; DELETE FROM content_asset WHERE id<>'$asset';
    UPDATE content_asset_reference SET source_key='5000000003', alt_text='Retained private file' WHERE asset_id='$asset';"

if [[ "$prepared" == true ]]; then
    pg source "$source" -c "UPDATE content_asset SET storage_key='2b/$payload.png',media_type='image/png',extension='.png',
        byte_length=$asset_bytes,sha256='$asset_sha',width=2,height=2 WHERE id='$asset'"
fi

# Capture v1 as an owned native database archive. Restore raw private bytes independently from their sealed source copy.
mkdir -m 700 "$scratch/source-backup" "$scratch/public" "$scratch/private" "$scratch/private/2b" "$scratch/source-media-backup"
private="$scratch/private/2b/$payload.$extension"
private_backup="$scratch/source-media-backup/$payload.$extension"
if [[ "$prepared" == true ]]; then
    python3 - "$private" "$scratch/alternate.png" <<'FIXTURE_PNG'
import base64, pathlib, sys
# Same opaque 2x2 RGBA pixels and byte length; only zlib header and IDAT CRC differ.
for target, png in zip(sys.argv[1:], (
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAHUlEQVR4AQESAO3/AAklUf8ghcf/ANyBE/8wsV3/RGsIlsimEzoAAAAASUVORK5CYII=',
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAHUlEQVR4nAESAO3/AAklUf8ghcf/ANyBE/8wsV3/RGsIlgPKresAAAAASUVORK5CYII=',
)): pathlib.Path(target).write_bytes(base64.b64decode(png, validate=True))
FIXTURE_PNG
    [[ "$(sha "$scratch/alternate.png")" == "$alternate_sha" ]]
else
    printf 'def' > "$private"
fi
if [[ "$batch" == true ]]; then
    mkdir "$scratch/private/3c" "$scratch/private/4d"
    historical_file="$scratch/private/3c/$historical_leaf.png"
    current_file="$scratch/private/4d/$current_leaf.jpeg"
    python3 tests/Integration/Migration/legacy-image-fixture.py "$historical_file" "$current_file"
    [[ "$(sha "$current_file")" == cc9cd717f22de241f7306d8c8009d1d8eafcf04837fdfcd42330bb0a5fc9fe37 ]]
    pg source "$source" -v historical_asset="$historical_asset" -v historical_key="3c/$historical_leaf.png" \
        -v historical_bytes="$(wc -c < "$historical_file" | tr -d ' ')" -v historical_sha="$(sha "$historical_file")" \
        -v current_asset="$current_asset" -v current_key="4d/$current_leaf.jpeg" \
        -v current_bytes="$(wc -c < "$current_file" | tr -d ' ')" -v current_sha="$(sha "$current_file")" \
        -f tests/Integration/Migration/legacy-media-batch-source.sql
    cp "$historical_file" "$current_file" "$scratch/source-media-backup/"
    chmod 0400 "$scratch/source-media-backup/$historical_leaf.png" "$scratch/source-media-backup/$current_leaf.jpeg"
fi
total_private_bytes="$asset_bytes"
if [[ "$batch" == true ]]; then
    total_private_bytes=$((asset_bytes + $(wc -c < "$historical_file") + $(wc -c < "$current_file")))
fi
cp "$private" "$private_backup"
chmod 0400 "$private_backup"
[[ "$(sha "$private_backup")" == "$asset_sha" ]]
PGHOST="$scratch/source-s" PYTHONDONTWRITEBYTECODE=1 python3 tests/Integration/Migration/legacy-source-backup.py \
    "$source" "$restored" "$scratch/source-backup" > "$scratch/source-restore.json"
rm "$private"
cp "$private_backup" "$private"
[[ "$(sha "$private")" == "$asset_sha" ]]
if [[ "$batch" == true ]]; then
    for original in "$historical_file" "$current_file"; do
        rm "$original"
        cp "$scratch/source-media-backup/${original##*/}" "$original"
    done
fi
pg source postgres -c 'CREATE ROLE joined_reader LOGIN'
for db in "$source" "$restored"; do
    pg source "$db" -c 'GRANT USAGE ON SCHEMA public TO joined_reader;
        GRANT SELECT ON ALL TABLES IN SCHEMA public TO joined_reader;
        GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO joined_reader;'
done
FSUSBLOG_V1_DB="$(dsn source "$restored");Username=joined_reader;Options=-c default_transaction_read_only=on"
export FSUSBLOG_V1_DB
export FSUSBLOG_V1_SCHEMA=public

FSUSBLOG_DB="$(dsn target "$target")"
FSUSBLOG_IMPORT_DB="$FSUSBLOG_DB"
export FSUSBLOG_DB FSUSBLOG_IMPORT_DB
export PGHOST="$scratch/target-s" PGDATABASE="$target"
"${migrate[@]}" plan > "$scratch/bootstrap.json"
"${migrate[@]}" apply "$scratch/bootstrap.json"
pg target "$target" -c "INSERT INTO public.blog_user VALUES ('$owner','Joined fixture owner',true,true,1)"
if [[ "$batch" == true ]]; then
    pg target "$target" -c "INSERT INTO public.blog_user VALUES ('$owner2','Joined second fixture owner',true,true,1)"
fi
target_site="$(pg target "$target" -Atc 'SELECT site_id FROM public.authoring_recovery_site WHERE singleton')"
mkdir -m 700 "$scratch/target-backup" "$scratch/target-media" "$scratch/packages"
export PYTHONDONTWRITEBYTECODE=1
backup_result="$(python3 tools/site-backup.py capture "$scratch/target-backup" seed "$scratch/target-media")"
backup_sha="${backup_result##* }"
backup="$scratch/target-backup/seed"
python3 tools/site-backup.py verify "$backup" "$backup_sha"
target_state() {
    pg target "$1" -Atc "SELECT version, to_regnamespace('fsus_legacy_candidate') IS NULL,
        (SELECT count(*) FROM public.article),(SELECT count(*) FROM public.private_media),
        (SELECT count(*) FROM public.article_revision_media),(SELECT count(*) FROM public.article_publication_media)
        FROM public.v2_schema WHERE singleton"
}
[[ "$(target_state "$target")" == '1|t|0|0|0|0' ]]

intake_rc=0
"${migrate[@]}" legacy plan postgres > "$scratch/intake.json" || intake_rc=$?
[[ "$intake_rc" == 2 ]]
python3 - "$scratch/intake.json" "$scratch/owners.json" "$owner" "$owner2" <<'PY'
import json, pathlib, sys
intake = json.loads(pathlib.Path(sys.argv[1]).read_text())
article = next(row for row in intake['audit']['projections'] if row['table'] == 'article')
pathlib.Path(sys.argv[2]).write_text(json.dumps({
    'sourceArticleSha256': article['sha256'], 'sourceAdminIdentitySha256': intake['sourceAdminIdentitySha256'],
    'owners': [{'articleId': 42, 'legacyAdminId': 7, 'v2UserId': sys.argv[3]}] +
              ([{'articleId': 43, 'legacyAdminId': 8, 'v2UserId': sys.argv[4]}] if sys.argv[4] else [])
}))
PY
plan=("${migrate[@]}" legacy import plan postgres "$scratch/owners.json" "$backup" "$backup_sha")
apply=("${migrate[@]}" legacy import apply postgres "$scratch/owners.json" "$backup" "$backup_sha" "$scratch/import.json")
rc=0
"${plan[@]}" > "$scratch/no-media-plan.json" || rc=$?
[[ "$rc" == 2 ]]
python3 - "$scratch/no-media-plan.json" <<'PY'
import json,sys
plan=json.load(open(sys.argv[1]))
assert not plan['readyToStage'] and 'media' not in plan
assert [r['source'] for r in plan['findings'] if r['category']=='attachments'] == ['content_asset','content_asset_reference']
PY

pack_media() {
    local name="$1"
    local legacy_assets=("${migrate[@]}" legacy assets rehearsal)
    "${legacy_assets[@]}" plan postgres "$scratch/public" "$scratch/private" "$source_site" "$target_site" > "$scratch/$name-review.json"
    python3 - "$scratch/$name-review.json" "$owner" "$owner2" <<'PY'
import json, pathlib, sys
file = pathlib.Path(sys.argv[1]); review = json.loads(file.read_text())
owners = [value for value in sys.argv[2:] if value]
assert review['owners'] == [{'sourceAdminPrincipalId': 7 + i, 'targetUserId': None} for i, _ in enumerate(owners)]
for mapping, user in zip(review['owners'], owners): mapping['targetUserId'] = user
file.write_text(json.dumps(review))
PY
    "${legacy_assets[@]}" copy postgres "$scratch/public" "$scratch/private" "$scratch/$name-review.json" \
        "$(sha "$scratch/$name-review.json")" "$scratch/packages" "$name" > "$scratch/$name-media.json"
}
# The existing independent custody path accepts metadata about a private file on a previously public revision.
# The joined projection deliberately requires that the original referenced revision was never public.
pg source "$restored" -c "UPDATE content_asset_reference SET source_key='5000000002' WHERE asset_id='$asset'"
pack_media public_revision
refuse 'unpublished source revision' public-revision "${plan[@]}" --media "$scratch/packages/public_revision" \
    "$(json_value manifestSha256 "$scratch/public_revision-media.json")"
pg source "$restored" -c "UPDATE content_asset_reference SET source_key='5000000003' WHERE asset_id='$asset'"
if [[ "$prepared" == true ]]; then
    rm "$private"
    cp "$scratch/alternate.png" "$private"
    pg source "$restored" -c "UPDATE content_asset SET sha256='$alternate_sha' WHERE id='$asset'"
    pack_media alternate_raw
    rm "$private"
    cp "$private_backup" "$private"
    pg source "$restored" -c "UPDATE content_asset SET sha256='$asset_sha' WHERE id='$asset'"
fi
pack_media private_revision
package="$scratch/packages/private_revision"
media_sha="$(json_value manifestSha256 "$scratch/private_revision-media.json")"
media=(--media "$package" "$media_sha")
"${plan[@]}" "${media[@]}" > "$scratch/import.json"

refuse 'original joined media package' missing-package "${apply[@]}"
refuse 'sealed source database and principals' other-physical-source env \
    FSUSBLOG_V1_DB="$(dsn source "$source");Username=joined_reader;Options=-c default_transaction_read_only=on" "${plan[@]}" "${media[@]}"
pg source "$restored" -c "UPDATE content_asset_reference SET alt_text=alt_text || ' changed' WHERE asset_id='$asset'"
refuse 'references differ from their verified package' source-reference-drift "${apply[@]}" "${media[@]}"
pg source "$restored" -c "UPDATE content_asset_reference SET alt_text='Retained private file' WHERE asset_id='$asset'"
# Corrupt a separate stand-in package. Do not change the already sealed independent package.
mkdir -m 700 "$scratch/packages/bad"
cp "$package/manifest.json" "$scratch/packages/bad/manifest.json"
if [[ "$batch" == true ]]; then cp "$package/$historical_leaf.blob" "$package/$current_leaf.blob" "$scratch/packages/bad/"; fi
printf 'bag' > "$scratch/packages/bad/$payload.blob"
chmod 0400 "$scratch/packages/bad/manifest.json" "$scratch/packages/bad/"*.blob
chmod 0500 "$scratch/packages/bad"
refuse 'does not match its manifest length or SHA-256' package-byte-drift "${apply[@]}" --media "$scratch/packages/bad" "$media_sha"
[[ "$(target_state "$target")" == '1|t|0|0|0|0' ]]
[[ "$(sha "$package/$payload.blob")" == "$asset_sha" && "$(sha "$private")" == "$asset_sha" ]]

"${apply[@]}" "${media[@]}" > "$scratch/applied.json"
"${apply[@]}" "${media[@]}" > "$scratch/retry.json"
[[ "$(target_state "$target")" == '-1|f|0|0|0|0' ]]
shadow_rows() {
    pg target "$target" -Atc "SELECT a.id,a.owner_admin_principal_id,a.target_owner_id,a.byte_length,a.sha256,
        r.source_kind,r.source_id,r.article_id,r.revision,r.reference_count,r.alt_text,s.title
        FROM fsus_legacy_candidate.shadow_content_asset a JOIN fsus_legacy_candidate.shadow_content_asset_reference r ON r.asset_id=a.id
        JOIN fsus_legacy_candidate.shadow_revision s ON (s.source_revision_id,s.article_id,s.revision)=(r.source_id,r.article_id,r.revision) WHERE a.id='$asset'"
}
[[ "$(shadow_rows)" == "$asset|7|$owner|$asset_bytes|$asset_sha|revision|5000000003|42|3|1|Retained private file|Private edit" ]]
plan_sha="$(json_value planSha256 "$scratch/applied.json")"
project=("${migrate[@]}" legacy import project "$scratch/import.json" "$plan_sha" "$backup" "$backup_sha")
verify=("${migrate[@]}" legacy import verify "$scratch/import.json" "$plan_sha" "$backup" "$backup_sha")
refuse 'original joined media package' project-without-package "${project[@]}"
[[ "$(target_state "$target")" == '-1|f|0|0|0|0' ]]
"${project[@]}" "${media[@]}" > "$scratch/projected.json"
[[ "$(target_state "$target")" == "-1|f|$article_count|0|0|0" ]]
refuse 'isolated legacy import candidate and cannot serve' runtime "${migrate[@]}" verify
pg target "$target" -c 'UPDATE fsus_legacy_candidate.shadow_content_asset_reference SET reference_count=2'
refuse 'Staged source has changed: shadow_content_asset_reference.' candidate-drift "${verify[@]}" "${media[@]}"
pg target "$target" -c 'UPDATE fsus_legacy_candidate.shadow_content_asset_reference SET reference_count=1'

# Recover the joined custody from the original sealed package in a new private directory and verify it against the quarantined DB.
mkdir -m 700 "$scratch/packages/recovered"
cp "$package/manifest.json" "$package/"*.blob "$scratch/packages/recovered/"
chmod 0400 "$scratch/packages/recovered/manifest.json" "$scratch/packages/recovered/"*.blob
chmod 0500 "$scratch/packages/recovered"
"${verify[@]}" --media "$scratch/packages/recovered" "$media_sha" > "$scratch/verified.json"

if [[ "$prepared" == true ]]; then
    request_args=("$scratch/import.json" "$plan_sha" "$backup" "$backup_sha")
    request="$scratch/preparation.json"
    "${migrate[@]}" legacy import media-request "${request_args[@]}" "${media[@]}" > "$request"
    "${migrate[@]}" legacy import media-request "${request_args[@]}" --media "$scratch/packages/recovered" "$media_sha" \
        > "$scratch/recovered-request.json"
    cmp "$request" "$scratch/recovered-request.json"
    "${preparer[@]}" normalizer > "$scratch/normalizer.json"
    normalizer_sha="$(json_value normalizerSha256 "$scratch/normalizer.json")"
    python3 - "$scratch/normalizer.json" "$(dirname "$server_dll")" <<'NORMALIZER_FILES'
import hashlib, json, pathlib, sys
report = json.loads(pathlib.Path(sys.argv[1]).read_text())
bundle = pathlib.Path(sys.argv[2]).resolve()
for file in report['files']:
    path = (bundle / file['name']).resolve()
    assert path.is_relative_to(bundle) and hashlib.sha256(path.read_bytes()).hexdigest() == file['sha256']
assert len({file['name'] for file in report['files']}) == len(report['files']) >= 5
NORMALIZER_FILES
    request_sha="$(sha "$request")"
    "${preparer[@]}" prepare "$request" "$request_sha" "$package" "$normalizer_sha" "$scratch/packages" prepared > "$scratch/prepared.json"
    prepared_sha="$(json_value manifestSha256 "$scratch/prepared.json")"
    verify_media=("${migrate[@]}" legacy import media-verify "${request_args[@]}")
    wrong_sha="$(printf '%064d' 0)"
    refuse 'approved request and normalizer' replaced-normalizer "${verify_media[@]}" \
        --prepared "$scratch/packages/prepared" "$prepared_sha" "$wrong_sha" "${media[@]}"

    # This is a controlled different request. Both custodies were acquired natively before staging.
    alternate_package="$scratch/packages/alternate_raw"
    alternate_manifest="$(json_value manifestSha256 "$scratch/alternate_raw-media.json")"
    python3 - "$request" "$scratch/alternate-request.json" "$alternate_manifest" "$alternate_sha" <<'OTHER_REQUEST'
import json, pathlib, sys
original, destination, manifest, raw = sys.argv[1:]
original_bytes = pathlib.Path(original).read_bytes()
request = json.loads(original_bytes)
# Replace only the two approved hex fields. Leave the original canonical Unicode escaping intact.
for before, after in ((request['custodyManifestSha256'], manifest), (request['assets'][0]['rawSha256'], raw)):
    assert original_bytes.count(before.encode()) == 1
    original_bytes = original_bytes.replace(before.encode(), after.encode())
pathlib.Path(destination).write_bytes(original_bytes)
OTHER_REQUEST
    "${preparer[@]}" prepare "$scratch/alternate-request.json" "$(sha "$scratch/alternate-request.json")" \
        "$alternate_package" "$normalizer_sha" "$scratch/packages" prepared_alternate > "$scratch/prepared-alternate.json"
    cmp "$scratch/packages/prepared/$payload.blob" "$scratch/packages/prepared_alternate/$payload.blob"
    refuse 'approved request and normalizer' same-pixels-other-custody "${verify_media[@]}" \
        --prepared "$scratch/packages/prepared_alternate" "$(json_value manifestSha256 "$scratch/prepared-alternate.json")" \
        "$normalizer_sha" "${media[@]}"

    corrupt="$scratch/packages/prepared_corrupt"
    mkdir -m 700 "$corrupt"
    cp "$scratch/packages/prepared/manifest.json" "$corrupt/manifest.json"
    python3 - "$scratch/packages/prepared/$payload.blob" "$corrupt/$payload.blob" <<'CHANGE_BYTE'
import pathlib, sys
content = bytearray(pathlib.Path(sys.argv[1]).read_bytes())
content[-1] ^= 1
pathlib.Path(sys.argv[2]).write_bytes(content)
CHANGE_BYTE
    if [[ "$batch" == true ]]; then
        cp "$scratch/packages/prepared/$historical_leaf.blob" "$scratch/packages/prepared/$current_leaf.blob" "$corrupt/"
    fi
    chmod 0400 "$corrupt/manifest.json" "$corrupt/"*.blob
    chmod 0500 "$corrupt"
    refuse 'prepared media payload differs' changed-output-bytes "${verify_media[@]}" \
        --prepared "$corrupt" "$prepared_sha" "$normalizer_sha" "${media[@]}"

    recovered="$scratch/packages/prepared_restored"
    mkdir -m 700 "$recovered"
    cp "$scratch/packages/prepared/manifest.json" "$scratch/packages/prepared/"*.blob "$recovered/"
    chmod 0400 "$recovered/manifest.json" "$recovered/"*.blob
    chmod 0500 "$recovered"
    "${verify_media[@]}" --prepared "$recovered" "$prepared_sha" "$normalizer_sha" \
        --media "$scratch/packages/recovered" "$media_sha" > "$scratch/prepared-verified.json"
    python3 - "$request" "$recovered/manifest.json" "$scratch/prepared-verified.json" "$asset_sha" "$owner" "$asset_count" "$reference_count" <<'VERIFIED_ORIGIN'
import json, pathlib, sys
request, result, verified = [json.loads(pathlib.Path(name).read_bytes()) for name in sys.argv[1:4]]
raw, owner, files, references = sys.argv[4:]
assert request['references'][:1] == [{'assetId': request['assets'][0]['assetId'], 'articleId': 42,
    'sourceRevisionId': 5000000003, 'revision': 3, 'referenceCount': 1, 'altText': 'Retained private file'}]
assert request['assets'][0]['rawSha256'] == result['assets'][0]['rawSha256'] == raw
assert request['assets'][0]['targetOwnerId'] == owner and request['assets'][0]['sourceOwnerId'] == 7
assert result['assets'][0]['normalizedSha256'] != raw and result['assets'][0]['format'] == 1
assert result['assets'][0]['width'] == result['assets'][0]['height'] == 2
assert (verified['files'], verified['references']) == (int(files), int(references)) and not verified['readyToApply']
print(json.dumps(dict(verified, rawSha256=raw, normalizedSha256=result['assets'][0]['normalizedSha256']), sort_keys=True))
VERIFIED_ORIGIN
    [[ "$(target_state "$target")" == "-1|f|$article_count|0|0|0" ]]
else
    refuse 'Preparation requires supported private images' text-preparation "${migrate[@]}" legacy import media-request \
        "$scratch/import.json" "$plan_sha" "$backup" "$backup_sha" "${media[@]}"
fi

if [[ "$activate" == true ]]; then
    # Exercise the production CLI against a separate app-shaped, independently backed up runtime copy.
    source tests/Integration/Migration/legacy-media-activation-fixture.sh
    prove_media_activation
fi

# Restore the pre-cutover database and its own media set as a separate matched pair.
mkdir -m 700 "$scratch/rollback-media"
pg_restore --no-password -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" --dbname "$rollback" --single-transaction \
    --exit-on-error --no-owner --no-privileges "$backup/database.dump"
rollback_dsn="$(dsn target "$rollback")"
FSUSBLOG_DB="$rollback_dsn" python3 tools/site-backup.py verify-restored "$backup" "$backup_sha" "$scratch/rollback-media"
[[ "$(target_state "$rollback")" == '1|t|0|0|0|0' ]]
refuse 'does not belong to this independent candidate database' wrong-target env FSUSBLOG_IMPORT_DB="$rollback_dsn" "${plan[@]}" "${media[@]}"
[[ "$(target_state "$rollback")" == '1|t|0|0|0|0' ]]

python3 - "$scratch" "$backup_sha" "$media_sha" "$total_private_bytes" "$asset_count" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1]); read = lambda n: json.loads((root / f'{n}.json').read_text())
plan, applied, retry, projected, verified = [read(name) for name in ('import','applied','retry','projected','verified')]
assert not any(doc['readyToApply'] for doc in (plan, applied, retry, projected, verified))
assert plan['sourceSeal']['provenance']=='cluster-and-catalog' and plan['media']['manifestSha256']==sys.argv[3]
assert [phase['result'] for phase in applied['phases']] == ['staged'] * 3
assert [phase['result'] for phase in retry['phases']] == ['revalidated'] * 3
assert [phase['sha256'] for phase in applied['phases']] == [phase['sha256'] for phase in retry['phases']]
assert len({doc['planSha256'] for doc in (applied,retry,projected,verified)}) == 1
assert projected['projectionSha256'] == verified['projectionSha256']
print(json.dumps({'sourceRestore': read('source-restore'), 'targetRollbackManifestSha256': sys.argv[2],
                  'mediaManifestSha256': sys.argv[3], 'articlePlanSha256': applied['planSha256'],
                  'firstPhaseSha256': applied['phases'][0]['sha256'], 'projectionSha256': verified['projectionSha256'],
                  'mediaFiles': int(sys.argv[5]), 'privateBytes': int(sys.argv[4]), 'readyToApply': False}, sort_keys=True))
PY
printf '%s\n' 'Legacy database and nonempty private media joined and restored in native isolation.'
