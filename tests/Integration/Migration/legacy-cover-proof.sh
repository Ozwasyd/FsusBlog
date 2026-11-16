#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
export PATH="${PG_TOOLS_DIR:-/opt/homebrew/opt/postgresql@18/bin}:$PATH"
dotnet_bin="${DOTNET_BIN:-dotnet}"
migrate=("$dotnet_bin" "${FSUSBLOG_MIGRATE_DLL:-$PWD/src/Migrate/bin/Release/net10.0/FsusBlogV2.Migrate.dll}")
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
