# Sourced by the native identity schema rehearsals.
start_identity_fixture() {
    if [[ -z "${FSUSBLOG_TEST_DB:-}" || -z "${PGHOST:-}" || -z "${PGUSER:-}" || -z "${FSUSBLOG_TEST_CLI_DLL:-}" ]]; then
        printf '%s\n' 'Configure a scratch PostgreSQL cluster and the built CLI DLL.' >&2
        exit 2
    fi
    scratch=$(mktemp -d "${TMPDIR:-/tmp}/fsus-$1.XXXXXXXX")
    database="fsusv2_${2}_$(openssl rand -hex 12)"
    fixture_label="$3"
    drop_mode="${4:-}"
    pg=(psql -X --no-password -v ON_ERROR_STOP=1)
    migrate=("${DOTNET_BIN:-dotnet}" "$FSUSBLOG_TEST_CLI_DLL")
    created=0
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
    if (( created )) && ! "${pg[@]}" -d postgres -qc "DROP DATABASE \"$database\"$drop_mode"; then result=1; fi
    if (( result )); then
        printf 'Preserved the %s test files at %s.\n' "$fixture_label" "$scratch" >&2
    else
        rm -f "$scratch/plan.json" "$scratch/rejection.log" && rmdir "$scratch" || result=1
        if (( result == 0 )); then printf 'Removed the %s test database and scratch files.\n' "$fixture_label"; fi
    fi
    exit "$result"
}

# Preserve the command's output and the caller's exact failure diagnostic.
expect_identity_rejection() {
    local failure="$1"
    shift
    if "$@" > "$scratch/rejection.log" 2>&1; then
        printf '%s\n' "$failure" >&2
        exit 1
    fi
}
