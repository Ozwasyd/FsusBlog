# Shared PostgreSQL scratch-database and CLI helpers for tests/Integration/Migration/*.sh.
pg_fixture_dbs=()
pg_fixture_scratch=""
pg_fixture_drop_mode=""
pg_fixture_cleanup_message=""
pg_fixture_preserve_on_error=""

pg_fixture_init() {
  local prefix="$1" require_socket="$2" missing_msg="$3"
  dotnet_bin="${DOTNET_BIN:-dotnet}"
  if [[ -n "${PG_TOOLS_DIR:-}" ]]; then PATH="$PG_TOOLS_DIR:$PATH"; fi
  if [[ -z "${FSUSBLOG_TEST_DB:-}" || -z "${PGHOST:-}" || -z "${PGUSER:-}" ]] ||
     { (( require_socket )) && [[ "${PGHOST:-}" != /* ]]; }; then
    printf '%s\n' "$missing_msg" >&2
    exit 2
  fi
  umask 077
  pg_fixture_scratch="$(mktemp -d "${TMPDIR:-/tmp}/$prefix.XXXXXXXX")"
  pg_fixture_scratch="$(cd "$pg_fixture_scratch" && pwd -P)"
  scratch="$pg_fixture_scratch"
  settings="${FSUSBLOG_TEST_DB%;}"
  psql_main=(psql -X --no-password -v ON_ERROR_STOP=1 --dbname postgres)
  trap pg_fixture_cleanup EXIT
}

pg_fixture_create_db() {
  local name="$1"
  "${psql_main[@]}" -qc "CREATE DATABASE \"$name\" TEMPLATE template0"
  pg_fixture_dbs+=("$name")
}

pg_fixture_build_cli() {
  local cli_project="src/Cli/FsusBlog.V2.Cli.csproj"
  "$dotnet_bin" restore "$cli_project" --configfile NuGet.Config --locked-mode
  "$dotnet_bin" build "$cli_project" --no-restore
  export DOTNET_BIN="$dotnet_bin"
  export FSUSBLOG_CLI_DLL="src/Cli/bin/Debug/net10.0/FsusBlog.V2.Cli.dll"
  cli=("$DOTNET_BIN" "$FSUSBLOG_CLI_DLL")
}

pg_fixture_cleanup() {
  local code=$? i db
  trap - EXIT
  for (( i=${#pg_fixture_dbs[@]}-1; i>=0; i-- )); do
    db="${pg_fixture_dbs[$i]}"
    if ! "${psql_main[@]}" -qc "DROP DATABASE \"$db\"$pg_fixture_drop_mode" >&2; then
      printf 'Database cleanup failed: %s\n' "$db" >&2
      if (( code == 0 )); then code=1; fi
    fi
  done
  if [[ -n "$pg_fixture_scratch" ]]; then
    if (( code != 0 )) && [[ -n "$pg_fixture_preserve_on_error" ]]; then
      printf 'Preserved the %s test files at %s.\n' "$pg_fixture_preserve_on_error" "$pg_fixture_scratch" >&2
    elif ! find "$pg_fixture_scratch" -depth -delete; then
      printf 'Artifact cleanup failed: %s\n' "$pg_fixture_scratch" >&2
      if (( code == 0 )); then code=1; fi
    fi
  fi
  if (( code == 0 )) && [[ -n "$pg_fixture_cleanup_message" ]]; then
    printf '%s\n' "$pg_fixture_cleanup_message"
  fi
  exit "$code"
}

pg_fixture_expect_failure() {
  local log="$1" expected="$2" unexpected="$3"
  shift 3
  if "$@" > "$log" 2>&1; then
    printf '%s\n' "$unexpected" >&2
    return 1
  fi
  if [[ -n "$expected" ]] && ! rg -F "$expected" "$log"; then
    cat "$log" >&2
    return 1
  fi
}

pg_fixture_sha256_hex() {
  printf '%s' "$1" | xxd -r -p | openssl dgst -sha256 | awk '{print $NF}'
}
