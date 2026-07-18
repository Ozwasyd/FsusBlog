#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${FSUSBLOG_PRODUCTION_ENV_FILE:-$ROOT_DIR/.env.production}"
ENV_TEMPLATE="$ROOT_DIR/.env.production.example"
CONNECT_TIMEOUT="${FSUSBLOG_LIVE_CONNECT_TIMEOUT:-5}"
REQUIRED_OPEN_PORTS="${FSUSBLOG_REQUIRED_PUBLIC_PORTS:-80 443}"
FORBIDDEN_PUBLIC_PORTS="${FSUSBLOG_FORBIDDEN_PUBLIC_PORTS:-22 6379 5432 8080}"
DNS_RESOLVERS="${FSUSBLOG_DNS_RESOLVERS:-1.1.1.1 8.8.8.8}"
EVIDENCE_FILE="${FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE:-}"
REQUIRED_HOSTS=""

failures=()
notes=()
evidence_rows=()

target_for_host() {
  local host="$1"
  if [[ -z "${FSUSBLOG_LIVE_TARGETS:-}" ]]; then
    printf '%s\n' "$host"
    return
  fi

  tr ',;' '\n' <<<"$FSUSBLOG_LIVE_TARGETS" | while IFS='=' read -r target_host target_addr; do
    target_host="$(sed 's/^[[:space:]]*//;s/[[:space:]]*$//' <<<"${target_host:-}")"
    target_addr="$(sed 's/^[[:space:]]*//;s/[[:space:]]*$//' <<<"${target_addr:-}")"
    if [[ "$target_host" == "$host" && -n "$target_addr" ]]; then
      printf '%s\n' "$target_addr"
      return
    fi
  done | head -n 1
}

record_result() {
  local host="$1"
  local target="$2"
  local check="$3"
  local status="$4"
  local detail="$5"
  evidence_rows+=("$host"$'\t'"$target"$'\t'"$check"$'\t'"$status"$'\t'"$detail")
}

resolve_host() {
  local host="$1"
  getent ahosts "$host" 2>/dev/null | awk '{print $1}' | sort -u | paste -sd ',' - || true
}

probe_public_dns() {
  local host="$1"
  local target="$2"

  if ! command -v dig >/dev/null 2>&1; then
    record_result "$host" "$target" dns/public skipped "dig is not installed"
    return
  fi

  local resolver rrtype output status answers
  for resolver in $DNS_RESOLVERS; do
    for rrtype in A AAAA; do
      output="$(dig +time="$CONNECT_TIMEOUT" +tries=1 "@$resolver" "$host" "$rrtype" +noall +answer +comments 2>&1 || true)"
      status="$(awk -F 'status: ' '/status:/ { sub(/,.*/, "", $2); print $2; exit }' <<<"$output")"
      answers="$(awk 'BEGIN { ORS=";" } /^[^;]/ && NF >= 5 { print $0 }' <<<"$output")"
      answers="${answers%;}"
      if [[ -n "$answers" ]]; then
        record_result "$host" "$target" "dns/$resolver/$rrtype" ok "$answers"
      else
        record_result "$host" "$target" "dns/$resolver/$rrtype" failed "status=${status:-unknown}; no answer"
      fi
    done
  done
}

tcp_probe() {
  local target="$1"
  local port="$2"
  timeout "$CONNECT_TIMEOUT" bash -c "</dev/tcp/$target/$port" >/dev/null 2>&1
}

check_https() {
  local host="$1"
  local target="$2"
  local headers
  local -a curl_args=(
    -I
    --connect-timeout "$CONNECT_TIMEOUT"
    --max-time "$((CONNECT_TIMEOUT * 2))"
    -sS
  )
  if [[ "$target" != "$host" ]]; then
    curl_args+=(--connect-to "$host:443:$target:443")
  fi

  if ! headers="$(curl "${curl_args[@]}" "https://$host/" 2>&1)"; then
    failures+=("$host: HTTPS request failed: $headers")
    record_result "$host" "$target" https failed "$headers"
    return
  fi

  if ! grep -Eqi '^HTTP/[0-9.]+[[:space:]]+[123][0-9]{2}' <<<"$headers"; then
    failures+=("$host: HTTPS did not return 1xx/2xx/3xx status")
    record_result "$host" "$target" https failed "HTTPS did not return 1xx/2xx/3xx status"
  else
    local status_line
    status_line="$(grep -Ei '^HTTP/[0-9.]+[[:space:]]+[0-9]{3}' <<<"$headers" | tail -n 1)"
    record_result "$host" "$target" https ok "$status_line"
  fi

  if ! grep -Eqi '^strict-transport-security:' <<<"$headers"; then
    failures+=("$host: missing Strict-Transport-Security header")
    record_result "$host" "$target" hsts failed "missing Strict-Transport-Security header"
    return
  fi

  local hsts
  hsts="$(grep -Ei '^strict-transport-security:' <<<"$headers" | head -n 1)"
  record_result "$host" "$target" hsts ok "$hsts"
  if grep -Eqi 'includeSubDomains' <<<"$hsts"; then
    notes+=("$host: HSTS already includes includeSubDomains")
  else
    notes+=("$host: HSTS present without includeSubDomains; eligible for later preload review only after every production subdomain is HTTPS-clean")
  fi
}

write_evidence() {
  [[ -n "$EVIDENCE_FILE" ]] || return 0
  mkdir -p "$(dirname "$EVIDENCE_FILE")"

  local tmp
  tmp="$(mktemp)"
  for row in "${evidence_rows[@]}"; do
    printf '%s\n' "$row" >>"$tmp"
  done

  if command -v jq >/dev/null 2>&1; then
    jq -R -s --arg requiredHosts "$REQUIRED_HOSTS" '
      split("\n")
      | map(select(length > 0) | split("\t") | {
          host: .[0],
          target: .[1],
          check: .[2],
          status: .[3],
          detail: .[4]
        })
      | {
          generatedAt: (now | todateiso8601),
          requiredHosts: $requiredHosts,
          requiredOpenPorts: ($ENV.FSUSBLOG_REQUIRED_PUBLIC_PORTS // "80 443"),
          forbiddenPublicPorts: ($ENV.FSUSBLOG_FORBIDDEN_PUBLIC_PORTS // "22 6379 5432 8080"),
          dnsResolvers: ($ENV.FSUSBLOG_DNS_RESOLVERS // "1.1.1.1 8.8.8.8"),
          results: .
        }
    ' "$tmp" >"$EVIDENCE_FILE"
  else
    cp "$tmp" "$EVIDENCE_FILE"
  fi
  rm -f "$tmp"
}

trap write_evidence EXIT

mapfile -t hosts < <("$ROOT_DIR/tools/security/collect-production-hosts.sh")
if (( ${#hosts[@]} > 0 )); then
  REQUIRED_HOSTS="$(printf '%s\n' "${hosts[@]}" | paste -sd ' ' -)"
fi
if (( ${#hosts[@]} == 0 )); then
  failures+=("no production hosts found; set FSUSBLOG_LIVE_HOSTS or production env values")
  record_result "-" "-" hosts failed "no production hosts found; set FSUSBLOG_LIVE_HOSTS or production env values"
fi

for host in "${hosts[@]}"; do
  target="$(target_for_host "$host")"
  target="${target:-$host}"

  probe_public_dns "$host" "$target"

  resolved_addresses="$(resolve_host "$host")"
  if [[ -z "$resolved_addresses" ]]; then
    failures+=("$host: DNS does not resolve from this network")
    record_result "$host" "$target" dns failed "DNS does not resolve from this network"
    if [[ "$target" == "$host" ]]; then
      continue
    fi
  else
    record_result "$host" "$target" dns ok "$resolved_addresses"
  fi

  for port in $REQUIRED_OPEN_PORTS; do
    if ! tcp_probe "$target" "$port"; then
      failures+=("$host: required public port $port is not reachable")
      record_result "$host" "$target" "tcp/$port" failed "required public port $port is not reachable"
    else
      record_result "$host" "$target" "tcp/$port" ok "required public port $port is reachable"
    fi
  done

  for port in $FORBIDDEN_PUBLIC_PORTS; do
    if tcp_probe "$target" "$port"; then
      failures+=("$host: forbidden public port $port is reachable")
      record_result "$host" "$target" "tcp/$port" failed "forbidden public port $port is reachable"
    else
      record_result "$host" "$target" "tcp/$port" ok "forbidden public port $port is not reachable"
    fi
  done

  check_https "$host" "$target"
done

if (( ${#failures[@]} > 0 )); then
  printf '[production-exposure-live] failed\n' >&2
  for failure in "${failures[@]}"; do
    printf -- '- %s\n' "$failure" >&2
  done
  exit 1
fi

printf '[production-exposure-live] ok\n'
for note in "${notes[@]}"; do
  printf -- '- %s\n' "$note"
done
