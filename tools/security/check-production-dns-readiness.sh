#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONNECT_TIMEOUT="${FSUSBLOG_LIVE_CONNECT_TIMEOUT:-5}"
DNS_RESOLVERS="${FSUSBLOG_DNS_RESOLVERS:-1.1.1.1 8.8.8.8}"
EVIDENCE_FILE="${FSUSBLOG_DNS_READINESS_EVIDENCE:-$ROOT_DIR/.tmp/security/production-dns-readiness.json}"

failures=()
evidence_rows=()
REQUIRED_HOSTS=""

RecordResult() {
    local host="$1"
    local check="$2"
    local status="$3"
    local detail="$4"
    evidence_rows+=("$host"$'\t'"$check"$'\t'"$status"$'\t'"$detail")
}

FixturePublicDns() {
    local host="$1"
    local resolver="$2"
    local rrtype="$3"

    [[ -n "${FSUSBLOG_DNS_READINESS_FIXTURE:-}" ]] || return 1
    [[ -f "$FSUSBLOG_DNS_READINESS_FIXTURE" ]] || return 1

    awk -F '\t' \
        -v host="$host" \
        -v resolver="$resolver" \
        -v rrtype="$rrtype" \
        '$1 == host && $2 == resolver && $3 == rrtype { print $4 "\t" $5; found = 1; exit } END { if (!found) exit 1 }' \
        "$FSUSBLOG_DNS_READINESS_FIXTURE"
}

FixtureLocalDns() {
    local host="$1"

    [[ -n "${FSUSBLOG_DNS_READINESS_LOCAL_FIXTURE:-}" ]] || return 1
    [[ -f "$FSUSBLOG_DNS_READINESS_LOCAL_FIXTURE" ]] || return 1

    awk -F '\t' \
        -v host="$host" \
        '$1 == host { print $2 "\t" $3; found = 1; exit } END { if (!found) exit 1 }' \
        "$FSUSBLOG_DNS_READINESS_LOCAL_FIXTURE"
}

ProbePublicDns() {
    local host="$1"
    local resolver rrtype output status answers fixtureRow

    if ! command -v dig >/dev/null 2>&1; then
        RecordResult "$host" dns/public skipped "dig is not installed"
        failures+=("$host: dig is required for public DNS readiness")
        return
    fi

    for resolver in $DNS_RESOLVERS; do
        local resolverOk=0
        for rrtype in A AAAA; do
            if fixtureRow="$(FixturePublicDns "$host" "$resolver" "$rrtype" 2>/dev/null)"; then
                status="${fixtureRow%%$'\t'*}"
                answers="${fixtureRow#*$'\t'}"
                RecordResult "$host" "dns/$resolver/$rrtype" "$status" "$answers"
                [[ "$status" == "ok" ]] && resolverOk=1
                continue
            fi

            output="$(dig +time="$CONNECT_TIMEOUT" +tries=1 "@$resolver" "$host" "$rrtype" +noall +answer +comments 2>&1 || true)"
            status="$(awk -F 'status: ' '/status:/ { sub(/,.*/, "", $2); print $2; exit }' <<<"$output")"
            answers="$(awk 'BEGIN { ORS=";" } /^[^;]/ && NF >= 5 { print $0 }' <<<"$output")"
            answers="${answers%;}"
            if [[ -n "$answers" ]]; then
                RecordResult "$host" "dns/$resolver/$rrtype" ok "$answers"
                resolverOk=1
            else
                RecordResult "$host" "dns/$resolver/$rrtype" failed "status=${status:-unknown}; no answer"
            fi
        done

        if ((resolverOk == 0)); then
            failures+=("$host: public DNS resolver $resolver has no A/AAAA answer")
        fi
    done
}

ProbeLocalDns() {
    local host="$1"
    local fixtureRow status detail resolvedAddresses

    if fixtureRow="$(FixtureLocalDns "$host" 2>/dev/null)"; then
        status="${fixtureRow%%$'\t'*}"
        detail="${fixtureRow#*$'\t'}"
        RecordResult "$host" dns "$status" "$detail"
        [[ "$status" == "ok" ]] || failures+=("$host: local resolver DNS check is not ok")
        return
    fi

    resolvedAddresses="$(getent ahosts "$host" 2>/dev/null | awk '{print $1}' | sort -u | paste -sd ',' - || true)"
    if [[ -z "$resolvedAddresses" ]]; then
        RecordResult "$host" dns failed "DNS does not resolve from this network"
        failures+=("$host: local resolver DNS check is not ok")
    else
        RecordResult "$host" dns ok "$resolvedAddresses"
    fi
}

WriteEvidence() {
    mkdir -p "$(dirname "$EVIDENCE_FILE")"

    local tmp
    tmp="$(mktemp)"
    for row in "${evidence_rows[@]}"; do
        printf '%s\n' "$row" >>"$tmp"
    done

    jq -R -s --arg requiredHosts "$REQUIRED_HOSTS" '
    split("\n")
    | map(select(length > 0) | split("\t") | {
        host: .[0],
        check: .[1],
        status: .[2],
        detail: .[3]
      })
    | {
        generatedAt: (now | todateiso8601),
        requiredHosts: $requiredHosts,
        dnsResolvers: ($ENV.FSUSBLOG_DNS_RESOLVERS // "1.1.1.1 8.8.8.8"),
        results: .
      }
  ' "$tmp" >"$EVIDENCE_FILE"
    rm -f "$tmp"
}

trap WriteEvidence EXIT

mapfile -t hosts < <("$ROOT_DIR/tools/security/collect-production-hosts.sh")
if ((${#hosts[@]} > 0)); then
    REQUIRED_HOSTS="$(printf '%s\n' "${hosts[@]}" | paste -sd ' ' -)"
fi
if ((${#hosts[@]} == 0)); then
    failures+=("no production hosts found; set FSUSBLOG_LIVE_HOSTS or production env values")
    RecordResult "-" hosts failed "no production hosts found; set FSUSBLOG_LIVE_HOSTS or production env values"
fi

for host in "${hosts[@]}"; do
    ProbePublicDns "$host"
    ProbeLocalDns "$host"
done

if ((${#failures[@]} > 0)); then
    printf '[production-dns-readiness] failed\n' >&2
    for failure in "${failures[@]}"; do
        printf -- '- %s\n' "$failure" >&2
    done
    exit 1
fi

printf '[production-dns-readiness] ok\n'
printf -- '- wrote %s\n' "$EVIDENCE_FILE"
