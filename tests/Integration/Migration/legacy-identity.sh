#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."

provider="${1:-sqlite}"
case "$provider" in
    sqlite|postgres|mysql) ;;
    *) printf 'Usage: %s [sqlite|postgres|mysql]\n' "$0" >&2; exit 2 ;;
esac
if [[ -n "${PG_TOOLS_DIR:-}" ]]; then PATH="$PG_TOOLS_DIR:$PATH"; fi
if [[ "$provider" == postgres && ( "${PGHOST:-}" != /* || -z "${PGUSER:-}" || -z "${FSUSBLOG_TEST_DB:-}" ) ]]; then
    printf '%s\n' 'Set PGHOST and PGUSER for the isolated PostgreSQL Unix socket, with matching FSUSBLOG_TEST_DB.' >&2
    exit 2
fi
if [[ "$provider" == mysql ]]; then
    # shellcheck source=tests/Integration/Migration/mysql-scratch.sh
    source tests/Integration/Migration/mysql-scratch.sh
    check_mysql_tools
fi

umask 077
scratch="$(mktemp -d /tmp/fsusv2-legacy-id.XXXXXXXX)"
scratch="$(cd "$scratch" && pwd -P)"
fixture=tests/Integration/Migration/legacy-identity-fixture.sql
project=src/Migrate/FsusBlogV2.Migrate.csproj
database="fsusv2_legacy_id_$(openssl rand -hex 12)"
created=0
pg=(psql -X --no-password -v ON_ERROR_STOP=1)
cleanup() {
    local code=$?
    if [[ "$provider" == mysql ]] && ! stop_mysql_scratch "$scratch"; then
        printf 'MySQL cleanup did not complete. Preserving %s\n' "$scratch" >&2
        exit 1
    fi
    if [[ "$created" == 1 ]] && ! "${pg[@]}" -d postgres -c "DROP DATABASE \"$database\"" >/dev/null; then
        printf 'Could not remove owned database %s\n' "$database" >&2
        code=1
    fi
    find "$scratch" -depth -delete || code=1
    exit "$code"
}
trap cleanup EXIT

case "$provider" in
    sqlite)
        export FSUSBLOG_V1_SQLITE_PATH="$scratch/source.sqlite"
        source_sql=(sqlite3 -bail "$FSUSBLOG_V1_SQLITE_PATH")
        "${source_sql[@]}" < "$fixture"
        ;;
    postgres)
        "${pg[@]}" -d postgres -c "CREATE DATABASE \"$database\" TEMPLATE template0" >/dev/null
        created=1
        "${pg[@]}" -d "$database" -f "$fixture" >/dev/null
        export FSUSBLOG_V1_DB="${FSUSBLOG_TEST_DB%;};Database=$database;Options=-c default_transaction_read_only=on"
        export FSUSBLOG_V1_SCHEMA=public
        source_sql=("${pg[@]}" -d "$database" -c)
        ;;
    mysql)
        start_mysql_scratch "$scratch"
        "${mysql_admin[@]}" -e "CREATE DATABASE $database CHARACTER SET utf8mb4;
            CREATE USER 'fsus_read'@'localhost'; GRANT SELECT ON $database.* TO 'fsus_read'@'localhost'"
        "${mysql_admin[@]}" "$database" < "$fixture"
        export FSUSBLOG_V1_DB="Server=$scratch/mysql.sock;Protocol=Unix;User ID=fsus_read;Database=$database;SSL Mode=Disabled"
        source_sql=("${mysql_admin[@]}" "$database" -e)
        ;;
esac

dotnet_bin="${DOTNET_BIN:-dotnet}"
"$dotnet_bin" restore "$project" --configfile NuGet.Config --locked-mode
"$dotnet_bin" build "$project" --no-restore
migrate=("$dotnet_bin" src/Migrate/bin/Debug/net10.0/FsusBlogV2.Migrate.dll)
check_report() {
    local code=0
    "${migrate[@]}" legacy identity "$provider" > "$1" 2> "$scratch/error" || code=$?
    if [[ "$code" != 2 || -s "$scratch/error" ]]; then
        printf 'Expected a compatibility report with blockers, got %s\n' "$code" >&2
        return 1
    fi
}

if [[ "$provider" == sqlite ]]; then
    shasum -a 256 "$FSUSBLOG_V1_SQLITE_PATH" > "$scratch/source.before"
fi
check_report "$scratch/report.json"
check_report "$scratch/repeat.json"
if [[ "$provider" == sqlite ]]; then
    shasum -a 256 "$FSUSBLOG_V1_SQLITE_PATH" > "$scratch/source.after"
    cmp "$scratch/source.before" "$scratch/source.after"
fi
python3 - "$scratch/report.json" "$scratch/repeat.json" "$provider" <<'PY'
import json
import re
import sys
from datetime import datetime
from pathlib import Path

raw = Path(sys.argv[1]).read_text()
report = json.loads(raw)
repeat = json.loads(Path(sys.argv[2]).read_text())
for receipt in (report, repeat):
    datetime.strptime(receipt.pop('sessionStateAtUtc'), '%Y-%m-%dT%H:%M:%SZ')
assert report == repeat
assert report['sourceReference'] == '2605b438eed8f16d12ddddf033d08a6fa18fcd12'
assert report['provider'] == sys.argv[3] and report['readyToApply'] is False
assert report['accountRows'] == report['administratorRows'] == 2
assert report['namespaceIdOverlaps'] == 1
assert re.fullmatch('[0-9a-f]{64}', report['sourceIdentitySha256'])
relations = {relation['name']: (relation['present'], relation['rows']) for relation in report['relations']}
for name, count in {
    'passkey_credential': 1,
    'admin_passkey_credential': 2,
    'account_recovery_key': 3,
    'user_mfa_profile': 1,
    'sys_user_session': 3,
    'admin_session': 1,
    'user_refresh_token_tombstone': 1,
    'account_enrollment_session': 1,
    'admin_audit_log': 1,
}.items():
    assert relations[name] == (True, count), relations
issues = {issue['kind']: issue['count'] for issue in report['issues']}
expected = {
    'account-subject-projection-required': 2,
    'legacy-password-era-account-fields': 1,
    'administrator-permission-unmapped': 1,
    'administrator-root-unsupported': 1,
    'account-mfa-custody-required': 1,
    'administrator-totp-custody-required': 1,
    'administrator-multiple-passkeys': 1,
    'passkey-relying-party-proof-required': 3,
    'recovery-key-custody-required': 3,
    'used-recovery-key-retention-required': 1,
    'revoked-recovery-key-retention-required': 1,
    'persistent-session-revocation-required': 1,
    'compromised-session-retention-required': 1,
    'administrator-session-revocation-required': 1,
    'refresh-tombstone-retention-required': 1,
    'enrollment-session-revocation-required': 1,
    'administrator-audit-history-retention-required': 1,
}
assert all(issues.get(kind) == count for kind, count in expected.items()), issues
for secret in ('fixture-', 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
               'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
               'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
               'AAECAwQFBgcICQoLDA0ODw', 'AQIDBAUGBwgJCgsMDQ4PEA', 'AgMEBQYHCAkKCwwNDg8QEQ',
               'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8', 'pQECAyYgASFYIGsX0fLhLEJH'):
    assert secret not in raw, 'identity source value leaked'
PY

"${source_sql[@]}" "UPDATE admin_principal SET permissions='fixture-unknown-grant' WHERE id=7" >/dev/null
check_report "$scratch/unknown.json"
python3 - "$scratch/report.json" "$scratch/unknown.json" <<'PY'
import json
import sys
from pathlib import Path

initial = json.loads(Path(sys.argv[1]).read_text())
raw = Path(sys.argv[2]).read_text()
unknown = json.loads(raw)
assert unknown['sourceIdentitySha256'] != initial['sourceIdentitySha256']
assert unknown['readyToApply'] is False
assert any(issue['kind'] == 'administrator-permission-unknown' and issue['count'] == 1 for issue in unknown['issues'])
assert 'fixture-unknown-grant' not in raw
PY

"${source_sql[@]}" "UPDATE admin_passkey_credential SET adminprincipalid=8 WHERE id=2" >/dev/null
"${source_sql[@]}" "DROP TABLE user_refresh_token_tombstone" >/dev/null
check_report "$scratch/partial.json"
python3 - "$scratch/unknown.json" "$scratch/partial.json" <<'PY'
import json
import sys
from pathlib import Path

previous = json.loads(Path(sys.argv[1]).read_text())
partial = json.loads(Path(sys.argv[2]).read_text())
assert partial['sourceIdentitySha256'] != previous['sourceIdentitySha256']
assert partial['namespaceIdOverlaps'] == 1 and partial['readyToApply'] is False
issues = {issue['kind']: issue['count'] for issue in partial['issues']}
assert issues['administrator-passkey-owner-unresolved'] == 1
assert issues['identity-relation-missing'] == 1
assert 'administrator-multiple-passkeys' not in issues
assert {'name': 'user_refresh_token_tombstone', 'present': False, 'rows': 0} in partial['relations']
PY

"${source_sql[@]}" "ALTER TABLE sys_user RENAME TO renamed_source_users" >/dev/null
code=0
"${migrate[@]}" legacy identity "$provider" > "$scratch/unrecognized.json" 2> "$scratch/error" || code=$?
[[ "$code" == 1 && ! -s "$scratch/unrecognized.json" ]]
if rg -q 'fixture-|AAECAwQFBgcICQoLDA0OD' "$scratch/error"; then
    printf '%s\n' 'Unexpected source value in error output.' >&2
    exit 1
fi
printf 'Legacy identity compatibility on %s passed, with distinct principals, blocked credentials, and clean reports.\n' "$provider"
