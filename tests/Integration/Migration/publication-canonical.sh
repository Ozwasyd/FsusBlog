#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."

if [[ ${PGHOST:-} != /* || -z ${PGUSER:-} || -z ${FSUSBLOG_TEST_DB:-} ]]; then
    printf '%s\n' 'Set PGHOST and PGUSER for an isolated PostgreSQL Unix socket, with matching FSUSBLOG_TEST_DB.' >&2
    exit 2
fi
if [[ -n ${PG_TOOLS_DIR:-} ]]; then PATH="$PG_TOOLS_DIR:$PATH"; fi
migrate=("${DOTNET_BIN:-dotnet}" "${FSUSBLOG_MIGRATE_DLL:-src/Migrate/bin/Release/net10.0/FsusBlogV2.Migrate.dll}")
umask 077
scratch=$(mktemp -d /tmp/fsusv2-canonical.XXXXXXXX)
database="fsusv2_canonical_$(openssl rand -hex 9)"
maintenance=(psql -X -q --no-password -v ON_ERROR_STOP=1 -d postgres)
created=0
cleanup() {
    local code=$?
    if (( created )); then "${maintenance[@]}" -c "DROP DATABASE \"$database\"" || code=1; fi
    find "$scratch" -depth -delete || code=1
    exit "$code"
}
trap cleanup EXIT
"${maintenance[@]}" -c "CREATE DATABASE \"$database\" TEMPLATE template0"
created=1
sql=(psql -X -q --no-password -v ON_ERROR_STOP=1 -d "$database")
export FSUSBLOG_DB="${FSUSBLOG_TEST_DB%;};Database=$database"
"${migrate[@]}" plan > "$scratch/plan.json"
"${migrate[@]}" apply "$scratch/plan.json"

# Reconstruct the previously accepted schema, then exercise the actual offline adoption command.
"${sql[@]}" <<'SQL'
DROP TABLE public.article_publication_canonical;
ALTER TABLE public.article_publication_history DROP CONSTRAINT publication_history_native_binding;
ALTER TABLE public.article_publication_rights DROP CONSTRAINT publication_rights_native_binding;
ALTER TABLE public.blog_outbox DROP CONSTRAINT outbox_native_publication_binding;
INSERT INTO public.blog_user VALUES ('65235b8e-5d95-411a-8a9c-d1036d319b71','fixture author',true,true,1);
BEGIN;
INSERT INTO public.article(id,owner_id,revision,title,body,published_revision,publication_count,deleted)
    OVERRIDING SYSTEM VALUE VALUES (42,'65235b8e-5d95-411a-8a9c-d1036d319b71',9007199254740993,'Réseau 🐈',
        E'Cafe\u0301\r\n独立😀\n',9007199254740993,1,false);
INSERT INTO public.article_revision VALUES (42,9007199254740993,'Réseau 🐈',E'Cafe\u0301\r\n独立😀\n','2026-11-13T00:00:00.120001Z');
INSERT INTO public.tag(id,name) VALUES (11,'Tag Anna'),(42,'Tag Bo');
INSERT INTO public.article_revision_tag VALUES (42,9007199254740993,42),(42,9007199254740993,11);
INSERT INTO public.article_revision_rights VALUES (42,9007199254740993,false,'CC-BY-4.0','',0,E'État\n新','{title}',
    'append-attribution',0,true,false,true);
INSERT INTO public.article_publication VALUES (42,9007199254741999,9007199254740993,1,'2026-11-13T00:00:00.120001Z');
INSERT INTO public.article_publication_rights(id,article_id,publication_id,revision) OVERRIDING SYSTEM VALUE
    VALUES (9007199254742999,42,9007199254741999,9007199254740993);
INSERT INTO public.article_publication_history(article_id,event_no,revision,publication_no,publication_id,kind,reason,happened_at)
    VALUES (42,1,9007199254740993,1,9007199254741999,'retained-active','pre-history','2026-11-13T00:00:00.120001Z');
COMMIT;
SQL
expect_failure() {
    if "${migrate[@]}" publication-canonical verify "$@" > "$scratch/stdout" 2> "$scratch/stderr"; then
        printf '%s\n' 'Canonical verification unexpectedly succeeded.' >&2
        exit 1
    fi
}
expect_failure
rg -F 'storage is not installed' "$scratch/stderr"
"${migrate[@]}" publication-canonical schema
"${migrate[@]}" publication-canonical schema
"${migrate[@]}" publication-canonical verify | rg -Fx '{"canonicalVersion":2,"verifiedPublications":0}'
expect_failure 9007199254741999
rg -F 'has no native canonical binding' "$scratch/stderr"
[[ $("${sql[@]}" -Atc "SELECT published_at='2026-11-13T00:00:00.120001Z' FROM public.article_publication") == t ]]

# Provision external, independently frozen digest and coordinate observations to test CLI verification.
"${sql[@]}" <<'SQL'
UPDATE public.article_publication_history SET kind='publish' WHERE article_id=42;
INSERT INTO public.blog_outbox(id,article_id,revision,kind) OVERRIDING SYSTEM VALUE
    VALUES (9007199254743999,42,9007199254740993,'publish');
INSERT INTO public.article_publication_canonical VALUES (9007199254741999,42,9007199254740993,1,'2026-11-13T00:00:00.120001Z',
    'publish',9007199254742999,9007199254743999,'publish',2,
    decode('24239fad08e881ba50750f3d8d5ced03746a398201e9e68e7036eefdb9c25bb2','hex'),
    decode('c2bfe4d5c0d344bae54fc17049ee5d4375f3141601d8f60597b8d1ccabd7689a','hex'));
SQL
FSUSBLOG_DB="$FSUSBLOG_DB;Options=-c default_transaction_read_only=on" \
    "${migrate[@]}" publication-canonical verify 9007199254741999 > "$scratch/receipt.json"
python3 - "$scratch/receipt.json" <<'PY'
import json, sys
from pathlib import Path
receipt = json.loads(Path(sys.argv[1]).read_text())
assert receipt == dict(
    canonicalVersion=2, publicationId='9007199254741999', articleId=42, revision='9007199254740993',
    publicationNo=1, publishedAtUtc='2026-11-13T00:00:00.120001Z', transition='publish',
    rightsSnapshotId='9007199254742999', publicationOutboxId='9007199254743999',
    contentSha256='24239fad08e881ba50750f3d8d5ced03746a398201e9e68e7036eefdb9c25bb2',
    policySha256='c2bfe4d5c0d344bae54fc17049ee5d4375f3141601d8f60597b8d1ccabd7689a',
), receipt
PY
"${sql[@]}" -c "UPDATE public.article_revision SET body=body || 'changed' WHERE article_id=42"
expect_failure 9007199254741999
rg -F 'canonical digests differ' "$scratch/stderr"
"${sql[@]}" -c "UPDATE public.article_revision SET body=E'Cafe\u0301\r\n独立😀\n' WHERE article_id=42"
"${sql[@]}" -c 'UPDATE public.article_revision_rights SET proof_binding_enabled=false WHERE article_id=42'
expect_failure
rg -F 'canonical digests differ' "$scratch/stderr"
"${sql[@]}" -c 'UPDATE public.article_revision_rights SET proof_binding_enabled=true WHERE article_id=42'
"${migrate[@]}" publication-canonical verify | rg -Fx '{"canonicalVersion":2,"verifiedPublications":1}'
"${sql[@]}" -c 'ALTER TABLE public.article_publication_canonical DROP CONSTRAINT canonical_exact_outbox'
expect_failure
rg -F 'constraint shape mismatch' "$scratch/stderr"
printf '%s\n' 'Native publication canonical admission, bounded receipt, and retained fact verification passed.'
