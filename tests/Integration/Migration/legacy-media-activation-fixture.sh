# Sourced only by legacy-joined-media.sh --activate after its real prepared artifact verification.
stop_runtime() {
    local step
    if kill -0 "$runtime_pid" 2>/dev/null; then kill "$runtime_pid"; fi
    for ((step=0; step<100; step++)); do
        if ! kill -0 "$runtime_pid" 2>/dev/null; then break; fi
        sleep 0.1
    done
    if kill -0 "$runtime_pid" 2>/dev/null; then
        kill -KILL "$runtime_pid"
        wait "$runtime_pid" 2>/dev/null || true
        runtime_pid=
        return 1
    fi
    wait "$runtime_pid" 2>/dev/null || true
    runtime_pid=
}

prove_media_activation() {
    local runtime="fsusv2_import_runtime_${prefix##*_}" runtime_site runtime_oid original_oid current_site state
    local target_backup_sha target_backup activation_sha outcome ready_sha ready_backup step url
    local stable="$scratch/runtime-media/$payload.media" restored_app="${prefix}_active_restore"
    local restored_rollback="${prefix}_runtime_rollback" rollback_root="$scratch/runtime-restored-rollback-media"
    local runtime_root="$scratch/runtime-media" restored_root="$scratch/runtime-restored-media"
    local tmproot="$scratch/runtime-transfer" transfer_query="$PWD/tests/Integration/Migration/legacy-runtime-transfer.sql"
    mkdir -m 700 "$runtime_root" "$restored_root" "$rollback_root" "$tmproot" "$scratch/approval" "$scratch/runtime-work"
    pg target postgres -c "CREATE DATABASE $runtime TEMPLATE template0"
    pg target postgres -c "CREATE DATABASE $restored_app TEMPLATE template0"
    pg target postgres -c "CREATE DATABASE $restored_rollback TEMPLATE template0"
    local runtime_dsn; runtime_dsn="$(dsn target "$runtime")"
    FSUSBLOG_DB="$runtime_dsn" "${migrate[@]}" plan > "$scratch/runtime-bootstrap.json"
    FSUSBLOG_DB="$runtime_dsn" "${migrate[@]}" apply "$scratch/runtime-bootstrap.json"
    FSUSBLOG_DB="$runtime_dsn" "${migrate[@]}" private-media-import-origin schema
    runtime_site="$(pg target "$runtime" -Atc 'SELECT site_id FROM public.authoring_recovery_site WHERE singleton')"
    runtime_oid="$(pg target "$runtime" -Atc 'SELECT oid FROM pg_database WHERE datname=current_database()')"
    original_oid="$(pg target "$target" -Atc 'SELECT oid FROM pg_database WHERE datname=current_database()')"
    [[ "$runtime_site" != "$target_site" && "$runtime_oid" != "$original_oid" ]]
    local db_args=(-v plan_sha="$plan_sha" -v projection_sha="$(json_value projectionSha256 "$scratch/projected.json")"
        -v owner_id="$owner" -v owner2="$owner2" -v rollback_profile=false -v media_profile=true -v media_batch="$batch" -v interrupt_transfer=false)
    (cd "$tmproot" && pg target "$target" "${db_args[@]}" -v database_name="$target" -v database_oid="$original_oid" \
        -v site_id="$target_site" -v copy_out=true -v source_seal=true -f "$transfer_query")
    (cd "$tmproot" && pg target "$runtime" "${db_args[@]}" -v database_name="$runtime" -v database_oid="$runtime_oid" \
        -v site_id="$runtime_site" -v copy_out=false -v source_seal=false -f "$transfer_query")

    outcome="$(PGDATABASE="$runtime" FSUSBLOG_DB="$runtime_dsn" python3 tools/site-backup.py capture "$scratch/target-backup" activation_seed "$runtime_root")"
    target_backup_sha="${outcome##* }"
    target_backup="$scratch/target-backup/activation_seed"
    pg_restore --no-password -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" --dbname "$restored_rollback" --single-transaction \
        --exit-on-error --no-owner --no-privileges "$target_backup/database.dump"
    FSUSBLOG_DB="$(dsn target "$restored_rollback")" python3 tools/site-backup.py verify-restored \
        "$target_backup" "$target_backup_sha" "$rollback_root"
    [[ "$(target_state "$restored_rollback")" == "1|t|$article_count|0|0|0" ]]
    export FSUSBLOG_MEDIA_ACTIVATION_DB="$runtime_dsn"
    local destination=(--destination "$runtime_root" "$runtime_site" "$target_backup" "$target_backup_sha"
        --prepared "$recovered" "$prepared_sha" "$normalizer_sha" "${media[@]}")
    local approval="$scratch/approval/activation.json"
    local base=("$scratch/import.json" "$plan_sha" "$backup" "$backup_sha")
    "${migrate[@]}" legacy import media-activation-plan "${base[@]}" "${destination[@]}" > "$approval"
    activation_sha="$(sha "$approval")"
    if [[ "$batch" == false && -n "${FSUSBLOG_V1_ACTIVATION_MIGRATE_DLL:-}" ]]; then
        "$DOTNET_BIN" "$FSUSBLOG_V1_ACTIVATION_MIGRATE_DLL" legacy import media-activation-plan "${base[@]}" "${destination[@]}" > "$scratch/approval/old-approval.json"
        cmp "$approval" "$scratch/approval/old-approval.json"
        approval="$scratch/approval/old-approval.json"
        printf '%s\n' 'Original v1 approval bytes match and will be consumed by the new command.'
    fi
    local apply_media=("${migrate[@]}" legacy import media-activate "${base[@]}" --approval "$approval" "$activation_sha" "${destination[@]}")
    refuse 'local Unix socket and a separately authorized' activation-quarantine env FSUSBLOG_MEDIA_ACTIVATION_DB="$FSUSBLOG_IMPORT_DB" "${apply_media[@]}"
    pg target "$runtime" -c "UPDATE public.article SET title = 'Unreviewed other draft' WHERE id=42"
    refuse 'does not match the original private article and revision' changed-runtime-draft "${apply_media[@]}"
    pg target "$runtime" -c "UPDATE public.article SET title = 'Private edit' WHERE id=42"
    [[ ! -e "$stable" && "$(target_state "$runtime")" == "1|t|$article_count|0|0|0" ]]
    FSUSBLOG_DB="$runtime_dsn" python3 tools/site-backup.py verify-restored "$target_backup" "$target_backup_sha" "$runtime_root"

    if [[ "$batch" == true ]]; then
        python3 - "$recovered/$current_leaf.blob" "$runtime_root/$current_leaf.media" <<'BAD_FILE'
import pathlib, sys
content = bytearray(pathlib.Path(sys.argv[1]).read_bytes()); content[-1] ^= 1
pathlib.Path(sys.argv[2]).write_bytes(content)
BAD_FILE
        chmod 0400 "$runtime_root/$current_leaf.media"
        refuse 'Media bytes do not match' corrupt-batch-subset "${apply_media[@]}"
        [[ ! -e "$stable" && ! -e "$runtime_root/$historical_leaf.media" && "$(target_state "$runtime")" == "1|t|$article_count|0|0|0" ]]
        rm "$runtime_root/$current_leaf.media"
    fi
    "${apply_media[@]}" > "$scratch/activated.json"
    cmp "$stable" "$recovered/$payload.blob"
    "${apply_media[@]}" > "$scratch/activation-retry.json"
    [[ "$(json_value result "$scratch/activated.json")" == activated ]]
    [[ "$(json_value result "$scratch/activation-retry.json")" == revalidated ]]
    [[ "$(json_value activationSha256 "$scratch/activated.json")" == "$activation_sha" ]]
    [[ "$(target_state "$runtime")" == "1|t|$article_count|$asset_count|$reference_count|0" ]]
    state="$(pg target "$runtime" -Atc "SELECT m.id,m.owner_id,m.command_id IS NULL,m.request_hash IS NULL,
        i.source_site_id,i.target_site_id,i.source_owner_id,encode(i.activation_sha256,'hex'),
        r.article_id,r.revision,r.source_revision_id,r.reference_count,r.alt_text
        FROM private_media m JOIN private_media_import i ON i.asset_id=m.id JOIN article_revision_media_import r ON r.asset_id=i.asset_id
        WHERE m.id='$asset'")"
    [[ "$state" == "$asset|$owner|t|t|$source_site|$runtime_site|7|$activation_sha|42|3|5000000003|1|Retained private file" ]]
    if [[ "$batch" == true ]]; then
        state="$(pg target "$runtime" -Atc "SELECT m.id,m.owner_id,m.command_id IS NULL,m.request_hash IS NULL,
            i.source_owner_id,encode(i.activation_sha256,'hex'),m.format,m.name,r.article_id,r.revision,r.source_revision_id,r.reference_count,r.alt_text
            FROM private_media m JOIN private_media_import i ON i.asset_id=m.id JOIN article_revision_media_import r ON r.asset_id=i.asset_id
            WHERE m.owner_id='$owner2' ORDER BY r.revision,m.id")"
        [[ "$state" == "$historical_asset|$owner2|t|t|8|$activation_sha|1|$historical_leaf.png|43|1|5000000004|1|历史附件"$'\n'"$current_asset|$owner2|t|t|8|$activation_sha|2|$current_leaf.jpg|43|1|5000000004|1|Previous second owner"$'\n'"$current_asset|$owner2|t|t|8|$activation_sha|2|$current_leaf.jpg|43|2|5000000005|1|Current second owner" ]]
        pg target "$runtime" -c "BEGIN; DELETE FROM article_revision_media_import WHERE asset_id='$current_asset';
            DELETE FROM article_revision_media WHERE asset_id='$current_asset'; COMMIT"
        refuse 'does not match the reviewed pre-activation backup or this exact committed media activation' partial-batch-db "${apply_media[@]}"
        [[ "$(target_state "$runtime")" == "1|t|$article_count|$asset_count|2|0" ]]
    fi
    # Simulate database rollback after a verified file is durable. The real materialized file stays unchanged.
    pg target "$runtime" -c 'BEGIN; DELETE FROM article_revision_media_import; DELETE FROM article_revision_media;
        DELETE FROM private_media; DELETE FROM private_media_import; COMMIT'
    [[ "$(target_state "$runtime")" == "1|t|$article_count|0|0|0" ]]
    if [[ "$batch" == true ]]; then rm "$runtime_root/$current_leaf.media"; fi
    "${apply_media[@]}" > "$scratch/recovered-file-only.json"
    cmp "$scratch/activated.json" "$scratch/recovered-file-only.json"
    cmp "$stable" "$recovered/$payload.blob"
    printf '%s\n' 'Initial file creation, exact revalidation and file-only retry passed.'
    mv "$stable" "$scratch/held-normalized.blob"
    refuse 'committed imported media file is missing' committed-file-unavailable "${apply_media[@]}"
    mv "$scratch/held-normalized.blob" "$stable"
    cmp "$stable" "$recovered/$payload.blob"
    [[ "$(target_state "$target")" == "-1|f|$article_count|0|0|0" ]]

    outcome="$(PGDATABASE="$runtime" FSUSBLOG_DB="$runtime_dsn" python3 tools/site-backup.py capture "$scratch/target-backup" activation_ready "$runtime_root")"
    ready_sha="${outcome##* }"
    ready_backup="$scratch/target-backup/activation_ready"
    python3 tools/site-backup.py verify "$ready_backup" "$ready_sha"
    pg_restore --no-password -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" --dbname "$restored_app" --single-transaction \
        --exit-on-error --no-owner --no-privileges "$ready_backup/database.dump"
    cp "$ready_backup/media/"*.media "$restored_root/"
    chmod 0400 "$restored_root/"*.media
    local restore_dsn; restore_dsn="$(dsn target "$restored_app")"
    FSUSBLOG_DB="$restore_dsn" python3 tools/site-backup.py verify-restored "$ready_backup" "$ready_sha" "$restored_root"
    current_site="$(pg target "$restored_app" -Atc 'SELECT site_id FROM public.authoring_recovery_site WHERE singleton')"
    [[ "$current_site" == "$runtime_site" && "$(target_state "$restored_app")" == "1|t|$article_count|$asset_count|$reference_count|0" ]]
    FSUSBLOG_DB="$restore_dsn" "${migrate[@]}" ticket 'Legacy rehearsal custodian' > "$scratch/owner-ticket"
    local extra_probe=()
    if [[ "$batch" == true ]]; then
        FSUSBLOG_DB="$restore_dsn" "${migrate[@]}" ticket 'Legacy rehearsal second custodian' > "$scratch/outsider-ticket"
        extra_probe=("$historical_asset" "$current_asset" "$recovered/$historical_leaf.blob" "$recovered/$current_leaf.blob")
    else
        FSUSBLOG_DB="$restore_dsn" "${migrate[@]}" operator 'Activation outsider' > "$scratch/outsider-ticket"
    fi
    (
        cd "$scratch/runtime-work"
        exec env -i PATH="$PATH" LC_ALL=C TZ=UTC ASPNETCORE_ENVIRONMENT=Production ASPNETCORE_URLS=http://127.0.0.1:0 \
            FSUSBLOG_DB="$restore_dsn" FSUSBLOG_WEB_DIST="$runtime_web" FSUSBLOG_PRIVATE_MEDIA_ROOT="$restored_root" \
            "$DOTNET_BIN" "$server_dll"
    ) > "$scratch/runtime-server.log" 2>&1 &
    runtime_pid=$!
    url=''
    for ((step=0; step<150; step++)); do
        if ! kill -0 "$runtime_pid" 2>/dev/null; then cat "$scratch/runtime-server.log" >&2; return 1; fi
        url="$(rg -o 'http://127\.0\.0\.1:[0-9]+' "$scratch/runtime-server.log" | head -1 || true)"
        if [[ -n "$url" ]] && [[ "$(curl --noproxy '*' --silent --max-time 1 -o /dev/null -w '%{http_code}' "$url/health/ready")" == 204 ]]; then break; fi
        sleep 0.1
    done
    [[ "$step" -lt 150 ]]
    node tests/Integration/Migration/legacy-media-activation-probe.mjs "$url" "$asset" "$scratch/owner-ticket" "$scratch/outsider-ticket" "$stable" ${extra_probe[@]+"${extra_probe[@]}"}
    stop_runtime
    printf 'activation_sha256=%s runtime_backup_sha256=%s runtime_rollback_sha256=%s\n' "$activation_sha" "$ready_sha" "$target_backup_sha"
}
