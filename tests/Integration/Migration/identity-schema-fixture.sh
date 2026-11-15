# Sourced by the native identity schema rehearsals.
start_identity_fixture() {
    if [[ -z "${FSUSBLOG_TEST_DB:-}" || -z "${PGHOST:-}" || -z "${PGUSER:-}" || -z "${FSUSBLOG_TEST_MIGRATE_DLL:-}" ]]; then
        printf '%s\n' 'Configure a scratch PostgreSQL cluster and the built migration DLL.' >&2
        exit 2
    fi
    scratch=$(mktemp -d "${TMPDIR:-/tmp}/fsus-$1.XXXXXXXX")
    database="fsusv2_${2}_$(openssl rand -hex 12)"
    fixture_label="$3"
    drop_mode="${4:-}"
    pg=(psql -X --no-password -v ON_ERROR_STOP=1)
    migrate=("${DOTNET_BIN:-dotnet}" "$FSUSBLOG_TEST_MIGRATE_DLL")
    created=0
    lease=''
    trap finish_identity_fixture EXIT

    "${pg[@]}" -d postgres -qc "CREATE DATABASE \"$database\" TEMPLATE template0"
    created=1
    export FSUSBLOG_DB="${FSUSBLOG_TEST_DB%;};Database=$database"
    query=("${pg[@]}" -d "$database" -qAtc)
    "${migrate[@]}" plan > "$scratch/plan.json"
    "${migrate[@]}" apply "$scratch/plan.json"
    "${migrate[@]}" verify
}

finish_identity_fixture() {
    local result=$?
    trap - EXIT
    if [[ -n "$lease" ]]; then
        kill "$lease" 2>/dev/null || true
        wait "$lease" 2>/dev/null || true
    fi
    if (( created )) && ! "${pg[@]}" -d postgres -qc "DROP DATABASE \"$database\"$drop_mode"; then result=1; fi
    if (( result )); then
        printf 'Preserved the %s test files at %s.\n' "$fixture_label" "$scratch" >&2
    else
        rm -f "$scratch/plan.json" "$scratch/rejection.log" "$scratch/lease.log" && rmdir "$scratch" || result=1
        if (( result == 0 )); then printf 'Removed the %s test database and scratch files.\n' "$fixture_label"; fi
    fi
    exit "$result"
}

require_stopped_identity_schema() {
    local failure="$1"
    shift
    "${query[@]}" 'SELECT pg_advisory_lock(716729109726707501); SELECT pg_sleep(4)' > "$scratch/lease.log" &
    lease=$!
    for _ in {1..40}; do
        if [[ $("${query[@]}" "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND granted
            AND database=(SELECT oid FROM pg_database WHERE datname=current_database())") -gt 0 ]]; then break; fi
        sleep .05
    done
    if "${migrate[@]}" "$@" > "$scratch/rejection.log" 2>&1; then
        printf '%s\n' "$failure" >&2
        exit 1
    fi
    rg -qF 'Stop the serving process' "$scratch/rejection.log"
    wait "$lease"
    lease=''
}
