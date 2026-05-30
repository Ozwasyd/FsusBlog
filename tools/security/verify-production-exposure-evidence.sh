#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EVIDENCE_FILE="${1:-${FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE:-$ROOT_DIR/.tmp/security/production-exposure-live.json}}"
MAX_AGE_SECONDS="${FSUSBLOG_PRODUCTION_EXPOSURE_MAX_AGE_SECONDS:-86400}"
MAX_FUTURE_SKEW_SECONDS="${FSUSBLOG_PRODUCTION_EXPOSURE_MAX_FUTURE_SKEW_SECONDS:-300}"

failures=()

if [[ ! -f "$EVIDENCE_FILE" ]]; then
  printf '[production-exposure-evidence] failed\n' >&2
  printf -- '- missing evidence file: %s\n' "$EVIDENCE_FILE" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  printf '[production-exposure-evidence] failed\n' >&2
  printf -- '- jq is required to verify production exposure evidence\n' >&2
  exit 1
fi

generated_at="$(jq -r '.generatedAt // ""' "$EVIDENCE_FILE")" || {
  printf '[production-exposure-evidence] failed\n' >&2
  printf -- '- invalid production exposure evidence JSON: %s\n' "$EVIDENCE_FILE" >&2
  exit 1
}

if [[ -z "$generated_at" ]]; then
  printf '[production-exposure-evidence] failed\n' >&2
  printf -- '- evidence generatedAt must be present\n' >&2
  exit 1
fi

if ! generated_epoch="$(date -u -d "$generated_at" +%s 2>/dev/null)"; then
  printf '[production-exposure-evidence] failed\n' >&2
  printf -- '- evidence generatedAt is not parseable: %s\n' "$generated_at" >&2
  exit 1
fi

now_epoch="$(date -u +%s)"
if (( generated_epoch > now_epoch + MAX_FUTURE_SKEW_SECONDS )); then
  printf '[production-exposure-evidence] failed\n' >&2
  printf -- '- evidence generatedAt is too far in the future: %s\n' "$generated_at" >&2
  exit 1
fi
if (( now_epoch - generated_epoch > MAX_AGE_SECONDS )); then
  printf '[production-exposure-evidence] failed\n' >&2
  printf -- '- evidence is stale: generatedAt=%s maxAgeSeconds=%s\n' "$generated_at" "$MAX_AGE_SECONDS" >&2
  exit 1
fi

jq_output="$(jq -r '
  def words($value):
    if ($value | type) == "array" then
      [$value[]? | tostring | select(length > 0)]
    else
      ($value // "" | tostring | split(" ") | map(select(length > 0)))
    end;

  def hosts:
    [.results[]? | select(.host != null and .host != "-") | .host] | unique;

  def has_ok($host; $check):
    any(.results[]?; .host == $host and .check == $check and .status == "ok");

  (words(.requiredOpenPorts) | if length == 0 then ["80", "443"] else . end) as $requiredOpenPorts
  | (words(.forbiddenPublicPorts) | if length == 0 then ["22", "6379", "5432", "8080"] else . end) as $forbiddenPublicPorts
  | (words(.dnsResolvers) | if length == 0 then ["1.1.1.1", "8.8.8.8"] else . end) as $dnsResolvers
  | hosts as $hosts
  | words(.requiredHosts) as $requiredHosts
  | [
      if (.results | type) != "array" then
        "evidence results must be an array"
      else empty end,

      if ($requiredHosts | length) == 0 then
        "evidence requiredHosts must be a non-empty production host list"
      else empty end,

      if ($hosts | length) == 0 then
        "evidence contains no production hosts"
      else empty end,

      ($requiredHosts[]? as $host
        | if ($hosts | index($host)) then
            empty
          else
            "\($host): required production host is missing from evidence"
          end),

      ($requiredHosts[]? as $host
        | if all(.results[]?; (.host != $host) or (.target == $host)) then
            empty
          else
            "\($host): final closeout evidence must use real DNS target, not FSUSBLOG_LIVE_TARGETS override"
          end),

      ($requiredHosts[]? as $host
        | if has_ok($host; "dns") then
            empty
          else
            "\($host): local resolver DNS check is not ok"
          end),

      ($requiredHosts[]? as $host
        | $dnsResolvers[] as $resolver
        | if any(.results[]?; .host == $host and (.check == "dns/" + $resolver + "/A" or .check == "dns/" + $resolver + "/AAAA") and .status == "ok") then
            empty
          else
            "\($host): public DNS resolver \($resolver) has no ok A/AAAA answer"
          end),

      ($requiredHosts[]? as $host
        | $requiredOpenPorts[] as $port
        | if has_ok($host; "tcp/" + $port) then
            empty
          else
            "\($host): required public tcp/\($port) is not ok"
          end),

      ($requiredHosts[]? as $host
        | $forbiddenPublicPorts[] as $port
        | if has_ok($host; "tcp/" + $port) then
            empty
          else
            "\($host): forbidden public tcp/\($port) is not proven closed"
          end),

      ($requiredHosts[]? as $host
        | if has_ok($host; "https") then
            empty
          else
            "\($host): HTTPS check is not ok"
          end),

      ($requiredHosts[]? as $host
        | if has_ok($host; "hsts") then
            empty
          else
            "\($host): HSTS check is not ok"
          end)
    ]
  | .[]
' "$EVIDENCE_FILE")" || {
  printf '[production-exposure-evidence] failed\n' >&2
  printf -- '- invalid production exposure evidence JSON or verifier expression failed: %s\n' "$EVIDENCE_FILE" >&2
  exit 1
}

failures=()
if [[ -n "$jq_output" ]]; then
  mapfile -t failures <<<"$jq_output"
fi

if (( ${#failures[@]} > 0 )); then
  printf '[production-exposure-evidence] failed\n' >&2
  for failure in "${failures[@]}"; do
    printf -- '- %s\n' "$failure" >&2
  done
  exit 1
fi

printf '[production-exposure-evidence] ok\n'
