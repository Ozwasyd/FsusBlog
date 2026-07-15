#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

mkdir -p "$TMP_ROOT"/{backup,wal,log,etl,bin,evidence}
printf 'legacy backup payload\n' > "$TMP_ROOT/backup/pre-cutover.dump"
printf 'WAL archive fixture\n' > "$TMP_ROOT/wal/000000010000000000000001"
printf '{"clientIp":"203.0.113.42"}\n' > "$TMP_ROOT/log/legacy.jsonl"
printf 'client_ip,route\n2001:db8::42,/article\n' > "$TMP_ROOT/etl/legacy.csv"

cat > "$TMP_ROOT/inventory.json" <<JSON
{
  "schema": "fsusblog.ip-anonymization-inventory.v1",
  "inventoryId": "fixture-20260715",
  "cutoverAtUtc": "2025-01-01T00:00:00.000Z",
  "coverage": {
    "backup":{"complete":true,"scannedAtUtc":"2026-07-15T00:00:00.000Z"},
    "wal":{"complete":true,"scannedAtUtc":"2026-07-15T00:00:00.000Z"},
    "log":{"complete":true,"scannedAtUtc":"2026-07-15T00:00:00.000Z"},
    "etl":{"complete":true,"scannedAtUtc":"2026-07-15T00:00:00.000Z"}
  },
  "artifacts": [
    {"id":"backup-old","media":"backup","storage":"local","path":"backup/pre-cutover.dump","capturedAtUtc":"2024-01-01T00:00:00.000Z","rawIpState":"present"},
    {"id":"wal-old","media":"wal","storage":"local","path":"wal/000000010000000000000001","capturedAtUtc":"2024-01-01T00:00:00.000Z","rawIpState":"present"},
    {"id":"log-old","media":"log","storage":"local","path":"log/legacy.jsonl","capturedAtUtc":"2024-01-01T00:00:00.000Z","rawIpState":"present"},
    {"id":"etl-old","media":"etl","storage":"local","path":"etl/legacy.csv","capturedAtUtc":"2024-01-01T00:00:00.000Z","rawIpState":"present"},
    {"id":"s3-etl-old","media":"etl","storage":"s3","uri":"s3://fixture-warehouse/private/visit/legacy.parquet","capturedAtUtc":"2024-01-01T00:00:00.000Z","rawIpState":"present"}
  ]
}
JSON

cat > "$TMP_ROOT/config.json" <<JSON
{
  "schema": "fsusblog.ip-anonymization-lifecycle.v1",
  "inventory": "inventory.json",
  "auditLog": "evidence/dsr-audit.jsonl",
  "inventoryMaxAgeHours": 24,
  "retention": {"backupDays":90,"walDays":30,"logDays":30,"etlDays":7,"redisGraceHours":1},
  "roots": {"backup":["backup"],"wal":["wal"],"log":["log"],"etl":["etl"]},
  "s3Prefixes": {"etl":["s3://fixture-warehouse/private"]},
  "redis": {"required":true,"urlEnv":"FIXTURE_REDIS_URL","legacyPrefixes":["fsus:legacy:raw-ip:"]},
  "postgres": {"required":true,"connectionEnv":"FIXTURE_DATABASE_URL"}
}
JSON

cat > "$TMP_ROOT/bin/redis-cli" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *" --scan "* ]]; then
  if [[ -e "${FIXTURE_REDIS_STATE:?}" ]]; then
    printf 'fsus:legacy:raw-ip:fixture\n'
  fi
elif [[ " $* " == *" UNLINK "* ]]; then
  rm -f "${FIXTURE_REDIS_STATE:?}"
  printf '1\n'
else
  exit 2
fi
SH
cat > "$TMP_ROOT/bin/psql" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *"information_schema.tables"* ]]; then
  printf '0\n'
elif [[ " $* " == *"SELECT pg_switch_wal();"* ]]; then
  printf '0/2000000\n'
else
  exit 2
fi
SH
chmod +x "$TMP_ROOT/bin/redis-cli" "$TMP_ROOT/bin/psql"

cat > "$TMP_ROOT/bin/aws" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *" s3api head-object "* ]]; then
  if [[ -e "${FIXTURE_S3_STATE:?}" ]]; then
    printf '{}\n'
  else
    echo 'An error occurred (404) when calling the HeadObject operation: Not Found' >&2
    exit 254
  fi
elif [[ " $* " == *" s3api delete-object "* ]]; then
  rm -f "${FIXTURE_S3_STATE:?}"
  printf '{}\n'
else
  exit 2
fi
SH
chmod +x "$TMP_ROOT/bin/aws"

export FIXTURE_REDIS_URL='redis://fixture.invalid/0'
export FIXTURE_DATABASE_URL='postgresql://fixture.invalid/fsusblog'
export FSUSBLOG_IP_ANONYMIZATION_ALLOW_TEST_CLOCK=1
export FIXTURE_REDIS_STATE="$TMP_ROOT/redis-has-legacy-key"
touch "$FIXTURE_REDIS_STATE"
export FSUSBLOG_REDIS_CLI_BIN="$TMP_ROOT/bin/redis-cli"
export FSUSBLOG_PSQL_BIN="$TMP_ROOT/bin/psql"
export FSUSBLOG_AWS_BIN="$TMP_ROOT/bin/aws"
export FIXTURE_S3_STATE="$TMP_ROOT/s3-has-legacy-object"
touch "$FIXTURE_S3_STATE"
printf 'fixture-request-42\n' > "$TMP_ROOT/request-42.ref"
printf 'fixture-request-43\n' > "$TMP_ROOT/request-43.ref"
printf 'fixture-dpo\n' > "$TMP_ROOT/actor.ref"
chmod 600 "$TMP_ROOT/request-42.ref" "$TMP_ROOT/request-43.ref" "$TMP_ROOT/actor.ref"

if node "$ROOT_DIR/tools/operations/ip-anonymization-lifecycle.mjs" verify \
  --config "$TMP_ROOT/config.json" \
  --output "$TMP_ROOT/evidence/before-verify.json" \
  --now '2026-07-15T00:00:00.000Z'; then
  echo '[ip-anonymization-fixture] verification accepted historical raw IP' >&2
  exit 1
fi

jq -e '
  .status == "fail"
  and (.violations | index("log-old:content-scan-raw-ip-found") != null)
  and (.violations | index("etl-old:content-scan-raw-ip-found") != null)
' "$TMP_ROOT/evidence/before-verify.json" >/dev/null

node "$ROOT_DIR/tools/operations/ip-anonymization-lifecycle.mjs" dsr-delete \
  --config "$TMP_ROOT/config.json" \
  --output "$TMP_ROOT/evidence/delete.json" \
  --request-ref-file "$TMP_ROOT/request-42.ref" \
  --actor-ref-file "$TMP_ROOT/actor.ref" \
  --now '2026-07-15T00:00:00.000Z' \
  --allow-live-mutation

jq -e '
  .status == "pass"
  and .dataSubjectRequest.accountLinkageUsed == false
  and .redis.deletedKeys == 1
  and .postgres.walSwitched == true
  and ([.media[].action] | all(. == "deleted"))
' "$TMP_ROOT/evidence/delete.json" >/dev/null

find "$TMP_ROOT/backup" "$TMP_ROOT/wal" "$TMP_ROOT/log" "$TMP_ROOT/etl" -type f -print -quit | grep -q . && {
  echo '[ip-anonymization-fixture] historical raw-IP artifact survived propagation' >&2
  exit 1
}

node "$ROOT_DIR/tools/operations/ip-anonymization-lifecycle.mjs" apply \
  --config "$TMP_ROOT/config.json" \
  --output "$TMP_ROOT/evidence/apply-idempotent.json" \
  --actor-ref-file "$TMP_ROOT/actor.ref" \
  --now '2026-07-15T00:00:30.000Z' \
  --allow-live-mutation

jq -e '
  .status == "pass"
  and ([.media[].action] | all(. == "already-absent"))
  and .redis.remainingKeys == 0
  and .postgres.walSwitched == true
' "$TMP_ROOT/evidence/apply-idempotent.json" >/dev/null

node "$ROOT_DIR/tools/operations/ip-anonymization-lifecycle.mjs" dsr-export \
  --config "$TMP_ROOT/config.json" \
  --output "$TMP_ROOT/evidence/export.json" \
  --request-ref-file "$TMP_ROOT/request-43.ref" \
  --actor-ref-file "$TMP_ROOT/actor.ref" \
  --now '2026-07-15T00:01:00.000Z'

jq -e '
  .status == "pass"
  and .dataSubjectRequest.result == "not-individually-addressable"
  and .dataSubjectRequest.exportedRows == 0
  and .dataSubjectRequest.exportedRawIpValues == 0
' "$TMP_ROOT/evidence/export.json" >/dev/null

jq -s -e '
  length == 3
  and all(.accountLinkageUsed == false)
  and (map(select(.schema == "fsusblog.data-subject-right-audit.v1")) | length == 2)
  and (map(select(.schema == "fsusblog.ip-anonymization-operation-audit.v1")) | length == 1)
  and all(select(.requestRefHash != null) | .requestRefHash | startswith("sha256:"))
  and all(has("requestRef") | not)
' "$TMP_ROOT/evidence/dsr-audit.jsonl" >/dev/null

echo '[ip-anonymization-fixture] ok'
