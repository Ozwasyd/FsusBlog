#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
export PATH="${PG_TOOLS_DIR:-/opt/homebrew/opt/postgresql@18/bin}:$PATH"
dotnet_bin="${DOTNET_BIN:-dotnet}"
migrate=("$dotnet_bin" "${FSUSBLOG_MIGRATE_DLL:-$PWD/src/Migrate/bin/Release/net10.0/FsusBlogV2.Migrate.dll}")
[[ ( $# == 0 || ( $# == 1 && ( "$1" == --prepare || "$1" == --dormant ) ) ) && -n "${BASELINE_MIGRATE_DLL:-}" ]] || { echo "Set BASELINE_MIGRATE_DLL to the unchanged 7b85f40 binary." >&2; exit 2; }
dormant=false; publication_count=2
prepare=false; current_leaf=ExactName.txt; historical_leaf=Other.txt
if [[ "${1:-}" == --prepare || "${1:-}" == --dormant ]]; then
    prepare=true; current_leaf=ExactName.jpeg; historical_leaf=Other.png
    source tests/Integration/Migration/legacy-cover-preparation-fixture.sh
fi
if [[ "${1:-}" == --dormant ]]; then dormant=true; publication_count=0; source tests/Integration/Migration/legacy-dormant-cover-fixture.sh; fi
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
    if [[ -d "$scratch/dormant-media" ]]; then
        mkdir -m 700 "$evidence/dormant-media"; cp "$scratch/dormant-media/"*.media "$evidence/dormant-media/"
        cp "$scratch/approval/dormant.json" "$evidence/dormant-approval.json"
    fi
    if [[ -d "$scratch/prepared/first" ]]; then
        mkdir -m 700 "$evidence/prepared"
        cp -R "$scratch/prepared/first" "$evidence/prepared/"
    fi
    if [[ "$status" == 0 ]]; then
        find "$scratch" -type d -exec chmod u+w {} +
        find "$scratch" -depth -delete || status=1
    fi
    printf 'Cover proof exit=%s; owned clusters stopped; evidence=%s\n' "$status" "$evidence"
    exit "$status"
}
trap cleanup EXIT
export PGUSER=cover_fixture PGPORT=54995
unset PGSERVICE PGSERVICEFILE PGPASSWORD PGPASSFILE PGOPTIONS PGHOSTADDR
for lane in source target; do
    mkdir -m 700 "$scratch/$lane-s"
    initdb --no-locale --encoding=UTF8 --auth=trust -D "$scratch/$lane" -U "$PGUSER" > "$scratch/$lane-init.log"
    pg_ctl -D "$scratch/$lane" -l "$scratch/$lane.log" -o "-k $scratch/$lane-s -p $PGPORT -c listen_addresses=''" -w start
 done
pg() { local lane="$1" db="$2"; shift 2; psql -Xq --no-password -v ON_ERROR_STOP=1 -h "$scratch/$lane-s" -p "$PGPORT" -U "$PGUSER" -d "$db" "$@"; }
dsn() { printf 'Host=%s/%s-s;Port=%s;Username=%s;Database=%s;SSL Mode=Disable' "$scratch" "$1" "$PGPORT" "$PGUSER" "$2"; }
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
source=fsusv2_cover_source
target=fsusv2_import_cover
owner=968ffb2b-77ef-4868-89ec-6a0a19b28b95
asset=1a550000-0000-4000-8000-000000000001
pg source postgres -c "CREATE DATABASE $source TEMPLATE template0"
pg target postgres -c "CREATE DATABASE $target TEMPLATE template0"
pg source "$source" -f tests/Integration/Migration/legacy-source-fixture.sql -f tests/Integration/Migration/legacy-shared-rights-fixture.sql -f tests/Integration/Migration/legacy-assets-fixture.sql
pg source "$source" -c "DELETE FROM content_asset_reference; DELETE FROM content_asset WHERE id<>'$asset';
UPDATE content_asset SET owner_admin_principal_id=7,storage_key='illustration/$current_leaf' WHERE id='$asset';
UPDATE article SET coverimageurl='/uploads/illustration/$current_leaf';
UPDATE article_revision SET cover_image_url='/uploads/illustration/$current_leaf';
UPDATE article_revision SET cover_image_url='/uploads/illustration/$historical_leaf' WHERE id=5000000001;
INSERT INTO content_asset SELECT '3c550000-0000-4000-8000-000000000003',storage_class,'illustration/$historical_leaf',media_type,extension,
byte_length,sha256,width,height,owner_admin_principal_id,state,created_at_utc,updated_at_utc FROM content_asset WHERE id='$asset';
INSERT INTO content_asset_reference VALUES ('$asset','article','42',42,1,NULL,'2026-10-01');
INSERT INTO content_asset_reference SELECT c.id,'revision',r.id::text,r.article_id,1,NULL,'2026-10-01'::timestamp FROM article_revision r JOIN content_asset c ON '/uploads/' || c.storage_key=r.cover_image_url;"
export FSUSBLOG_V1_DB="$(dsn source "$source");Options=-c default_transaction_read_only=on"
export FSUSBLOG_V1_SCHEMA=public
export FSUSBLOG_DB="$(dsn target "$target")" FSUSBLOG_IMPORT_DB="$(dsn target "$target")"
"${migrate[@]}" plan > "$scratch/bootstrap.json"
"${migrate[@]}" apply "$scratch/bootstrap.json"
if [[ "$dormant" == true ]]; then "${migrate[@]}" private-media-import-origin schema; fi
pg target "$target" -c "INSERT INTO public.blog_user VALUES ('$owner','Cover fixture',true,true,1)"
target_site="$(pg target "$target" -Atc 'SELECT site_id FROM public.authoring_recovery_site WHERE singleton')"
mkdir -m 700 "$scratch/public" "$scratch/public/illustration" "$scratch/private" "$scratch/packages"
printf abc > "$scratch/public/illustration/$current_leaf"
printf abc > "$scratch/public/illustration/$historical_leaf"
if [[ "$dormant" == true ]]; then
    pg source "$source" -c "DELETE FROM article_publication; DELETE FROM article_responsibility_snapshot; DELETE FROM article_rights_snapshot; DELETE FROM article_rights_policy;
        UPDATE article SET status=0,current_publication_id=NULL,published_at=NULL,last_published_at=NULL,public_updated_at=NULL"
fi
if [[ "$prepare" == true ]]; then seed_cover_images; fi
"${migrate[@]}" legacy assets rehearsal plan postgres "$scratch/public" "$scratch/private" 87bcdd48-255d-49dd-a984-dd4c4ee6f9d4 "$target_site" > "$scratch/review.json"
python3 - "$scratch/review.json" "$owner" <<'PY'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1]); v=json.loads(p.read_text()); v['owners'][0]['targetUserId']=sys.argv[2]; p.write_text(json.dumps(v))
PY
"${migrate[@]}" legacy assets rehearsal copy postgres "$scratch/public" "$scratch/private" "$scratch/review.json" "$(sha "$scratch/review.json")" "$scratch/packages" media > "$scratch/copied.json"
media_sha="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["manifestSha256"])' "$scratch/copied.json")"
"${migrate[@]}" legacy plan postgres > "$scratch/intake.json" || [[ $? == 2 ]]
python3 - "$scratch/intake.json" "$scratch/owners.json" "$owner" <<'PY'
import json,pathlib,sys
v=json.load(open(sys.argv[1])); a=next(x for x in v['audit']['projections'] if x['table']=='article')
pathlib.Path(sys.argv[2]).write_text(json.dumps(dict(sourceArticleSha256=a['sha256'],sourceAdminIdentitySha256=v['sourceAdminIdentitySha256'],owners=[dict(articleId=42,legacyAdminId=7,v2UserId=sys.argv[3])])))
assert any(x['category']=='attachment-reference' for x in v['importAdmission']['findings'])
PY
owners_sha="$(sha "$scratch/owners.json")"
revision_sha="$(python3 -c 'import json,sys; print(next(x["sha256"] for x in json.load(open(sys.argv[1]))["audit"]["projections"] if x["table"]=="article_revision"))' "$scratch/intake.json")"
publication_sha="$(python3 -c 'import json,sys; print(next(x["sha256"] for x in json.load(open(sys.argv[1]))["audit"]["projections"] if x["table"]=="article_publication"))' "$scratch/intake.json")"
proof=("${migrate[@]}" legacy covers proof postgres "$scratch/packages/media" "$media_sha" "$scratch/owners.json" "$owners_sha" "$revision_sha" "$publication_sha")
"${proof[@]}" > "$scratch/proof.json"
"${proof[@]}" > "$scratch/repeat.json"
cmp "$scratch/proof.json" "$scratch/repeat.json"
"$dotnet_bin" "$BASELINE_MIGRATE_DLL" legacy covers proof postgres "$scratch/packages/media" "$media_sha" "$scratch/owners.json" "$owners_sha" "$revision_sha" "$publication_sha" > "$scratch/old-proof.json"
cmp "$scratch/old-proof.json" "$scratch/proof.json"
python3 - "$scratch/proof.json" "$publication_count" <<'PY'
import json,sys
s=open(sys.argv[1]).read(); v=json.loads(s); c=v['candidates']
assert not v['readyToApply'] and not v['readyToStage']
assert len(c)==4 and len({(r['sourceKind'],r['sourceId']) for r in c})==4
assert all(r['role']=='cover' for r in c)
assert len({r['assetId'] for r in c})==2
assert all(r['sourceRevisionId'] >= 5000000001 for r in c)
assert sum(r['sourceKind']=='revision' and r['currentEdit'] for r in c)==1
assert sum(r['sourceKind']=='revision' and r['currentPublication'] for r in c)==(1 if int(sys.argv[2]) else 0)
assert '/uploads/' not in s and 'ExactName' not in s
PY
export DOTNET_BIN="$dotnet_bin" FSUSBLOG_MIGRATE_DLL="${migrate[1]}" PYTHONDONTWRITEBYTECODE=1
export PGHOST="$scratch/target-s" PGDATABASE="$target"
mkdir -m 700 "$scratch/baselines" "$scratch/empty-media"
baseline_receipt="$(python3 tools/site-backup.py capture "$scratch/baselines" before "$scratch/empty-media")"
baseline_sha="${baseline_receipt##* }"; baseline="$scratch/baselines/before"
python3 tools/site-backup.py verify "$baseline" "$baseline_sha"
cover_args=(--covers "$scratch/packages/media" "$media_sha" "$scratch/proof.json" "$(sha "$scratch/proof.json")")
plan=("${migrate[@]}" legacy import plan postgres "$scratch/owners.json" "$baseline" "$baseline_sha")
"${plan[@]}" > "$scratch/default.json" && exit 1 || [[ $? == 2 ]]
"${plan[@]}" "${cover_args[@]}" > "$scratch/import.json"
python3 - "$scratch/default.json" "$scratch/import.json" <<'PY'
import json,sys
old,new=[json.load(open(p)) for p in sys.argv[1:]]
assert not old['readyToStage'] and 'covers' not in old
assert new['readyToStage'] and not new['readyToApply'] and new['findings']==[]
assert new['version']==1 and new['covers']['version']==1
assert len([r for r in new['expectedTables'] if r['table']=='shadow_cover_mapping' and r['rows']==4])==1
PY
apply=("${migrate[@]}" legacy import apply postgres "$scratch/owners.json" "$baseline" "$baseline_sha" "$scratch/import.json" "${cover_args[@]}")
refuse() { local label="$1"; shift; if "$@" > "$scratch/$label.out" 2> "$scratch/$label.err"; then echo "Unexpected success: $label" >&2; exit 1; fi; }
pristine() { [[ "$(pg target "$target" -Atc "SELECT version=1 AND to_regnamespace('fsus_legacy_candidate') IS NULL FROM public.v2_schema WHERE singleton")" == t ]]; }
pg source "$source" -c "UPDATE article_revision SET cover_image_url='/uploads/illustration/$current_leaf' WHERE id=5000000001"
refuse changed-cover "${apply[@]}"; pristine
pg source "$source" -c "UPDATE article_revision SET cover_image_url='/uploads/illustration/$historical_leaf' WHERE id=5000000001"
pg source "$source" -c "UPDATE admin_principal SET permissions='[1]'"
refuse unrelated-privilege "${apply[@]}"; pristine
pg source "$source" -c "UPDATE admin_principal SET permissions='[]'; CREATE TABLE unsupported_cover_fixture (id integer); INSERT INTO unsupported_cover_fixture VALUES (1)"
refuse unrelated-table "${apply[@]}"; pristine
pg source "$source" -c 'DROP TABLE unsupported_cover_fixture'
# A forged approved document must not turn on staging or change the mapping seal.
python3 - "$scratch/import.json" "$scratch/forged.json" <<'PY'
import json,pathlib,sys
v=json.load(open(sys.argv[1]));v['covers']['mappingSha256']='0'*64;pathlib.Path(sys.argv[2]).write_text(json.dumps(v))
PY
refuse forged-plan "${migrate[@]}" legacy import apply postgres "$scratch/owners.json" "$baseline" "$baseline_sha" "$scratch/forged.json" "${cover_args[@]}"; pristine
# Even a freshly verified package/proof cannot authorize aggregate non-cover usages.
pg source "$source" -c "UPDATE content_asset_reference SET reference_count=2 WHERE source_kind='article'"
"${migrate[@]}" legacy assets rehearsal plan postgres "$scratch/public" "$scratch/private" 87bcdd48-255d-49dd-a984-dd4c4ee6f9d4 "$target_site" > "$scratch/mixed-review.json"
python3 - "$scratch/mixed-review.json" "$owner" <<'PYMIX'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1]);v=json.loads(p.read_text());v['owners'][0]['targetUserId']=sys.argv[2];p.write_text(json.dumps(v))
PYMIX
"${migrate[@]}" legacy assets rehearsal copy postgres "$scratch/public" "$scratch/private" "$scratch/mixed-review.json" "$(sha "$scratch/mixed-review.json")" "$scratch/packages" mixed > "$scratch/mixed-copied.json"
mixed_sha="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["manifestSha256"])' "$scratch/mixed-copied.json")"
"${migrate[@]}" legacy covers proof postgres "$scratch/packages/mixed" "$mixed_sha" "$scratch/owners.json" "$owners_sha" "$revision_sha" "$publication_sha" > "$scratch/mixed-proof.json"
refuse aggregate-reference "${plan[@]}" --covers "$scratch/packages/mixed" "$mixed_sha" "$scratch/mixed-proof.json" "$(sha "$scratch/mixed-proof.json")"
grep -qF 'complete cover-only public assets' "$scratch/aggregate-reference.err"; pristine
pg source "$source" -c 'UPDATE content_asset_reference SET reference_count=1'
"${apply[@]}" > "$scratch/staged.json"
"${apply[@]}" > "$scratch/replayed.json"
[[ "$(pg target "$target" -Atc 'SELECT version FROM public.v2_schema WHERE singleton')" == -1 ]]
[[ "$(pg target "$target" -Atc 'SELECT count(*) FROM public.article')" == 0 ]]
[[ "$(pg target "$target" -Atc 'SELECT count(*) FROM fsus_legacy_candidate.shadow_article')" == 1 ]]
[[ "$(pg target "$target" -Atc 'SELECT count(*) FROM fsus_legacy_candidate.shadow_revision')" == 3 ]]
[[ "$(pg target "$target" -Atc 'SELECT count(*) FROM fsus_legacy_candidate.shadow_publication')" == "$publication_count" ]]
[[ "$(pg target "$target" -Atc 'SELECT count(*) FROM fsus_legacy_candidate.shadow_cover_mapping')" == 4 ]]
[[ "$(pg target "$target" -Atc 'SELECT count(*) FROM fsus_legacy_candidate.checkpoint')" == 3 ]]
plan_sha="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["planSha256"])' "$scratch/staged.json")"
for mode in project verify; do
    refuse "$mode" "${migrate[@]}" legacy import "$mode" "$scratch/import.json" "$plan_sha" "$baseline" "$baseline_sha"
done
refuse release "${migrate[@]}" legacy import release-plan "$scratch/import.json" "$plan_sha" "$baseline" "$baseline_sha" "$target_site" "$baseline" "$baseline_sha"
# Supply syntactically complete options but an invalid target: all plan-based modes must hit the guard first.
zeros="$(printf '0%.0s' {1..64})"
for mode in media-request media-verify media-activation-plan media-activate; do
    extra=()
    if [[ "$mode" == media-activate ]]; then extra+=(--approval "$scratch/import.json" "$plan_sha"); fi
    if [[ "$mode" == media-activation-plan || "$mode" == media-activate ]]; then
        extra+=(--destination "$scratch/empty-media" "$target_site" "$baseline" "$baseline_sha")
    fi
    if [[ "$mode" != media-request ]]; then extra+=(--prepared "$scratch/packages/media" "$media_sha" "$zeros"); fi
    extra+=(--media "$scratch/packages/media" "$media_sha")
    refuse "$mode-guard" env FSUSBLOG_IMPORT_DB=invalid "${migrate[@]}" legacy import "$mode" "$scratch/import.json" "$plan_sha" "$baseline" "$baseline_sha" "${extra[@]}"
    grep -qF 'Cover-bearing candidates cannot project' "$scratch/$mode-guard.err"
done
refuse release-activate-guard env FSUSBLOG_IMPORT_DB=invalid "${migrate[@]}" legacy import release-activate "$scratch/import.json" "$plan_sha" "$baseline" "$baseline_sha" "$target_site" "$baseline" "$baseline_sha" "$scratch/import.json" "$plan_sha"
grep -qF 'Cover-bearing candidates cannot project' "$scratch/release-activate-guard.err"
refuse server "${migrate[@]}" verify
pg target "$target" -c "UPDATE fsus_legacy_candidate.shadow_cover_mapping SET mapping_json='{}' WHERE source_kind='article'"
refuse mapping-tamper "${apply[@]}"
# Restore the exact one mapping from its approved original witness for further isolated assertions.
python3 - "$scratch/proof.json" "$scratch/repair.sql" <<'PY'
import json,pathlib,sys
v=next(r for r in json.load(open(sys.argv[1]))['candidates'] if r['sourceKind']=='article')
s=json.dumps(v,indent=2).replace("'","''")
pathlib.Path(sys.argv[2]).write_text("UPDATE fsus_legacy_candidate.shadow_cover_mapping SET mapping_json='"+s+"' WHERE source_kind='article';")
PY
pg target "$target" -f "$scratch/repair.sql"
"${apply[@]}" > "$scratch/repaired.json"
pg target "$target" -c 'ALTER TABLE fsus_legacy_candidate.shadow_cover_mapping ALTER COLUMN mapping_json DROP NOT NULL'
refuse mapping-shape "${apply[@]}"
pg target "$target" -c 'ALTER TABLE fsus_legacy_candidate.shadow_cover_mapping ALTER COLUMN mapping_json SET NOT NULL'
checkpoint="$(pg target "$target" -Atc 'SELECT digest FROM fsus_legacy_candidate.checkpoint WHERE phase=1')"
pg target "$target" -c "UPDATE fsus_legacy_candidate.checkpoint SET digest='$zeros' WHERE phase=1"
refuse checkpoint-tamper "${apply[@]}"
pg target "$target" -c "UPDATE fsus_legacy_candidate.checkpoint SET digest='$checkpoint' WHERE phase=1"
"${apply[@]}" > "$scratch/final-replay.json"
if [[ "$prepare" == true ]]; then prove_cover_preparation; fi
if [[ "$dormant" == true ]]; then prove_dormant_cover; exit 0; fi
pg_dump -h "$scratch/target-s" -p "$PGPORT" -U "$PGUSER" -Fc "$target" > "$scratch/candidate.dump"
restored=fsusv2_import_cover_restored
pg target postgres -c "CREATE DATABASE $restored TEMPLATE template0"
pg_restore -h "$scratch/target-s" -p "$PGPORT" -U "$PGUSER" --no-owner --no-acl --exit-on-error -d "$restored" "$scratch/candidate.dump"
# Independent native candidate schema/data dumps compare restored custody, not activation.
# The refused restored write below also passes normal public catalog/baseline checks before physical-target refusal.
for db in "$target" "$restored"; do
    pg_dump -h "$scratch/target-s" -p "$PGPORT" -U "$PGUSER" --no-owner --no-acl --schema=fsus_legacy_candidate "$db" | sed '/^\\restrict /d; /^\\unrestrict /d' > "$scratch/$db.sql"
done
cmp "$scratch/$target.sql" "$scratch/$restored.sql"
[[ "$(pg target "$restored" -Atc 'SELECT version FROM public.v2_schema WHERE singleton')" == -1 ]]
refuse restored-server env FSUSBLOG_DB="$(dsn target "$restored")" "${migrate[@]}" verify
refuse restored-write env FSUSBLOG_IMPORT_DB="$(dsn target "$restored")" "${apply[@]}"
printf 'PASS: same-snapshot cover-aware article history staging, three checkpoints/replay, unrelated/stale/forged/tamper refusal, projection/release guards, native restored non-serving candidate.\n'

grep -qF 'independent candidate database' "$scratch/restored-write.err"
# Original 7b85f40 versus new binary, same no-cover source/target baseline before staging.
pg source "$source" -c "UPDATE article SET coverimageurl=NULL; UPDATE article_revision SET cover_image_url=NULL; DROP TABLE content_asset_cleanup_queue, content_asset_reference, content_asset;
UPDATE article_publication SET transition_kind='immediate-publish';
UPDATE article SET last_published_at='2026-10-02 00:00:00', public_updated_at='2026-10-02 00:00:00'"
target=fsusv2_import_nocover
pg target postgres -c "CREATE DATABASE $target TEMPLATE template0"
export FSUSBLOG_DB="$(dsn target "$target")" FSUSBLOG_IMPORT_DB="$(dsn target "$target")" PGDATABASE="$target"
"${migrate[@]}" plan > "$scratch/no-cover-bootstrap.json"
"${migrate[@]}" apply "$scratch/no-cover-bootstrap.json"
pg target "$target" -c "INSERT INTO public.blog_user VALUES ('$owner','Cover fixture',true,true,1)"
"${migrate[@]}" legacy plan postgres > "$scratch/no-cover-intake.json" || [[ $? == 2 ]]
python3 - "$scratch/no-cover-intake.json" "$scratch/owners.json" <<'PYNO'
import json,pathlib,sys
v=json.load(open(sys.argv[1])); p=pathlib.Path(sys.argv[2]);m=json.loads(p.read_text())
m['sourceArticleSha256']=next(x['sha256'] for x in v['audit']['projections'] if x['table']=='article')
m['sourceAdminIdentitySha256']=v['sourceAdminIdentitySha256'];p.write_text(json.dumps(m))
PYNO
receipt="$(python3 tools/site-backup.py capture "$scratch/baselines" no-cover "$scratch/empty-media")"
no_sha="${receipt##* }"; no_backup="$scratch/baselines/no-cover"
"$dotnet_bin" "$BASELINE_MIGRATE_DLL" legacy import plan postgres "$scratch/owners.json" "$no_backup" "$no_sha" > "$scratch/old-no-cover.json"
"${migrate[@]}" legacy import plan postgres "$scratch/owners.json" "$no_backup" "$no_sha" > "$scratch/new-no-cover.json"
cmp "$scratch/old-no-cover.json" "$scratch/new-no-cover.json"
"${migrate[@]}" legacy import apply postgres "$scratch/owners.json" "$no_backup" "$no_sha" "$scratch/old-no-cover.json" > "$scratch/no-cover-staged.json"
"${migrate[@]}" legacy import apply postgres "$scratch/owners.json" "$no_backup" "$no_sha" "$scratch/old-no-cover.json" > "$scratch/no-cover-replayed.json"
no_plan_sha="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["planSha256"])' "$scratch/no-cover-staged.json")"
"${migrate[@]}" legacy import project "$scratch/old-no-cover.json" "$no_plan_sha" "$no_backup" "$no_sha" > "$scratch/no-cover-projected.json"
"${migrate[@]}" legacy import verify "$scratch/old-no-cover.json" "$no_plan_sha" "$no_backup" "$no_sha" > "$scratch/no-cover-verified.json"
printf 'PASS: unchanged 7b85f40/new no-cover plan bytes match exactly before stage; original plan stages/replays/projects/verifies.\n'
