#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EVIDENCE_FILE="${FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE:-$ROOT_DIR/.tmp/security/production-exposure-live.json}"
FIREWALL_POLICY_FILE="${FSUSBLOG_FIREWALL_POLICY_EVIDENCE:-$ROOT_DIR/.tmp/security/production-firewall-policy.json}"
DNS_READINESS_FILE="${FSUSBLOG_DNS_READINESS_EVIDENCE:-$ROOT_DIR/.tmp/security/production-dns-readiness.json}"
DNS_DELEGATION_FILE="${FSUSBLOG_DNS_DELEGATION_EVIDENCE:-$ROOT_DIR/.tmp/security/production-dns-delegation.json}"
STATUS_FILE="${FSUSBLOG_PRODUCTION_EXPOSURE_STATUS:-$ROOT_DIR/.tmp/security/production-exposure-status.json}"
DNS_READINESS_MAX_AGE_SECONDS="${FSUSBLOG_DNS_READINESS_MAX_AGE_SECONDS:-86400}"
DNS_DELEGATION_MAX_AGE_SECONDS="${FSUSBLOG_DNS_DELEGATION_MAX_AGE_SECONDS:-86400}"
MAX_FUTURE_SKEW_SECONDS="${FSUSBLOG_PRODUCTION_EXPOSURE_MAX_FUTURE_SKEW_SECONDS:-300}"

blocker_rows=()

AddBlocker() {
    local source="$1"
    local message="$2"
    blocker_rows+=("$source"$'\t'"$message")
}

CaptureVerifier() {
    local source="$1"
    shift

    local output status line sawDetail=0
    set +e
    output="$("$@" 2>&1)"
    status=$?
    set -e

    if ((status == 0)); then
        return 0
    fi

    while IFS= read -r line; do
        [[ -n "$line" ]] || continue
        [[ "$line" == \[* ]] && continue
        line="${line#- }"
        AddBlocker "$source" "$line"
        sawDetail=1
    done <<<"$output"

    if ((sawDetail == 0)); then
        AddBlocker "$source" "verifier failed without details"
    fi
    return 0
}

ExpectedDomainsFromHosts() {
    tr ' ' '\n' <<<"$1" | awk -F '.' '
    NF >= 2 { print $(NF - 1) "." $NF }
  ' | sort -u | paste -sd ' ' -
}

HasWord() {
    local needle="$1"
    shift
    local word
    for word in "$@"; do
        [[ "$word" == "$needle" ]] && return 0
    done
    return 1
}

CaptureDnsDelegationEvidence() {
    local expectedDomains="$1"
    local generatedAt generatedEpoch nowEpoch delegationDomains jqOutput domain

    if [[ ! -f "$DNS_DELEGATION_FILE" ]]; then
        AddBlocker dns-delegation "missing DNS delegation evidence file: $DNS_DELEGATION_FILE"
        return
    fi

    generatedAt="$(jq -r '.generatedAt // ""' "$DNS_DELEGATION_FILE" 2>/dev/null)" || {
        AddBlocker dns-delegation "invalid DNS delegation evidence JSON: $DNS_DELEGATION_FILE"
        return
    }

    if [[ -z "$generatedAt" ]]; then
        AddBlocker dns-delegation "DNS delegation evidence generatedAt must be present"
    elif ! generatedEpoch="$(date -u -d "$generatedAt" +%s 2>/dev/null)"; then
        AddBlocker dns-delegation "DNS delegation evidence generatedAt is not parseable: $generatedAt"
    else
        nowEpoch="$(date -u +%s)"
        if ((generatedEpoch > nowEpoch + MAX_FUTURE_SKEW_SECONDS)); then
            AddBlocker dns-delegation "DNS delegation evidence generatedAt is too far in the future: $generatedAt"
        elif ((nowEpoch - generatedEpoch > DNS_DELEGATION_MAX_AGE_SECONDS)); then
            AddBlocker dns-delegation "DNS delegation evidence is stale: generatedAt=$generatedAt maxAgeSeconds=$DNS_DELEGATION_MAX_AGE_SECONDS"
        fi
    fi

    delegationDomains="$(jq -r '
    if (.delegationDomains | type) == "array" then
      (.delegationDomains | map(tostring) | join(" "))
    else
      (.delegationDomains // "")
    end
  ' "$DNS_DELEGATION_FILE" 2>/dev/null || true)"
    if [[ -z "$delegationDomains" ]]; then
        AddBlocker dns-delegation "DNS delegation evidence delegationDomains must be non-empty"
    fi

    for domain in $expectedDomains; do
        if ! HasWord "$domain" $delegationDomains; then
            AddBlocker dns-delegation "$domain: required delegation domain is missing from DNS delegation evidence"
        fi
    done

    jqOutput="$(jq -r '
    def words($value):
      if ($value | type) == "array" then
        [$value[]? | tostring | select(length > 0)]
      else
        ($value // "" | tostring | split(" ") | map(select(length > 0)))
      end;

    words(.delegationDomains) as $domains
    | $domains[]? as $domain
    | if any(.results[]?; .domain == $domain and (.check | startswith("resolver/")) and .status == "ok") then empty
      else "\($domain): public resolvers have no NS/SOA delegation answer" end,
      if any(.results[]?; .domain == $domain and ((.check | startswith("tld/")) or .check == "tld-ns") and .status == "ok") then empty
      else "\($domain): TLD authoritative nameservers have no NS delegation answer" end
  ' "$DNS_DELEGATION_FILE" 2>/dev/null || true)"

    if [[ -n "$jqOutput" ]]; then
        while IFS= read -r line; do
            [[ -n "$line" ]] || continue
            AddBlocker dns-delegation "$line"
        done <<<"$jqOutput"
    fi
}

CaptureDnsReadinessEvidence() {
    local expectedHosts="$1"
    local generatedAt generatedEpoch nowEpoch readinessHosts jqOutput host

    if [[ ! -f "$DNS_READINESS_FILE" ]]; then
        AddBlocker dns-readiness "missing DNS readiness evidence file: $DNS_READINESS_FILE"
        return
    fi

    generatedAt="$(jq -r '.generatedAt // ""' "$DNS_READINESS_FILE" 2>/dev/null)" || {
        AddBlocker dns-readiness "invalid DNS readiness evidence JSON: $DNS_READINESS_FILE"
        return
    }

    if [[ -z "$generatedAt" ]]; then
        AddBlocker dns-readiness "DNS readiness evidence generatedAt must be present"
    elif ! generatedEpoch="$(date -u -d "$generatedAt" +%s 2>/dev/null)"; then
        AddBlocker dns-readiness "DNS readiness evidence generatedAt is not parseable: $generatedAt"
    else
        nowEpoch="$(date -u +%s)"
        if ((generatedEpoch > nowEpoch + MAX_FUTURE_SKEW_SECONDS)); then
            AddBlocker dns-readiness "DNS readiness evidence generatedAt is too far in the future: $generatedAt"
        elif ((nowEpoch - generatedEpoch > DNS_READINESS_MAX_AGE_SECONDS)); then
            AddBlocker dns-readiness "DNS readiness evidence is stale: generatedAt=$generatedAt maxAgeSeconds=$DNS_READINESS_MAX_AGE_SECONDS"
        fi
    fi

    readinessHosts="$(jq -r '
    if (.requiredHosts | type) == "array" then
      (.requiredHosts | map(tostring) | join(" "))
    else
      (.requiredHosts // "")
    end
  ' "$DNS_READINESS_FILE" 2>/dev/null || true)"
    if [[ -z "$readinessHosts" ]]; then
        AddBlocker dns-readiness "DNS readiness evidence requiredHosts must be non-empty"
    fi

    for host in $expectedHosts; do
        if ! HasWord "$host" $readinessHosts; then
            AddBlocker dns-readiness "$host: required production host is missing from DNS readiness evidence"
        fi
    done

    jqOutput="$(jq -r --arg requiredHosts "$expectedHosts" '
    def words($value):
      if ($value | type) == "array" then
        [$value[]? | tostring | select(length > 0)]
      else
        ($value // "" | tostring | split(" ") | map(select(length > 0)))
      end;
    def has_ok($host; $check):
      any(.results[]?; .host == $host and .check == $check and .status == "ok");

    (words($requiredHosts)) as $hosts
    | (words(.dnsResolvers) | if length == 0 then ["1.1.1.1", "8.8.8.8"] else . end) as $dnsResolvers
    | $hosts[]? as $host
    | if has_ok($host; "dns") then empty
      else "\($host): DNS readiness local resolver check is not ok" end,
      ($dnsResolvers[] as $resolver
        | if any(.results[]?; .host == $host and (.check == "dns/" + $resolver + "/A" or .check == "dns/" + $resolver + "/AAAA") and .status == "ok") then empty
          else "\($host): DNS readiness public resolver \($resolver) has no ok A/AAAA answer" end)
  ' "$DNS_READINESS_FILE" 2>/dev/null || true)"

    if [[ -n "$jqOutput" ]]; then
        while IFS= read -r line; do
            [[ -n "$line" ]] || continue
            AddBlocker dns-readiness "$line"
        done <<<"$jqOutput"
    fi
}

CaptureLiveRequiredHosts() {
    local expectedHosts="$1"
    local liveHosts host

    if [[ ! -f "$EVIDENCE_FILE" ]]; then
        return
    fi

    liveHosts="$(jq -r '
    if (.requiredHosts | type) == "array" then
      (.requiredHosts | map(tostring) | join(" "))
    else
      (.requiredHosts // "")
    end
  ' "$EVIDENCE_FILE" 2>/dev/null || true)"
    if [[ -z "$liveHosts" ]]; then
        AddBlocker live-evidence "live evidence requiredHosts must be non-empty"
        return
    fi

    for host in $expectedHosts; do
        if ! HasWord "$host" $liveHosts; then
            AddBlocker live-evidence "$host: required production host is missing from live evidence requiredHosts"
        fi
    done
}

required_hosts="$("$ROOT_DIR/tools/security/collect-production-hosts.sh" | paste -sd ' ' -)"
if [[ -z "$required_hosts" ]]; then
    AddBlocker hosts "no production hosts found; set FSUSBLOG_LIVE_HOSTS or production env values"
elif [[ -z "${FSUSBLOG_FIREWALL_POLICY_REQUIRED_HOSTS:-}" ]]; then
    export FSUSBLOG_FIREWALL_POLICY_REQUIRED_HOSTS="$required_hosts"
fi
delegationDomains="$(ExpectedDomainsFromHosts "$required_hosts")"

CaptureVerifier firewall-policy "$ROOT_DIR/tools/security/verify-production-firewall-policy-evidence.sh" "$FIREWALL_POLICY_FILE"
CaptureVerifier live-evidence "$ROOT_DIR/tools/security/verify-production-exposure-evidence.sh" "$EVIDENCE_FILE"
CaptureLiveRequiredHosts "$required_hosts"
CaptureDnsReadinessEvidence "$required_hosts"
CaptureDnsDelegationEvidence "$delegationDomains"

mkdir -p "$(dirname "$STATUS_FILE")"
tmp_rows="$(mktemp)"
trap 'rm -f "$tmp_rows"' EXIT
for row in "${blocker_rows[@]}"; do
    printf '%s\n' "$row" >>"$tmp_rows"
done

jq -R -s \
    --arg requiredHosts "$required_hosts" \
    --arg delegationDomains "$delegationDomains" \
    --arg firewallPolicyEvidence "$FIREWALL_POLICY_FILE" \
    --arg productionExposureEvidence "$EVIDENCE_FILE" \
    --arg dnsReadinessEvidence "$DNS_READINESS_FILE" \
    --arg dnsDelegationEvidence "$DNS_DELEGATION_FILE" '
  def words($value): ($value | split(" ") | map(select(length > 0)));

  split("\n")
  | map(select(length > 0) | split("\t") | {
      source: .[0],
      message: .[1]
    }) as $blockers
  | {
      generatedAt: (now | todateiso8601),
      status: (if ($blockers | length) == 0 then "ok" else "blocked" end),
      requiredHosts: words($requiredHosts),
      delegationDomains: words($delegationDomains),
      evidenceFiles: {
        firewallPolicy: $firewallPolicyEvidence,
        productionExposure: $productionExposureEvidence,
        dnsReadiness: $dnsReadinessEvidence,
        dnsDelegation: $dnsDelegationEvidence
      },
      blockers: $blockers
    }
' "$tmp_rows" >"$STATUS_FILE"

if ((${#blocker_rows[@]} > 0)); then
    printf '[production-exposure-status] blocked\n' >&2
    printf -- '- wrote %s\n' "$STATUS_FILE" >&2
    for row in "${blocker_rows[@]}"; do
        printf -- '- %s\n' "${row#*$'\t'}" >&2
    done
    exit 1
fi

printf '[production-exposure-status] ok\n'
printf -- '- wrote %s\n' "$STATUS_FILE"
