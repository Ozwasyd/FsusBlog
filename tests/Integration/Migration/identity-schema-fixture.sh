# Sourced by the native identity schema rehearsals.
source "$(cd "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/pg-fixture.sh"

start_identity_fixture() {
    if [[ -z "${FSUSBLOG_TEST_CLI_DLL:-}" ]]; then
        printf '%s\n' 'Configure a scratch PostgreSQL cluster and the built CLI DLL.' >&2
        exit 2
    fi
    pg_fixture_init "fsus-$1" 0 'Configure a scratch PostgreSQL cluster and the built CLI DLL.'
    database="fsusv2_${2}_$(openssl rand -hex 12)"
    pg_fixture_preserve_on_error="$3"
    pg_fixture_cleanup_message="Removed the $3 test database and scratch files."
    pg_fixture_drop_mode="${4:-}"
    pg=(psql -X --no-password -v ON_ERROR_STOP=1)
    migrate=("$dotnet_bin" "$FSUSBLOG_TEST_CLI_DLL")

    pg_fixture_create_db "$database"
    export FSUSBLOG_DB="$settings;Database=$database"
    query=("${pg[@]}" -d "$database" -qAtc)
    "${migrate[@]}" plan > "$scratch/plan.json"
    "${migrate[@]}" apply "$scratch/plan.json"
    "${migrate[@]}" verify
}

# Preserve the command's output and the caller's exact failure diagnostic.
expect_identity_rejection() {
    local failure="$1"
    shift
    pg_fixture_expect_failure "$scratch/rejection.log" "" "$failure" "$@" || exit 1
}
