#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
export PATH="${PG_TOOLS_DIR:-/opt/homebrew/opt/postgresql@18/bin}:$PATH"
dotnet_bin="${DOTNET_BIN:-dotnet}"
migrate=("$dotnet_bin" "${FSUSBLOG_MIGRATE_DLL:-$PWD/src/Migrate/bin/Release/net10.0/FsusBlogV2.Migrate.dll}")
case "$# ${1:-}" in "0 "|"1 --stage") ;; *) echo "Usage: $0 [--stage]" >&2; exit 2 ;; esac
umask 077
scratch="$(mktemp -d /tmp/fsus-cover-proof.XXXXXXXX)"
scratch="$(cd "$scratch" && pwd -P)"
cleanup() {
    local status=$? lane
    for lane in source target; do
        if [[ -f "$scratch/$lane/postmaster.pid" ]]; then pg_ctl -D "$scratch/$lane" -m fast -w stop >/dev/null || status=1; fi
    done
    local evidence="$scratch-evidence"
    mkdir -m 700 "$evidence"
    find "$scratch" -maxdepth 1 -type f \( -name '*.json' -o -name '*.err' -o -name '*.out' -o -name '*.log' \) -exec cp {} "$evidence/" \;
    if [[ "$status" == 0 ]]; then
        find "$scratch" -type d -exec chmod u+w {} +
        find "$scratch" -depth -delete || status=1
    fi
    printf 'Cover proof exit=%s; owned clusters stopped; evidence=%s\n' "$status" "$evidence"
    exit "$status"
}
trap cleanup EXIT
source tests/Integration/Migration/legacy-cover-database-fixture.sh
pg source "$source" -c "DELETE FROM content_asset_reference; DELETE FROM content_asset WHERE id<>'$asset';
UPDATE content_asset SET owner_admin_principal_id=7 WHERE id='$asset';
UPDATE article SET coverimageurl='/uploads/illustration/ExactName.txt';
UPDATE article_revision SET cover_image_url='/uploads/illustration/ExactName.txt';
UPDATE article_revision SET cover_image_url='/uploads/illustration/Other.txt' WHERE id=5000000001;
INSERT INTO content_asset SELECT '3c550000-0000-4000-8000-000000000003',storage_class,'illustration/Other.txt',media_type,extension,
byte_length,sha256,width,height,owner_admin_principal_id,state,created_at_utc,updated_at_utc FROM content_asset WHERE id='$asset';
INSERT INTO content_asset_reference VALUES ('$asset','article','42',42,2,NULL,'2026-10-01');
INSERT INTO content_asset_reference SELECT c.id,'revision',r.id::text,r.article_id,2,NULL,'2026-10-01'::timestamp FROM article_revision r CROSS JOIN content_asset c;"
export FSUSBLOG_V1_DB="$(dsn source "$source");Options=-c default_transaction_read_only=on"
export FSUSBLOG_V1_SCHEMA=public
export FSUSBLOG_DB="$(dsn target "$target")" FSUSBLOG_IMPORT_DB="$(dsn target "$target")"
"${migrate[@]}" plan > "$scratch/bootstrap.json"
"${migrate[@]}" apply "$scratch/bootstrap.json"
pg target "$target" -c "INSERT INTO public.blog_user VALUES ('$owner','Cover fixture',true,true,1)"
target_site="$(pg target "$target" -Atc 'SELECT site_id FROM public.authoring_recovery_site WHERE singleton')"
mkdir -m 700 "$scratch/public" "$scratch/public/illustration" "$scratch/private" "$scratch/packages"
printf abc > "$scratch/public/illustration/ExactName.txt"
printf abc > "$scratch/public/illustration/Other.txt"
source tests/Integration/Migration/legacy-cover-rehearsal-fixture.sh
python3 - "$scratch/proof.json" <<'PY'
import json,sys
s=open(sys.argv[1]).read(); v=json.loads(s); c=v['candidates']
assert not v['readyToApply'] and not v['readyToStage']
assert len(c)==4 and len({(r['sourceKind'],r['sourceId']) for r in c})==4
assert all(r['role']=='cover' for r in c)
assert len({r['assetId'] for r in c})==2
assert all(r['sourceRevisionId'] >= 5000000001 for r in c)
assert sum(r['sourceKind']=='revision' and r['currentEdit'] for r in c)==1
assert sum(r['sourceKind']=='revision' and r['currentPublication'] for r in c)==1
assert '/uploads/' not in s and 'ExactName' not in s
PY
refuse() { if "${proof[@]}" > "$scratch/$1.out" 2> "$scratch/$1.err"; then echo "Unexpected success: $1" >&2; exit 1; fi; }
for url in 'https://example.invalid/uploads/illustration/ExactName.txt' '/uploads/illustration/../ExactName.txt' '/uploads/illustration/%45xactName.txt' '/uploads/illustration/ExactName.txt?x=1' '/uploads/illustration/ExactName.txt#x' '/uploads/illustration/Missing.txt'; do
    pg source "$source" -c "UPDATE article_revision SET cover_image_url='$url' WHERE id=5000000001"
    refuse stale-revision
    grep -qF 'revision or publication projection differs' "$scratch/stale-revision.err"
    "${migrate[@]}" legacy plan postgres > "$scratch/changed-intake.json" || [[ $? == 2 ]]
    changed_sha="$(python3 -c 'import json,sys; print(next(x["sha256"] for x in json.load(open(sys.argv[1]))["audit"]["projections"] if x["table"]=="article_revision"))' "$scratch/changed-intake.json")"
    if "${migrate[@]}" legacy covers proof postgres "$scratch/packages/media" "$media_sha" "$scratch/owners.json" "$owners_sha" "$changed_sha" "$publication_sha" > "$scratch/unsafe-url.out" 2> "$scratch/unsafe-url.err"; then exit 1; fi
    grep -qF 'exact public managed-key' "$scratch/unsafe-url.err"
 done
# An alternative already-referenced managed key cannot silently replace the approved historical cover.
pg source "$source" -c "UPDATE article_revision SET cover_image_url='/uploads/illustration/ExactName.txt' WHERE id=5000000001"
refuse changed-managed-cover
grep -qF 'revision or publication projection differs' "$scratch/changed-managed-cover.err"
pg source "$source" -c "UPDATE article_revision SET cover_image_url='/uploads/illustration/Other.txt' WHERE id=5000000001"
python3 - "$scratch/owners.json" "$scratch/wrong-owners.json" <<'PYOWNER'
import json,pathlib,sys
v=json.load(open(sys.argv[1])); v['owners'][0]['v2UserId']='3cc70000-0000-4000-b000-000000000008'
pathlib.Path(sys.argv[2]).write_text(json.dumps(v))
PYOWNER
if "${migrate[@]}" legacy covers proof postgres "$scratch/packages/media" "$media_sha" "$scratch/wrong-owners.json" "$(sha "$scratch/wrong-owners.json")" "$revision_sha" "$publication_sha" > "$scratch/wrong-owner.out" 2> "$scratch/wrong-owner.err"; then exit 1; fi
grep -qF 'exact public managed-key' "$scratch/wrong-owner.err"
pg source "$source" -c "DELETE FROM content_asset_reference WHERE source_kind='article'"
refuse missing-reference
pg source "$source" -c "INSERT INTO content_asset_reference VALUES ('$asset','article','42',42,2,NULL,'2026-10-01')"
pg source "$source" -c "UPDATE article_revision SET created_by_admin_principal_id=8 WHERE id=5000000001"
refuse different-owner
pg source "$source" -c "UPDATE article_revision SET created_by_admin_principal_id=7 WHERE id=5000000001"
pg source "$source" -c "UPDATE article SET coverimageurl='/uploads/illustration/Changed.txt'"
refuse stale-article-map
pg source "$source" -c "UPDATE article_publication SET created_at=created_at+interval '1 second' WHERE id=900000001"
refuse stale-publication
grep -qF 'revision or publication projection differs' "$scratch/stale-publication.err"
pg source "$source" -c "UPDATE article_publication SET created_at=created_at-interval '1 second' WHERE id=900000001"
pg source "$source" -c "UPDATE article SET coverimageurl='/uploads/illustration/ExactName.txt'"
leaf="$scratch/packages/media/${asset//-/}.blob"
chmod 0600 "$leaf"
printf zzz > "$leaf"
chmod 0400 "$leaf"
refuse altered-bytes
grep -qF 'payload does not match' "$scratch/altered-bytes.err"
chmod 0600 "$leaf"
printf abc > "$leaf"
chmod 0400 "$leaf"
"${proof[@]}" > "$scratch/final.json"
cmp "$scratch/proof.json" "$scratch/final.json"
"${migrate[@]}" legacy plan postgres > "$scratch/final-intake.json" || [[ $? == 2 ]]
cmp "$scratch/intake.json" "$scratch/final-intake.json"
printf 'PASS: exact role/owner/reference, repeatability, URL/ref/owner/stale-map refusals, source readback, original admission retained.\n'

if [[ "${1:-}" == --stage ]]; then
    export DOTNET_BIN="$dotnet_bin" FSUSBLOG_MIGRATE_DLL="${migrate[1]}" PYTHONDONTWRITEBYTECODE=1
    export PGHOST="$scratch/target-s" PGDATABASE="$target"
    mkdir -m 700 "$scratch/baselines" "$scratch/empty-media"
    baseline_receipt="$(python3 tools/site-backup.py capture "$scratch/baselines" before "$scratch/empty-media")"
    baseline_sha="${baseline_receipt##* }"
    baseline="$scratch/baselines/before"
    python3 tools/site-backup.py verify "$baseline" "$baseline_sha"
    proof_sha="$(sha "$scratch/proof.json")"
    stage=("${migrate[@]}" legacy covers stage "$scratch/packages/media" "$media_sha" "$scratch/owners.json" "$owners_sha" "$revision_sha" "$publication_sha" "$scratch/proof.json" "$proof_sha" "$baseline" "$baseline_sha")
    verify=("${migrate[@]}" legacy covers verify "$scratch/packages/media" "$media_sha" "$scratch/proof.json" "$proof_sha" "$baseline" "$baseline_sha")
    # Wrong independently recorded proof digest must not start any candidate writes.
    if "${migrate[@]}" legacy covers stage "$scratch/packages/media" "$media_sha" "$scratch/owners.json" "$owners_sha" "$revision_sha" "$publication_sha" "$scratch/proof.json" "$(printf '0%.0s' {1..64})" "$baseline" "$baseline_sha" > "$scratch/wrong-proof.out" 2> "$scratch/wrong-proof.err"; then exit 1; fi
    [[ "$(pg target "$target" -Atc "SELECT version=1 AND to_regnamespace('fsus_legacy_candidate') IS NULL FROM public.v2_schema WHERE singleton")" == t ]]
    pg source "$source" -c "UPDATE article_revision SET cover_image_url='/uploads/illustration/ExactName.txt' WHERE id=5000000001"
    if "${stage[@]}" > "$scratch/stale-stage.out" 2> "$scratch/stale-stage.err"; then exit 1; fi
    grep -qF 'revision or publication projection differs' "$scratch/stale-stage.err"
    [[ "$(pg target "$target" -Atc "SELECT version=1 AND to_regnamespace('fsus_legacy_candidate') IS NULL FROM public.v2_schema WHERE singleton")" == t ]]
    pg source "$source" -c "UPDATE article_revision SET cover_image_url='/uploads/illustration/Other.txt' WHERE id=5000000001"
    "${stage[@]}" > "$scratch/staged.json"
    "${stage[@]}" > "$scratch/replayed.json"
    "${verify[@]}" > "$scratch/verified.json"
    [[ "$(pg target "$target" -Atc 'SELECT version FROM public.v2_schema WHERE singleton')" == -1 ]]
    [[ "$(pg target "$target" -Atc 'SELECT count(*) FROM public.article')" == 0 ]]
    if "${migrate[@]}" verify > "$scratch/server-rejected.out" 2> "$scratch/server-rejected.err"; then echo 'Quarantine was admitted as an ordinary site' >&2; exit 1; fi
    pg_dump -h "$scratch/target-s" -p "$PGPORT" -U "$PGUSER" -Fc "$target" > "$scratch/candidate.dump"
    sha "$scratch/candidate.dump" > "$scratch/candidate-dump.sha256"
    restored=fsusv2_import_cover_restored
    pg target postgres -c "CREATE DATABASE $restored TEMPLATE template0"
    pg_restore -h "$scratch/target-s" -p "$PGPORT" -U "$PGUSER" --no-owner --no-acl --exit-on-error -d "$restored" "$scratch/candidate.dump"
    FSUSBLOG_IMPORT_DB="$(dsn target "$restored")" FSUSBLOG_V1_DB= "${verify[@]}" > "$scratch/restored.json"
    cmp "$scratch/verified.json" "$scratch/restored.json"
    if FSUSBLOG_IMPORT_DB="$(dsn target "$restored")" "${stage[@]}" > "$scratch/restore-write.out" 2> "$scratch/restore-write.err"; then exit 1; fi
    grep -qF 'exact reviewed independent target' "$scratch/restore-write.err"
    pg target "$restored" -c "UPDATE fsus_legacy_candidate.cover_mapping SET role='body' WHERE source_kind='article'"
    if FSUSBLOG_IMPORT_DB="$(dsn target "$restored")" "${verify[@]}" > "$scratch/tampered-role.out" 2> "$scratch/tampered-role.err"; then exit 1; fi
    grep -qF 'stored cover mappings differ' "$scratch/tampered-role.err"
    pg target "$restored" -c "UPDATE fsus_legacy_candidate.cover_mapping SET role='cover' WHERE source_kind='article'; CREATE TABLE fsus_legacy_candidate.unexpected (id integer)"
    if FSUSBLOG_IMPORT_DB="$(dsn target "$restored")" "${verify[@]}" > "$scratch/tampered-schema.out" 2> "$scratch/tampered-schema.err"; then exit 1; fi
    grep -qF 'quarantine catalog differs' "$scratch/tampered-schema.err"
    pg target "$restored" -c "DROP TABLE fsus_legacy_candidate.unexpected; ALTER TABLE fsus_legacy_candidate.cover_mapping ALTER COLUMN role DROP NOT NULL"
    if FSUSBLOG_IMPORT_DB="$(dsn target "$restored")" "${verify[@]}" > "$scratch/tampered-nullability.out" 2> "$scratch/tampered-nullability.err"; then exit 1; fi
    grep -qF 'quarantine catalog differs' "$scratch/tampered-nullability.err"
    pg target "$restored" -c "ALTER TABLE fsus_legacy_candidate.cover_mapping ALTER COLUMN role SET NOT NULL; ALTER TABLE fsus_legacy_candidate.cover_candidate DROP CONSTRAINT cover_candidate_singleton_check"
    if FSUSBLOG_IMPORT_DB="$(dsn target "$restored")" "${verify[@]}" > "$scratch/tampered-check.out" 2> "$scratch/tampered-check.err"; then exit 1; fi
    grep -qF 'quarantine catalog differs' "$scratch/tampered-check.err"
    pg target "$restored" -c "ALTER TABLE fsus_legacy_candidate.cover_candidate ADD CHECK(singleton); UPDATE public.v2_schema SET version=1"
    if FSUSBLOG_IMPORT_DB="$(dsn target "$restored")" "${verify[@]}" > "$scratch/tampered-marker.out" 2> "$scratch/tampered-marker.err"; then exit 1; fi
    pg target "$restored" -c "UPDATE public.v2_schema SET version=-1"
    FSUSBLOG_IMPORT_DB="$(dsn target "$restored")" FSUSBLOG_V1_DB= "${verify[@]}" > "$scratch/restored-final.json"
    cmp "$scratch/verified.json" "$scratch/restored-final.json"
    python3 - "$scratch/staged.json" "$scratch/replayed.json" "$scratch/restored.json" <<'PYSTAGE'
import json,sys
first,replay,restored=[json.load(open(p)) for p in sys.argv[1:]]
assert first['result']=='staged' and replay['result']=='revalidated' and restored['result']=='verified'
assert all(v['rows']==4 and not v['serving'] and not v['readyToApply'] and not v['readyToPublish'] for v in [first,replay,restored])
assert first['mappingSha256']==replay['mappingSha256']==restored['mappingSha256']
PYSTAGE
    printf 'PASS: cover-only quarantine storage, exact-target idempotence, native backup/restore, portable offline readback, non-serving marker and tamper refusal.\n'
fi
