# Sourced by legacy-cover-import.sh --dormant, after exact prepared-image verification.
prove_dormant_cover() {
    local normalizer_sha prepared_sha review_sha
    normalizer_sha="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["normalizerSha256"])' "$scratch/normalizer.json")"
    prepared_sha="$(sha "$scratch/prepared/first/manifest.json")"
    mkdir -m 700 "$scratch/dormant-media" "$scratch/dormant-restored-media" "$scratch/approval"
    local -a inputs=("$scratch/import.json" "$plan_sha" "$baseline" "$baseline_sha" "$scratch/cover-request.json" "$(sha "$scratch/cover-request.json")" "$scratch/packages/media" "$scratch/prepared/first" "$prepared_sha" "$normalizer_sha")
    "${migrate[@]}" legacy covers dormant-plan "${inputs[@]}" "$scratch/dormant-media" > "$scratch/approval/dormant.json"
    review_sha="$(sha "$scratch/approval/dormant.json")"
    local -a apply=("${migrate[@]}" legacy covers dormant-apply "${inputs[@]}" "$scratch/dormant-media" "$scratch/approval/dormant.json" "$review_sha")
    refuse dormant-root-guard env FSUSBLOG_PRIVATE_MEDIA_ROOT="$scratch/dormant-media" "${apply[@]}"
    [[ "$(pg target "$target" -Atc 'SELECT count(*) FROM public.article')" == 0 ]]
    # Simulate exact orphan bytes from a rolled-back attempt; only approved identical bytes may be reused.
    cp "$scratch/prepared/first/${asset//-/}.blob" "$scratch/dormant-media/${asset//-/}.media"
    "${apply[@]}" > "$scratch/dormant-first.json"
    "${apply[@]}" > "$scratch/dormant-repeat.json"
    [[ "$(pg target "$target" -Atc 'SELECT version FROM public.v2_schema')" == -1 ]]
    [[ "$(pg target "$target" -Atc 'SELECT count(*) FROM public.article_revision_cover')" == 3 ]]
    [[ "$(pg target "$target" -Atc 'SELECT count(*) FROM public.private_media')" == 2 ]]
    [[ "$(pg target "$target" -Atc 'SELECT count(*) FROM public.article_publication')" == 0 ]]
    [[ "$(pg target "$target" -Atc 'SELECT count(*) FROM public.article_publication_history')" == 0 ]]
    [[ "$(pg target "$target" -Atc 'SELECT count(*) FROM public.article_publication_cover')" == 0 ]]
    pg target "$target" -Atc "SELECT c.article_id,c.revision,c.asset_id,m.owner_id,encode(m.content_hash,'hex'),m.length FROM public.article_revision_cover c JOIN public.private_media m ON m.id=c.asset_id ORDER BY c.revision" > "$scratch/dormant-roles.out"
    pg_dump -h "$scratch/target-s" -p "$PGPORT" -U "$PGUSER" -Fc "$target" > "$scratch/dormant.dump"
    restored=fsusv2_import_dormant_restored
    pg target postgres -c "CREATE DATABASE $restored TEMPLATE template0"
    pg_restore -h "$scratch/target-s" -p "$PGPORT" -U "$PGUSER" --no-owner --no-acl --exit-on-error -d "$restored" "$scratch/dormant.dump"
    cp "$scratch/dormant-media/"*.media "$scratch/dormant-restored-media/"
    FSUSBLOG_IMPORT_DB="$(dsn target "$restored")" "${migrate[@]}" legacy covers dormant-verify "${inputs[@]}" "$scratch/dormant-restored-media" "$scratch/approval/dormant.json" "$review_sha" > "$scratch/dormant-restored.json"
    refuse dormant-clone-write env FSUSBLOG_IMPORT_DB="$(dsn target "$restored")" "${apply[@]}"
    refuse dormant-server "${migrate[@]}" verify
    local saved="$scratch/original.blob"
    cp "$scratch/dormant-media/${asset//-/}.media" "$saved"
    chmod 600 "$scratch/dormant-media/${asset//-/}.media"; printf bad > "$scratch/dormant-media/${asset//-/}.media"; chmod 400 "$scratch/dormant-media/${asset//-/}.media"
    refuse dormant-corrupt-file "${apply[@]}"
    chmod 600 "$scratch/dormant-media/${asset//-/}.media"; cat "$saved" > "$scratch/dormant-media/${asset//-/}.media"; chmod 400 "$scratch/dormant-media/${asset//-/}.media"
    "${apply[@]}" > "$scratch/dormant-final.json"
    pg target "$target" -c "DELETE FROM public.article_revision_cover WHERE revision=1"
    refuse dormant-role-tamper "${apply[@]}"
    pg target "$target" -c "INSERT INTO public.article_revision_cover VALUES (42,1,'3c550000-0000-4000-8000-000000000003')"
    "${apply[@]}" > "$scratch/dormant-final.json"
    python3 - "$scratch/dormant-first.json" "$scratch/dormant-repeat.json" "$scratch/dormant-restored.json" <<'PY'
import json,sys
rows=[json.load(open(p)) for p in sys.argv[1:]]
assert len({r['stateSha256'] for r in rows})==1
assert all(not r['serving'] for r in rows)
assert [r['result'] for r in rows]==['materialized','revalidated','verified']
PY
    printf 'PASS: actual dormant revision covers/private bytes, exact replay after orphan-file state, native DB+file restore read-only verification, wrong-target/file/server refusal.\n'
}
