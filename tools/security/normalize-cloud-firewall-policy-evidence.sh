#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE_FILE="${1:-${FSUSBLOG_CLOUD_FIREWALL_SOURCE:-}}"
OUTPUT_FILE="${FSUSBLOG_FIREWALL_POLICY_EVIDENCE:-$ROOT_DIR/.tmp/security/production-firewall-policy.json}"
VERIFY_SCRIPT="$ROOT_DIR/tools/security/verify-production-firewall-policy-evidence.sh"
FORMAT="${FSUSBLOG_CLOUD_FIREWALL_FORMAT:-auto}"
HOSTS_SOURCE="${FSUSBLOG_FIREWALL_POLICY_REQUIRED_HOSTS:-${FSUSBLOG_LIVE_HOSTS:-}}"

fail() {
  printf '[cloud-firewall-policy-normalizer] failed\n' >&2
  printf -- '- %s\n' "$1" >&2
  exit 1
}

if [[ -z "$SOURCE_FILE" ]]; then
  fail 'missing source file; pass a cloud firewall export path or set FSUSBLOG_CLOUD_FIREWALL_SOURCE'
fi
if [[ ! -f "$SOURCE_FILE" ]]; then
  fail "missing source file: $SOURCE_FILE"
fi
if ! command -v jq >/dev/null 2>&1; then
  fail 'jq is required to normalize cloud firewall evidence'
fi
if ! jq empty "$SOURCE_FILE" >/dev/null 2>&1; then
  fail "source file is not valid JSON: $SOURCE_FILE"
fi

if [[ -z "$HOSTS_SOURCE" ]]; then
  HOSTS_SOURCE="$("$ROOT_DIR/tools/security/collect-production-hosts.sh" | paste -sd ' ' -)"
fi
HOSTS_SOURCE="$(tr ',;' '  ' <<<"$HOSTS_SOURCE" | xargs || true)"
if [[ -z "$HOSTS_SOURCE" ]]; then
  fail 'no production hosts found; set FSUSBLOG_LIVE_HOSTS or production env values'
fi
SOURCE_SHA256="$(sha256sum "$SOURCE_FILE" | awk '{print $1}')"

if [[ "$FORMAT" == "auto" ]]; then
  if jq -e '(.SecurityGroups | type) == "array"' "$SOURCE_FILE" >/dev/null 2>&1; then
    FORMAT="aws-security-groups"
  else
    fail 'could not auto-detect cloud firewall export format; set FSUSBLOG_CLOUD_FIREWALL_FORMAT=aws-security-groups'
  fi
fi

normalize_source() {
  local source="$1"
  case "$source" in
    "0.0.0.0/0"|"::/0")
      printf '%s\n' "$source"
      ;;
    *)
      printf '%s\n' "$source"
      ;;
  esac
}

is_private_source() {
  local source="$1"
  [[ "$source" =~ ^10\. ]] && return 0
  [[ "$source" =~ ^192\.168\. ]] && return 0
  [[ "$source" =~ ^172\.(1[6-9]|2[0-9]|3[0-1])\. ]] && return 0
  [[ "$source" =~ ^127\. ]] && return 0
  [[ "$source" == fd*:* || "$source" == fc*:* || "$source" == fe80:* || "$source" == ::1* ]] && return 0
  return 1
}

covers_ssh() {
  local protocol="$1"
  local from_port="$2"
  local to_port="$3"

  [[ "$protocol" == "-1" || "$protocol" == "all" || "$protocol" == "*" ]] && return 0
  [[ "$protocol" != "tcp" ]] && return 1
  [[ -z "$from_port" && -z "$to_port" ]] && return 1

  local low="${from_port:-22}"
  local high="${to_port:-$low}"
  (( low <= 22 && high >= 22 ))
}

source_type_for_ssh() {
  local source="$1"

  if [[ -n "${FSUSBLOG_FIREWALL_SSH_SOURCE_TYPES:-}" ]]; then
    local key value
    while IFS='=' read -r key value; do
      key="$(sed 's/^[[:space:]]*//;s/[[:space:]]*$//' <<<"${key:-}")"
      value="$(sed 's/^[[:space:]]*//;s/[[:space:]]*$//' <<<"${value:-}")"
      if [[ "$key" == "$source" && -n "$value" ]]; then
        printf '%s\n' "$value"
        return 0
      fi
    done < <(tr ',;' '\n' <<<"$FSUSBLOG_FIREWALL_SSH_SOURCE_TYPES")
  fi

  if is_private_source "$source"; then
    printf 'private-management-network\n'
    return 0
  fi

  if [[ -n "${FSUSBLOG_FIREWALL_SSH_SOURCE_TYPE:-}" ]]; then
    printf '%s\n' "$FSUSBLOG_FIREWALL_SSH_SOURCE_TYPE"
    return 0
  fi

  return 1
}

rules_file="$(mktemp)"
trap 'rm -f "$rules_file"' EXIT

case "$FORMAT" in
  aws-security-groups)
    while IFS=$'\t' read -r protocol from_port to_port source; do
      [[ -n "${protocol:-}" && -n "${source:-}" ]] || continue
      source="$(normalize_source "$source")"
      source_type=""
      if covers_ssh "$protocol" "${from_port:-}" "${to_port:-}"; then
        if ! source_type="$(source_type_for_ssh "$source")"; then
          fail "cannot infer sourceType for SSH source $source; set FSUSBLOG_FIREWALL_SSH_SOURCE_TYPE or FSUSBLOG_FIREWALL_SSH_SOURCE_TYPES"
        fi
      fi

      jq -c -n \
        --arg protocol "$protocol" \
        --arg fromPort "${from_port:-}" \
        --arg toPort "${to_port:-}" \
        --arg source "$source" \
        --arg sourceType "$source_type" \
        '
          def number_or_null($value):
            if $value == "" or $value == "null" then null else ($value | tonumber) end;
          number_or_null($fromPort) as $from
          | number_or_null($toPort) as $to
          | {
              protocol: $protocol,
              source: $source,
              action: "allow",
              purpose:
                (if $from == 80 and $to == 80 then "http"
                 elif $from == 443 and $to == 443 then "https"
                 elif $from == 22 and $to == 22 then "ssh-management"
                 else "cloud-firewall"
                 end)
            }
            | if $from != null then . + {fromPort: $from} else . end
            | if $to != null then . + {toPort: $to} else . end
            | if $sourceType != "" then . + {sourceType: $sourceType} else . end
        ' >>"$rules_file"
    done < <(
      jq -r '
        .SecurityGroups[]?.IpPermissions[]? as $permission
        | (
            [$permission.IpRanges[]?.CidrIp]
            + [$permission.Ipv6Ranges[]?.CidrIpv6]
          )[]?
        | [
            ($permission.IpProtocol // ""),
            ($permission.FromPort // ""),
            ($permission.ToPort // ""),
            .
          ]
        | @tsv
      ' "$SOURCE_FILE"
    )
    ;;
  *)
    fail "unsupported cloud firewall export format: $FORMAT"
    ;;
esac

if [[ ! -s "$rules_file" ]]; then
  fail "no ingress CIDR rules were found in $SOURCE_FILE"
fi

mkdir -p "$(dirname "$OUTPUT_FILE")"
jq -n \
  --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg appliesToHosts "$HOSTS_SOURCE" \
  --arg sourceFile "$SOURCE_FILE" \
  --arg sourceSha256 "$SOURCE_SHA256" \
  --arg format "$FORMAT" \
  --slurpfile rules "$rules_file" \
  '{
    generatedAt: $generatedAt,
    appliesToHosts: ($appliesToHosts | split(" ") | map(select(length > 0))),
    evidenceSource: {
      kind: $format,
      sourceFile: $sourceFile,
      sourceSha256: $sourceSha256
    },
    ingressRules: $rules
  }' >"$OUTPUT_FILE"

FSUSBLOG_FIREWALL_POLICY_REQUIRED_HOSTS="$HOSTS_SOURCE" "$VERIFY_SCRIPT" "$OUTPUT_FILE"
printf '[cloud-firewall-policy-normalizer] ok\n'
printf -- '- wrote %s\n' "$OUTPUT_FILE"
