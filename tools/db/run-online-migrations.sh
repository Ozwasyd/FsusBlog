#!/usr/bin/env bash
set -euo pipefail
umask 077

server_dll="${FSUSBLOG_SERVER_DLL:-/app/FsusBlog.Server.dll}"
release_manifest=""
env_file=""
phase=""
migration_id=""
evidence_file=""
dry_run=0
confirm_destructive=0

fail() {
    local code="$1"
    printf '{"status":"failed","code":"%s"}\n' "$code"
    exit 2
}

while (($# > 0)); do
    case "$1" in
        --server-dll)
            (($# >= 2)) || fail "schema_wrapper_server_dll_value_missing"
            server_dll="$2"
            shift 2
            ;;
        --release-manifest)
            (($# >= 2)) || fail "schema_wrapper_release_manifest_value_missing"
            release_manifest="$2"
            shift 2
            ;;
        --env-file)
            (($# >= 2)) || fail "schema_wrapper_env_file_value_missing"
            env_file="$2"
            shift 2
            ;;
        --phase)
            (($# >= 2)) || fail "schema_wrapper_phase_value_missing"
            phase="$2"
            shift 2
            ;;
        --id)
            (($# >= 2)) || fail "schema_wrapper_id_value_missing"
            migration_id="$2"
            shift 2
            ;;
        --evidence)
            (($# >= 2)) || fail "schema_wrapper_evidence_value_missing"
            evidence_file="$2"
            shift 2
            ;;
        --dry-run)
            dry_run=1
            shift
            ;;
        --confirm-destructive)
            confirm_destructive=1
            shift
            ;;
        *)
            fail "schema_wrapper_argument_unknown"
            ;;
    esac
done

[[ -r "$server_dll" ]] || fail "schema_wrapper_server_dll_unreadable"
[[ -r "$release_manifest" ]] || fail "schema_wrapper_release_manifest_unreadable"
[[ -r "$env_file" ]] || fail "schema_wrapper_env_file_unreadable"

case "$phase" in
    expand)
        [[ -z "$migration_id" ]] || fail "schema_wrapper_expand_id_forbidden"
        ;;
    backfill | backfill-resume)
        [[ -n "$migration_id" ]] || fail "schema_wrapper_backfill_id_required"
        phase="backfill-resume"
        ;;
    contract)
        [[ -z "$migration_id" ]] || fail "schema_wrapper_contract_id_forbidden"
        [[ -r "$evidence_file" ]] || fail "schema_wrapper_contract_evidence_unreadable"
        if ((dry_run == 0 && confirm_destructive == 0)); then
            fail "schema_wrapper_contract_confirmation_required"
        fi
        ;;
    *)
        fail "schema_wrapper_phase_invalid"
        ;;
esac

dotnet_bin="${DOTNET_BIN:-dotnet}"
command=(
    "$dotnet_bin"
    "$server_dll"
    migrate
    --phase "$phase"
    --release-manifest "$release_manifest"
    --env-file "$env_file"
)

if [[ -n "$migration_id" ]]; then
    command+=(--id "$migration_id")
fi
if [[ -n "$evidence_file" ]]; then
    command+=(--evidence "$evidence_file")
fi
if ((dry_run == 1)); then
    command+=(--dry-run)
fi
if ((confirm_destructive == 1)); then
    command+=(--confirm-destructive)
fi

exec "${command[@]}"
