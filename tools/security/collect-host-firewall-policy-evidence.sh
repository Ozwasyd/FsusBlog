#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUTPUT_FILE="${FSUSBLOG_FIREWALL_POLICY_EVIDENCE:-$ROOT_DIR/.tmp/security/production-firewall-policy.json}"
VERIFY_SCRIPT="$ROOT_DIR/tools/security/verify-production-firewall-policy-evidence.sh"
HOSTS_SOURCE="${FSUSBLOG_FIREWALL_POLICY_REQUIRED_HOSTS:-${FSUSBLOG_LIVE_HOSTS:-}}"

Fail() {
    printf '[host-firewall-policy-collector] failed\n' >&2
    printf -- '- %s\n' "$1" >&2
    exit 1
}

if ! command -v jq >/dev/null 2>&1; then
    Fail 'jq is required to write firewall policy evidence'
fi

if [[ -z "$HOSTS_SOURCE" ]]; then
    HOSTS_SOURCE="$("$ROOT_DIR/tools/security/collect-production-hosts.sh" | paste -sd ' ' -)"
fi
HOSTS_SOURCE="$(tr ',;' '  ' <<<"$HOSTS_SOURCE" | xargs || true)"
if [[ -z "$HOSTS_SOURCE" ]]; then
    Fail 'no production hosts found; set FSUSBLOG_LIVE_HOSTS or production env values'
fi

ReadUfwStatus() {
    if [[ -n "${FSUSBLOG_UFW_STATUS_FILE:-}" ]]; then
        if [[ ! -f "$FSUSBLOG_UFW_STATUS_FILE" ]]; then
            Fail "missing FSUSBLOG_UFW_STATUS_FILE: $FSUSBLOG_UFW_STATUS_FILE"
        fi
        cat "$FSUSBLOG_UFW_STATUS_FILE"
        return
    fi

    if ! command -v ufw >/dev/null 2>&1; then
        Fail 'ufw is not installed; provide a normalized cloud/security-group export or run this on a UFW-managed production host'
    fi

    ufw status 2>&1
}

NormalizeSource() {
    local source="$1"
    case "$source" in
        "Anywhere")
            printf '0.0.0.0/0\n'
            ;;
        "Anywhere (v6)")
            printf '::/0\n'
            ;;
        *"/"*)
            printf '%s\n' "$source"
            ;;
        *.*)
            if [[ "$source" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
                printf '%s/32\n' "$source"
            else
                printf '%s\n' "$source"
            fi
            ;;
        *:*)
            printf '%s/128\n' "$source"
            ;;
        *)
            printf '%s\n' "$source"
            ;;
    esac
}

IsPrivateSource() {
    local source="$1"
    [[ "$source" =~ ^10\. ]] && return 0
    [[ "$source" =~ ^192\.168\. ]] && return 0
    [[ "$source" =~ ^172\.(1[6-9]|2[0-9]|3[0-1])\. ]] && return 0
    [[ "$source" =~ ^127\. ]] && return 0
    [[ "$source" == fd*:* || "$source" == fc*:* || "$source" == fe80:* || "$source" == ::1* ]] && return 0
    return 1
}

SourceTypeForSsh() {
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

    if IsPrivateSource "$source"; then
        printf 'private-management-network\n'
        return 0
    fi

    if [[ -n "${FSUSBLOG_FIREWALL_SSH_SOURCE_TYPE:-}" ]]; then
        printf '%s\n' "$FSUSBLOG_FIREWALL_SSH_SOURCE_TYPE"
        return 0
    fi

    return 1
}

status_output="$(ReadUfwStatus)"
if ! grep -Eqi '^Status:[[:space:]]+active' <<<"$status_output"; then
    Fail 'UFW status is not active; normalized evidence must come from an active firewall export'
fi
if [[ -n "${FSUSBLOG_UFW_STATUS_FILE:-}" ]]; then
    SOURCE_SHA256="$(sha256sum "$FSUSBLOG_UFW_STATUS_FILE" | awk '{print $1}')"
else
    SOURCE_SHA256="$(printf '%s\n' "$status_output" | sha256sum | awk '{print $1}')"
fi

rules_file="$(mktemp)"
trap 'rm -f "$rules_file"' EXIT

while IFS= read -r raw_line; do
    line="$(sed -E 's/^[[:space:]]*\[[^]]+\][[:space:]]*//' <<<"$raw_line")"
    [[ -z "$line" ]] && continue
    [[ "$line" =~ ^Status: ]] && continue
    [[ "$line" =~ ^To[[:space:]]+Action[[:space:]]+From ]] && continue
    [[ "$line" =~ ^--[[:space:]]+------[[:space:]]+---- ]] && continue

    if ! [[ "$line" =~ ^(.+)[[:space:]]+ALLOW([[:space:]]+IN)?[[:space:]]+(.+)$ ]]; then
        continue
    fi

    to_field="${BASH_REMATCH[1]}"
    while [[ "$to_field" == *[[:space:]] ]]; do
        to_field="${to_field%?}"
    done
    source_field="$(sed 's/^[[:space:]]*//;s/[[:space:]]*$//' <<<"${BASH_REMATCH[3]}")"
    [[ -n "$source_field" ]] || continue
    to_field="${to_field% (v6)}"

    if [[ "$to_field" =~ ^([0-9]+)/(tcp)$ ]]; then
        from_port="${BASH_REMATCH[1]}"
        to_port="${BASH_REMATCH[1]}"
        protocol="${BASH_REMATCH[2]}"
    elif [[ "$to_field" =~ ^([0-9]+):([0-9]+)/(tcp)$ ]]; then
        from_port="${BASH_REMATCH[1]}"
        to_port="${BASH_REMATCH[2]}"
        protocol="${BASH_REMATCH[3]}"
    elif [[ "$to_field" =~ ^([0-9]+)$ ]]; then
        from_port="${BASH_REMATCH[1]}"
        to_port="${BASH_REMATCH[1]}"
        protocol="tcp"
    else
        continue
    fi

    source="$(NormalizeSource "$source_field")"
    source_type=""
    if [[ "$from_port" == "22" && "$to_port" == "22" ]]; then
        if ! source_type="$(SourceTypeForSsh "$source")"; then
            Fail "cannot infer sourceType for SSH source $source; set FSUSBLOG_FIREWALL_SSH_SOURCE_TYPE or FSUSBLOG_FIREWALL_SSH_SOURCE_TYPES"
        fi
    fi

    if [[ -n "$source_type" ]]; then
        jq -c -n \
            --arg protocol "$protocol" \
            --arg source "$source" \
            --arg sourceType "$source_type" \
            --argjson fromPort "$from_port" \
            --argjson toPort "$to_port" \
            '{protocol: $protocol, fromPort: $fromPort, toPort: $toPort, source: $source, sourceType: $sourceType, action: "allow", purpose: (if $fromPort == 22 then "ssh-management" elif $fromPort == 80 then "http" elif $fromPort == 443 then "https" else "host-firewall" end)}' >>"$rules_file"
    else
        jq -c -n \
            --arg protocol "$protocol" \
            --arg source "$source" \
            --argjson fromPort "$from_port" \
            --argjson toPort "$to_port" \
            '{protocol: $protocol, fromPort: $fromPort, toPort: $toPort, source: $source, action: "allow", purpose: (if $fromPort == 80 then "http" elif $fromPort == 443 then "https" else "host-firewall" end)}' >>"$rules_file"
    fi
done <<<"$status_output"

if [[ ! -s "$rules_file" ]]; then
    Fail 'no supported UFW allow rules were found; expected explicit tcp/80 and tcp/443 rules'
fi

mkdir -p "$(dirname "$OUTPUT_FILE")"
jq -n \
    --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg appliesToHosts "$HOSTS_SOURCE" \
    --arg sourceSha256 "$SOURCE_SHA256" \
    --slurpfile rules "$rules_file" \
    '{
    generatedAt: $generatedAt,
    appliesToHosts: ($appliesToHosts | split(" ") | map(select(length > 0))),
    evidenceSource: {
      kind: "ufw-status",
      command: "ufw status",
      statusFile: ($ENV.FSUSBLOG_UFW_STATUS_FILE // ""),
      sourceSha256: $sourceSha256
    },
    ingressRules: $rules
  }' >"$OUTPUT_FILE"

FSUSBLOG_FIREWALL_POLICY_REQUIRED_HOSTS="$HOSTS_SOURCE" "$VERIFY_SCRIPT" "$OUTPUT_FILE"
printf '[host-firewall-policy-collector] ok\n'
printf -- '- wrote %s\n' "$OUTPUT_FILE"
