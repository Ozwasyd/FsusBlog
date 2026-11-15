#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$root"
dotnet_bin="${DOTNET_BIN:-dotnet}"
if [[ -n "${PG_TOOLS_DIR:-}" ]]; then PATH="$PG_TOOLS_DIR:$PATH"; fi

provider="${1:-}"
if [[ "$provider" != sqlite && "$provider" != postgres && "$provider" != mysql ]]; then
    printf 'Usage: %s sqlite|postgres|mysql\n' "$0" >&2
    exit 2
fi
if [[ "$provider" == postgres && ( -z "${FSUSBLOG_TEST_DB:-}" || -z "${PGHOST:-}" || -z "${PGUSER:-}" ) ]]; then
    printf '%s\n' "Set FSUSBLOG_TEST_DB, PGHOST and PGUSER to the same isolated PostgreSQL test cluster." >&2
    exit 2
fi
if [[ "$provider" == mysql ]]; then
    # shellcheck source=tests/Integration/Migration/mysql-scratch.sh
    source tests/Integration/Migration/mysql-scratch.sh
    check_mysql_tools
fi
umask 077
if [[ "$provider" == mysql ]]; then
    # Keep the Unix socket path below macOS and Linux limits.
    scratch="$(mktemp -d "/tmp/fsusv2-legacy.XXXXXXXX")"
    scratch="$(cd "$scratch" && pwd -P)"
else
    scratch="$(mktemp -d "${TMPDIR:-/tmp}/fsusv2-legacy.XXXXXXXX")"
fi
fixture="tests/Integration/Migration/legacy-source-fixture.sql"
rights_fixture="tests/Integration/Migration/legacy-shared-rights-fixture.sql"
database="fsusv2_legacy_$(openssl rand -hex 12)"
created=0
pg=(psql -X --no-password -v ON_ERROR_STOP=1)
cleanup() {
    local code=$?
    if [[ "$provider" == mysql ]] && ! stop_mysql_scratch "$scratch"; then
        printf 'MySQL cleanup did not complete. Preserving %s\n' "$scratch" >&2
        if [[ "$code" == 0 ]]; then code=1; fi
        exit "$code"
    fi
    if (( code != 0 )); then
        printf 'Preserved failed source rehearsal reports in %s. PostgreSQL fixture, if created: %s\n' "$scratch" "$database" >&2
        exit "$code"
    fi
    if [[ "$created" == 1 ]] && ! "${pg[@]}" -d postgres -c "DROP DATABASE \"$database\""; then
        printf 'Could not remove owned test database %s\n' "$database" >&2
        if [[ "$code" == 0 ]]; then code=1; fi
    fi
    if ! rm -f -- "$scratch/source.sqlite" "$scratch/"{inventory,plan,repeat,corrupt,incomplete,owner,rehearsal,owner-invalid}.json ||
       ! rmdir -- "$scratch"; then
        printf 'Could not remove owned scratch directory %s\n' "$scratch" >&2
        if [[ "$code" == 0 ]]; then code=1; fi
    fi
    if [[ "$provider" == mysql && "$code" == 0 ]]; then
        printf 'Removed the MySQL scratch server, socket and data directory.\n'
    fi
    exit "$code"
}
trap cleanup EXIT

if [[ "$provider" == postgres ]]; then
    "${pg[@]}" -d postgres -c "CREATE DATABASE \"$database\" TEMPLATE template0"
    created=1
    "${pg[@]}" -d "$database" -f "$fixture"
    "${pg[@]}" -d "$database" -f "$rights_fixture"
    export FSUSBLOG_V1_DB="${FSUSBLOG_TEST_DB%;};Database=$database;Options=-c default_transaction_read_only=on"
    export FSUSBLOG_V1_SCHEMA=public
    source_sql=("${pg[@]}" -d "$database" -c)
elif [[ "$provider" == mysql ]]; then
    start_mysql_scratch "$scratch"
    "${mysql_admin[@]}" -e "CREATE DATABASE $database CHARACTER SET utf8mb4;
        CREATE USER 'fsus_read'@'localhost';
        GRANT SELECT ON $database.* TO 'fsus_read'@'localhost'"
    cat "$fixture" "$rights_fixture" | "${mysql_admin[@]}" "$database"
    export FSUSBLOG_V1_DB="Server=$scratch/mysql.sock;Protocol=Unix;User ID=fsus_read;Database=$database;SSL Mode=Disabled"
    source_sql=("${mysql_admin[@]}" "$database" -e)
else
    export FSUSBLOG_V1_SQLITE_PATH="$scratch/source.sqlite"
    cat "$fixture" "$rights_fixture" | sqlite3 -bail "$FSUSBLOG_V1_SQLITE_PATH"
    source_sql=(sqlite3 "$FSUSBLOG_V1_SQLITE_PATH")
fi

migrate_project=src/Migrate/FsusBlogV2.Migrate.csproj
"$dotnet_bin" restore "$migrate_project" --configfile NuGet.Config --locked-mode
"$dotnet_bin" build "$migrate_project" --no-restore
migrate=("$dotnet_bin" src/Migrate/bin/Debug/net10.0/FsusBlogV2.Migrate.dll)

expect_blocked() {
    local rc=0
    env -u FSUSBLOG_DB -u FSUSBLOG_IMPORT_DB "${migrate[@]}" legacy plan "$provider" > "$1" || rc=$?
    [[ "$rc" == 2 ]]
}

"${migrate[@]}" legacy inventory "$provider" > "$scratch/inventory.json"
expect_blocked "$scratch/plan.json"
expect_blocked "$scratch/repeat.json"
cmp "$scratch/plan.json" "$scratch/repeat.json"
python3 - "$scratch/" "$provider" <<'PY'
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
inventory = json.loads((root / 'inventory.json').read_text())
plan_raw = (root / 'plan.json').read_text()
plan = json.loads(plan_raw)
assert inventory['audit']['issues'] == []
assert not plan['readyToApply'] and plan['blockers']
assert plan['audit']['issues'] == []
actual = {p['table']: p['rows'] for p in inventory['audit']['projections']}
assert actual == {
    'article': 1,
    'article_body': 1,
    'article_revision': 3,
    'article_revision_content_block': 3,
    'article_publication': 2,
    'category': 2,
    'tag': 3,
    'article_tag': 2,
    'tag_url_alias': 2,
    'article_rights_policy': 1,
    'article_rights_snapshot': 2,
    'article_responsibility_snapshot': 3,
}
assert all(len(p['sha256']) == 64 for p in plan['audit']['projections'])
assert 'Private edit' not in plan_raw and 'published ☃' not in plan_raw
if sys.argv[2] == 'postgres':
    assert plan['importAdmission'] == {
        'classificationComplete': True, 'eligibleForCandidatePlanning': True,
        'sourceProjections': plan['audit']['projections'], 'findings': [],
    }
article = next(p for p in plan['audit']['projections'] if p['table'] == 'article')
mapping = {
    'sourceArticleSha256': article['sha256'],
    'sourceAdminIdentitySha256': plan['sourceAdminIdentitySha256'],
    'owners': [{'articleId': 42, 'legacyAdminId': 7, 'v2UserId': '968ffb2b-77ef-4868-89ec-6a0a19b28b95'}],
}
(root / 'owner.json').write_text(json.dumps(mapping))
mapping['owners'][0]['legacyAdminId'] = 404
(root / 'owner-invalid.json').write_text(json.dumps(mapping))
PY

if [[ "$provider" == postgres ]]; then
    "${source_sql[@]}" "
        ALTER TABLE article ADD COLUMN views integer NOT NULL DEFAULT 0;
        UPDATE article SET views=19 WHERE id=42;
        CREATE TABLE article_view_seed(article_id integer PRIMARY KEY, legacy_views integer NOT NULL DEFAULT 0,
            seeded_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc'));
        INSERT INTO article_view_seed VALUES (42, 7, '2026-10-04 00:00:00');
        UPDATE admin_principal SET isroot=true, permissions='fixture-private-grant' WHERE id=7;
        CREATE TABLE admin_passkey_credential(id bigint PRIMARY KEY, adminprincipalid bigint NOT NULL,
            credentialid varchar(512) NOT NULL);
        INSERT INTO admin_passkey_credential VALUES (1, 7, 'fixture-private-credential');
    "
    expect_blocked "$scratch/corrupt.json"
    python3 - "$scratch/plan.json" "$scratch/corrupt.json" <<'PY'
import json
import pathlib
import sys

before = json.loads(pathlib.Path(sys.argv[1]).read_text())
raw = pathlib.Path(sys.argv[2]).read_text()
after = json.loads(raw)
admission = after['importAdmission']
assert admission['classificationComplete'] and not admission['eligibleForCandidatePlanning']
assert admission['sourceProjections'][:-2] == before['importAdmission']['sourceProjections']
assert [(item['table'], item['rows']) for item in admission['sourceProjections'][-2:]] == [
    ('article.views', 1), ('article_view_seed', 1)
]
assert admission['findings'] == [
    {'category': category, 'source': source, 'rows': 1}
    for category, source in [
        ('identity-or-privilege', 'admin_passkey_credential'),
        ('legacy-privilege', 'admin_principal.isroot'),
        ('legacy-privilege', 'admin_principal.permissions'),
    ]
]
assert 'fixture-private-grant' not in raw and 'fixture-private-credential' not in raw
PY
    "${source_sql[@]}" "
        DROP TABLE admin_passkey_credential, article_view_seed;
        UPDATE admin_principal SET isroot=false, permissions='[]' WHERE id=7;
        ALTER TABLE article DROP COLUMN views;
    "

    "${source_sql[@]}" "
        CREATE TABLE article_property_definition_display_name(definition_id uuid NOT NULL, locale varchar(32) NOT NULL,
            value varchar(256) NOT NULL, PRIMARY KEY(definition_id,locale));
        INSERT INTO article_property_definition_display_name VALUES
            ('435573a4-aa8a-4c8a-9a4c-de821839be53', 'en', 'fixture-private-name'),
            ('435573a4-aa8a-4c8a-9a4c-de821839be53', 'zh', '仅供取证');
        CREATE TABLE article_property_unreviewed_value(id integer PRIMARY KEY, value text);
        INSERT INTO article_property_unreviewed_value VALUES (1, 'fixture-private-property-value');
        CREATE VIEW article_property_unverified_view AS SELECT value FROM article_property_unreviewed_value;
    "
    expect_blocked "$scratch/corrupt.json"
    "${migrate[@]}" legacy inventory postgres > "$scratch/inventory.json"
    "${source_sql[@]}" "UPDATE article_property_definition_display_name SET value = 'changed-private-name' WHERE locale = 'en'"
    expect_blocked "$scratch/repeat.json"
    python3 - "$scratch" <<'PY'
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
raw = (root / 'corrupt.json').read_text()
plan = json.loads(raw)
after = json.loads((root / 'repeat.json').read_text())
inventory = json.loads((root / 'inventory.json').read_text())
assert all(value not in raw for value in ['fixture-private-name', 'fixture-private-property-value', '仅供取证'])
assert plan['propertyInventory'] == inventory['propertyInventory']
assert not plan['readyToApply'] and not plan['importAdmission']['eligibleForCandidatePlanning']
relations = {item['relation']: item for item in plan['propertyInventory']}
assert set(relations) == {'article_property_definition_display_name', 'article_property_unreviewed_value', 'article_property_unverified_view'}
known = relations['article_property_definition_display_name']
view = relations['article_property_unverified_view']
unknown = relations['article_property_unreviewed_value']
assert known['relation'] == 'article_property_definition_display_name'
assert known['rows'] == 2 and known['recordedInFrozenDefinitionAuthority']
assert known['disposition'] == 'requires-review' and len(known['postgreSqlSha256']) == 64
assert view['disposition'] == 'unverifiable-relation' and view['rows'] is None
assert not unknown['recordedInFrozenDefinitionAuthority'] and unknown['rows'] == 1 and unknown['postgreSqlSha256'] is None
assert after['propertyInventory'][0]['postgreSqlSha256'] != known['postgreSqlSha256']
assert after['audit']['projections'] == plan['audit']['projections']
print('Legacy property inventory classified 2 frozen definition rows, 1 unknown value row and an unverifiable view. Values remain redacted.')
PY
    "${source_sql[@]}" "
        DROP VIEW article_property_unverified_view;
        DROP TABLE article_property_definition_display_name, article_property_unreviewed_value;
    "
fi

"${migrate[@]}" legacy rehearse "$provider" "$scratch/owner.json" > "$scratch/rehearsal.json"
"${migrate[@]}" legacy rehearse "$provider" "$scratch/owner.json" > "$scratch/repeat.json"
cmp "$scratch/rehearsal.json" "$scratch/repeat.json"
if "${migrate[@]}" legacy rehearse "$provider" "$scratch/owner-invalid.json" > /dev/null; then
    printf '%s\n' 'Missing legacy owner unexpectedly accepted.' >&2
    exit 1
fi
python3 - "$scratch/rehearsal.json" <<'PY'
import json
import pathlib
import sys

raw = pathlib.Path(sys.argv[1]).read_text()
report = json.loads(raw)
assert report['readyToApply'] is False and report['blockers']
rehearsal = report['rehearsal']
assert len(rehearsal['ownerMapSha256']) == 64
assert rehearsal['sourceAdminIdentitySha256'] == report['sourceAdminIdentitySha256']
assert {entry['table']: entry['rows'] for entry in rehearsal['counts']} == {
    'shadow_article': 1, 'shadow_revision': 3, 'shadow_publication': 2,
    'shadow_article_revision_content_block': 3,
    'shadow_category': 2, 'shadow_tag': 3, 'shadow_article_tag': 2, 'shadow_tag_url_alias': 2,
    'shadow_article_rights_policy': 1, 'shadow_article_rights_snapshot': 2,
    'shadow_article_responsibility_snapshot': 3, 'shadow_revision_tag': 4,
}
assert all(len(entry['sha256']) == 64 for entry in rehearsal['counts'])
assert 'Private edit' not in raw and 'published ☃' not in raw
PY

"${source_sql[@]}" "UPDATE admin_principal SET handle = 'different-editor' WHERE id = 7"
if "${migrate[@]}" legacy rehearse "$provider" "$scratch/owner.json" > /dev/null; then
    printf '%s\n' 'Owner map accepted for a different principal identity set.' >&2
    exit 1
fi
"${source_sql[@]}" "UPDATE admin_principal SET handle = 'fixture-editor' WHERE id = 7"

"${source_sql[@]}" 'UPDATE article_publication SET rights_snapshot_id = 700 WHERE id = 900000002'
expect_blocked "$scratch/corrupt.json"
rg -F 'publication does not resolve its exact snapshot coordinates: article_rights_snapshot' "$scratch/corrupt.json"
"${source_sql[@]}" 'UPDATE article_publication SET rights_snapshot_id = 701 WHERE id = 900000002'
"${source_sql[@]}" "UPDATE article_rights_snapshot SET policy_hash = 'unrecognized' WHERE id = 700"
expect_blocked "$scratch/corrupt.json"
rg -F 'unrecognized legacy rights snapshot hash representation' "$scratch/corrupt.json"
"${source_sql[@]}" "UPDATE article_rights_snapshot SET policy_hash = 'rights-v3:policy-hash:recompute' WHERE id = 700"
"${migrate[@]}" legacy rehearse "$provider" "$scratch/owner.json" > "$scratch/repeat.json"
"${source_sql[@]}" 'UPDATE article_responsibility_snapshot SET previous_snapshot_id = 799 WHERE id = 801'
expect_blocked "$scratch/corrupt.json"
rg -F 'responsibility predecessor is outside its valid lineage' "$scratch/corrupt.json"
"${source_sql[@]}" 'UPDATE article_responsibility_snapshot SET previous_snapshot_id = 800 WHERE id = 801'
"${source_sql[@]}" "UPDATE article_revision SET tag_ids = '21,21' WHERE id = 5000000002"
if "${migrate[@]}" legacy rehearse "$provider" "$scratch/owner.json" > /dev/null; then
    printf '%s\n' 'Duplicate historical tag identity was silently dropped.' >&2
    exit 1
fi
"${source_sql[@]}" "UPDATE article_revision SET tag_ids = '21' WHERE id = 5000000002"
"${source_sql[@]}" "UPDATE tag_url_alias SET normalized_name = 'NEWS', original_name = 'News' WHERE tag_id = 23"
if "${migrate[@]}" legacy rehearse "$provider" "$scratch/owner.json" > /dev/null; then
    printf '%s\n' 'An alias shadowing another tag was silently changed.' >&2
    exit 1
fi
"${source_sql[@]}" "UPDATE tag_url_alias SET normalized_name = 'CAFÉ ARCHIVE', original_name = 'Café Archive' WHERE tag_id = 23"

"${source_sql[@]}" "UPDATE article_revision_content_block SET markdown_content = 'wrong' WHERE id = 200"
"${source_sql[@]}" 'UPDATE article_publication SET revision_no = 3 WHERE id = 900000002'
expect_blocked "$scratch/corrupt.json"
rg -F '"kind": "immutable block byte count or SHA-256 mismatch"' "$scratch/corrupt.json"
rg -F '"kind": "publication missing parent article, matching revision or required coordinate"' "$scratch/corrupt.json"
"${source_sql[@]}" 'ALTER TABLE article RENAME COLUMN current_publication_id TO unknown'
expect_blocked "$scratch/incomplete.json"
rg -F 'article.current_publication_id: required v1 column missing or ambiguous' "$scratch/incomplete.json"
if [[ "$provider" == postgres ]]; then
    python3 - "$scratch/incomplete.json" <<'PY'
import json
import pathlib
import sys

report = json.loads(pathlib.Path(sys.argv[1]).read_text())
assert report['propertyInventory'] is None
admission = report['importAdmission']
assert not admission['classificationComplete'] and not admission['eligibleForCandidatePlanning']
PY
fi
if [[ "$provider" == mysql ]]; then
    "${source_sql[@]}" 'ALTER TABLE article RENAME COLUMN unknown TO current_publication_id'
    "${source_sql[@]}" 'ALTER TABLE article_body ENGINE=MyISAM'
    expect_blocked "$scratch/incomplete.json"
    rg -F 'article_body: relation is not a supported transactional base table' "$scratch/incomplete.json"
fi
printf 'Legacy %s read-only inventory, shadow rehearsal and blocker checks passed.\n' "$provider"
