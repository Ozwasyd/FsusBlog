#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONNECT_TIMEOUT="${FSUSBLOG_LIVE_CONNECT_TIMEOUT:-5}"
DNS_RESOLVERS="${FSUSBLOG_DNS_RESOLVERS:-1.1.1.1 8.8.8.8}"
TLD_NS_LIMIT="${FSUSBLOG_DNS_TLD_NS_LIMIT:-8}"
EVIDENCE_FILE="${FSUSBLOG_DNS_DELEGATION_EVIDENCE:-$ROOT_DIR/.tmp/security/production-dns-delegation.json}"

failures=()
evidence_rows=()
REQUIRED_HOSTS=""
DELEGATION_DOMAINS=""

record_result() {
    local domain="$1"
    local check="$2"
    local status="$3"
    local detail="$4"
    evidence_rows+=("$domain"$'\t'"$check"$'\t'"$status"$'\t'"$detail")
}

fixture_result() {
    local domain="$1"
    local check="$2"

    [[ -n "${FSUSBLOG_DNS_DELEGATION_FIXTURE:-}" ]] || return 1
    [[ -f "$FSUSBLOG_DNS_DELEGATION_FIXTURE" ]] || return 1

    awk -F '\t' \
        -v domain="$domain" \
        -v check="$check" \
        '$1 == domain && $2 == check { print $3 "\t" $4; found = 1; exit } END { if (!found) exit 1 }' \
        "$FSUSBLOG_DNS_DELEGATION_FIXTURE"
}

domain_from_host() {
    local host="$1"
    awk -F '.' '
    NF >= 2 { print $(NF - 1) "." $NF }
  ' <<<"$host"
}

collect_domains() {
    if [[ -n "${FSUSBLOG_DNS_DELEGATION_DOMAINS:-}" ]]; then
        tr ',;' '\n' <<<"$FSUSBLOG_DNS_DELEGATION_DOMAINS"
        return
    fi

    "$ROOT_DIR/tools/security/collect-production-hosts.sh" | while read -r host; do
        [[ -n "$host" ]] || continue
        domain_from_host "$host"
    done
}

dig_answer() {
    local resolver="$1"
    local name="$2"
    local rrtype="$3"
    dig +time="$CONNECT_TIMEOUT" +tries=1 "@$resolver" "$name" "$rrtype" +noall +answer +comments 2>&1 || true
}

dns_status() {
    awk -F 'status: ' '/status:/ { sub(/,.*/, "", $2); print $2; exit }'
}

dns_answers() {
    awk 'BEGIN { ORS=";" } /^[^;]/ && NF >= 5 { print $0 }' | sed 's/;$//'
}

probe_public_resolvers() {
    local domain="$1"
    local resolver rrtype output status answers fixture_row resolver_ok

    for resolver in $DNS_RESOLVERS; do
        resolver_ok=0
        for rrtype in NS SOA; do
            local check="resolver/$resolver/$rrtype"
            if fixture_row="$(fixture_result "$domain" "$check" 2>/dev/null)"; then
                status="${fixture_row%%$'\t'*}"
                answers="${fixture_row#*$'\t'}"
                record_result "$domain" "$check" "$status" "$answers"
                [[ "$status" == "ok" ]] && resolver_ok=1
                continue
            fi

            output="$(dig_answer "$resolver" "$domain" "$rrtype")"
            status="$(dns_status <<<"$output")"
            answers="$(dns_answers <<<"$output")"
            if [[ -n "$answers" ]]; then
                record_result "$domain" "$check" ok "$answers"
                resolver_ok=1
            else
                record_result "$domain" "$check" failed "status=${status:-unknown}; no answer"
            fi
        done

        if ((resolver_ok == 0)); then
            failures+=("$domain: public DNS resolver $resolver has no NS/SOA answer")
        fi
    done
}

probe_tld_delegation() {
    local domain="$1"
    local tld="${domain##*.}"
    local resolver="${DNS_RESOLVERS%% *}"
    local tld_ns ns output status answers fixture_row delegated=0 count=0

    if fixture_row="$(fixture_result "$domain" tld-ns 2>/dev/null)"; then
        status="${fixture_row%%$'\t'*}"
        answers="${fixture_row#*$'\t'}"
        record_result "$domain" tld-ns "$status" "$answers"
        [[ "$status" == "ok" ]] || failures+=("$domain: TLD nameserver discovery failed")
        return
    fi

    mapfile -t tld_ns < <(dig +time="$CONNECT_TIMEOUT" +tries=1 "@$resolver" "$tld" NS +short 2>/dev/null | sed 's/\.$//' | sort -u | head -n "$TLD_NS_LIMIT")
    if ((${#tld_ns[@]} == 0)); then
        record_result "$domain" tld-ns failed "no TLD nameservers discovered for .$tld via $resolver"
        failures+=("$domain: no TLD nameservers discovered for .$tld")
        return
    fi

    for ns in "${tld_ns[@]}"; do
        [[ -n "$ns" ]] || continue
        count=$((count + 1))
        local check="tld/$ns/NS"
        if fixture_row="$(fixture_result "$domain" "$check" 2>/dev/null)"; then
            status="${fixture_row%%$'\t'*}"
            answers="${fixture_row#*$'\t'}"
            record_result "$domain" "$check" "$status" "$answers"
            [[ "$status" == "ok" ]] && delegated=1
            continue
        fi

        output="$(dig +time="$CONNECT_TIMEOUT" +tries=1 "@$ns" "$domain" NS +norecurse +noall +answer +comments 2>&1 || true)"
        status="$(dns_status <<<"$output")"
        answers="$(dns_answers <<<"$output")"
        if [[ -n "$answers" ]]; then
            record_result "$domain" "$check" ok "$answers"
            delegated=1
        else
            record_result "$domain" "$check" failed "status=${status:-unknown}; no delegation answer"
        fi
    done

    if ((count == 0 || delegated == 0)); then
        failures+=("$domain: TLD authoritative nameservers returned no NS delegation")
    fi
}

write_evidence() {
    mkdir -p "$(dirname "$EVIDENCE_FILE")"

    local tmp
    tmp="$(mktemp)"
    for row in "${evidence_rows[@]}"; do
        printf '%s\n' "$row" >>"$tmp"
    done

    jq -R -s \
        --arg requiredHosts "$REQUIRED_HOSTS" \
        --arg delegationDomains "$DELEGATION_DOMAINS" '
    split("\n")
    | map(select(length > 0) | split("\t") | {
        domain: .[0],
        check: .[1],
        status: .[2],
        detail: .[3]
      })
    | {
        generatedAt: (now | todateiso8601),
        requiredHosts: $requiredHosts,
        delegationDomains: $delegationDomains,
        dnsResolvers: ($ENV.FSUSBLOG_DNS_RESOLVERS // "1.1.1.1 8.8.8.8"),
        results: .
      }
  ' "$tmp" >"$EVIDENCE_FILE"
    rm -f "$tmp"
}

trap write_evidence EXIT

mapfile -t hosts < <("$ROOT_DIR/tools/security/collect-production-hosts.sh")
if ((${#hosts[@]} > 0)); then
    REQUIRED_HOSTS="$(printf '%s\n' "${hosts[@]}" | paste -sd ' ' -)"
fi

mapfile -t domains < <(collect_domains | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | awk 'NF' | sort -u)
if ((${#domains[@]} > 0)); then
    DELEGATION_DOMAINS="$(printf '%s\n' "${domains[@]}" | paste -sd ' ' -)"
fi
if ((${#domains[@]} == 0)); then
    failures+=("no production delegation domains found; set FSUSBLOG_DNS_DELEGATION_DOMAINS or production host values")
    record_result "-" domains failed "no production delegation domains found; set FSUSBLOG_DNS_DELEGATION_DOMAINS or production host values"
fi

if ! command -v dig >/dev/null 2>&1; then
    failures+=("dig is required for DNS delegation checks")
    record_result "-" dig failed "dig is required for DNS delegation checks"
else
    for domain in "${domains[@]}"; do
        probe_public_resolvers "$domain"
        probe_tld_delegation "$domain"
    done
fi

if ((${#failures[@]} > 0)); then
    printf '[production-dns-delegation] failed\n' >&2
    for failure in "${failures[@]}"; do
        printf -- '- %s\n' "$failure" >&2
    done
    exit 1
fi

printf '[production-dns-delegation] ok\n'
printf -- '- wrote %s\n' "$EVIDENCE_FILE"
