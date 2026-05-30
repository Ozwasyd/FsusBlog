#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
POLICY_FILE="${1:-${FSUSBLOG_FIREWALL_POLICY_EVIDENCE:-$ROOT_DIR/.tmp/security/production-firewall-policy.json}}"
REQUIRED_HOSTS_SOURCE="${FSUSBLOG_FIREWALL_POLICY_REQUIRED_HOSTS:-${FSUSBLOG_LIVE_HOSTS:-}}"
REQUIRED_HOSTS="$(tr ',;' '  ' <<<"$REQUIRED_HOSTS_SOURCE" | xargs || true)"
MAX_AGE_SECONDS="${FSUSBLOG_FIREWALL_POLICY_MAX_AGE_SECONDS:-86400}"
MAX_FUTURE_SKEW_SECONDS="${FSUSBLOG_FIREWALL_POLICY_MAX_FUTURE_SKEW_SECONDS:-300}"

if [[ ! -f "$POLICY_FILE" ]]; then
  printf '[production-firewall-policy] failed\n' >&2
  printf -- '- missing firewall policy evidence file: %s\n' "$POLICY_FILE" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  printf '[production-firewall-policy] failed\n' >&2
  printf -- '- jq is required to verify firewall policy evidence\n' >&2
  exit 1
fi

generated_at="$(jq -r '.generatedAt // ""' "$POLICY_FILE")" || {
  printf '[production-firewall-policy] failed\n' >&2
  printf -- '- invalid firewall policy evidence JSON: %s\n' "$POLICY_FILE" >&2
  exit 1
}

if [[ -z "$generated_at" ]]; then
  printf '[production-firewall-policy] failed\n' >&2
  printf -- '- firewall policy generatedAt must be present\n' >&2
  exit 1
fi

source_sha256="$(jq -r '.evidenceSource.sourceSha256 // ""' "$POLICY_FILE")"
if ! [[ "$source_sha256" =~ ^[0-9a-f]{64}$ ]]; then
  printf '[production-firewall-policy] failed\n' >&2
  printf -- '- firewall policy evidenceSource.sourceSha256 must be a sha256 digest of the raw firewall export\n' >&2
  exit 1
fi

source_file="$(jq -r '.evidenceSource.sourceFile // .evidenceSource.statusFile // ""' "$POLICY_FILE")"
if [[ -n "$source_file" && -f "$source_file" ]]; then
  actual_source_sha256="$(sha256sum "$source_file" | awk '{print $1}')"
  if [[ "$source_sha256" != "$actual_source_sha256" ]]; then
    printf '[production-firewall-policy] failed\n' >&2
    printf -- '- firewall policy evidenceSource.sourceSha256 does not match raw source file: %s\n' "$source_file" >&2
    exit 1
  fi
fi

if ! generated_epoch="$(date -u -d "$generated_at" +%s 2>/dev/null)"; then
  printf '[production-firewall-policy] failed\n' >&2
  printf -- '- firewall policy generatedAt is not parseable: %s\n' "$generated_at" >&2
  exit 1
fi

now_epoch="$(date -u +%s)"
if (( generated_epoch > now_epoch + MAX_FUTURE_SKEW_SECONDS )); then
  printf '[production-firewall-policy] failed\n' >&2
  printf -- '- firewall policy generatedAt is too far in the future: %s\n' "$generated_at" >&2
  exit 1
fi
if (( now_epoch - generated_epoch > MAX_AGE_SECONDS )); then
  printf '[production-firewall-policy] failed\n' >&2
  printf -- '- firewall policy evidence is stale: generatedAt=%s maxAgeSeconds=%s\n' "$generated_at" "$MAX_AGE_SECONDS" >&2
  exit 1
fi

jq_output="$(jq -r --arg requiredHosts "$REQUIRED_HOSTS" '
  def words($value):
    ($value // "" | tostring | split(" ") | map(select(length > 0)));

  def rules:
    (.ingressRules // []);

  def applies_to_hosts:
    if (.appliesToHosts | type) == "array" then
      [.appliesToHosts[]? | tostring | select(length > 0)]
    else
      words(.appliesToHosts)
    end;

  def evidence_source_kind:
    (.evidenceSource.kind // "" | tostring);

  def valid_evidence_source_kind:
    (evidence_source_kind == "ufw-status" or evidence_source_kind == "aws-security-groups");

  def is_allow:
    ((.action // "allow") | tostring | ascii_downcase) == "allow";

  def protocol:
    ((.protocol // "tcp") | tostring | ascii_downcase);

  def is_tcp:
    (protocol == "tcp" or protocol == "-1" or protocol == "all" or protocol == "*");

  def number_or_null($value):
    try ($value | tonumber) catch null;

  def lower_port:
    if has("port") then
      number_or_null(.port)
    elif has("fromPort") then
      number_or_null(.fromPort)
    else
      null
    end;

  def upper_port:
    if has("port") then
      number_or_null(.port)
    elif has("toPort") then
      number_or_null(.toPort)
    elif has("fromPort") then
      number_or_null(.fromPort)
    else
      null
    end;

  def port_string:
    if has("port") then
      (.port | tostring)
    elif has("fromPort") or has("toPort") then
      "\(.fromPort // "")-\(.toPort // .fromPort // "")"
    elif (protocol == "-1" or protocol == "all" or protocol == "*") then
      "all"
    else
      "unknown"
    end;

  def covers_port($port):
    if (protocol == "-1" or protocol == "all" or protocol == "*") then
      true
    else
      lower_port as $low
      | upper_port as $high
      | if ($low == null and $high == null) then
          false
        else
          (($low // $port) <= $port and ($high // $port) >= $port)
        end
    end;

  def is_public_web_port_only:
    (lower_port as $low
      | upper_port as $high
      | ($low == $high and ($low == 80 or $low == 443)));

  def is_ssh_port_only:
    (lower_port as $low
      | upper_port as $high
      | ($low == $high and $low == 22));

  def source_strings:
    [
      (.source? // empty),
      (.cidr? // empty),
      (.cidrIp? // empty),
      (.cidrIpv6? // empty),
      (.cidrBlock? // empty),
      (.sources[]? // empty),
      (.cidrs[]? // empty),
      (.cidrBlocks[]? // empty),
      (.ipv6CidrBlocks[]? // empty)
    ] | map(tostring) | map(select(length > 0));

  def cidr_string:
    source_strings | join(", ");

  def is_public_cidr:
    any(source_strings[]?; . == "0.0.0.0/0" or . == "::/0");

  def ipv4_octet:
    "(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])";

  def valid_ipv4_cidr:
    test("^(" + ipv4_octet + "\\.){3}" + ipv4_octet + "/([0-9]|[12][0-9]|3[0-2])$");

  def ipv4_prefix:
    (capture("/(?<prefix>[0-9]+)$").prefix | tonumber);

  def valid_ipv4_host_cidr:
    valid_ipv4_cidr and ipv4_prefix == 32;

  def valid_ipv6_cidr:
    test(":") and test("^[0-9A-Fa-f:]+/([0-9]|[1-9][0-9]|1[01][0-9]|12[0-8])$");

  def ipv6_prefix:
    (capture("/(?<prefix>[0-9]+)$").prefix | tonumber);

  def valid_ipv6_host_cidr:
    valid_ipv6_cidr and ipv6_prefix == 128;

  def is_private_source_string:
    (valid_ipv4_cidr and (
      (test("^10\\.") and ipv4_prefix >= 8)
      or (test("^192\\.168\\.") and ipv4_prefix >= 16)
      or (test("^172\\.(1[6-9]|2[0-9]|3[0-1])\\.") and ipv4_prefix >= 12)
      or (test("^127\\.") and ipv4_prefix >= 8)
    ))
    or ((. | ascii_downcase) as $source
      | valid_ipv6_cidr and (
        ($source | test("^(fc|fd)") and ipv6_prefix >= 7)
        or ($source | test("^fe80:") and ipv6_prefix >= 10)
        or ($source == "::1/128")
      ));

  def has_non_private_source:
    (source_strings | length) == 0
    or any(source_strings[]?; (is_private_source_string | not));

  def is_ssh_management_source:
    ((.sourceType // "") as $type
      | ($type == "fixed-management-ip" or $type == "vpn" or $type == "private-management-network"));

  def source_type:
    ((.sourceType // "") | tostring);

  def is_single_host_source:
    (source_strings | length) > 0
    and all(source_strings[]?;
      valid_ipv4_host_cidr
      or valid_ipv6_host_cidr);

  def is_private_management_source:
    (source_strings | length) > 0
    and all(source_strings[]?;
      is_private_source_string);

  [
    words($requiredHosts) as $requiredHostsList
    | applies_to_hosts as $appliesToHosts
    | if (valid_evidence_source_kind | not) then
        "evidenceSource.kind must be one of ufw-status or aws-security-groups"
      else empty end,

    if ($appliesToHosts | length) == 0 then
        "appliesToHosts must be a non-empty production host list"
      else empty end,

    ($requiredHostsList[]? as $host
      | if (applies_to_hosts | index($host)) then
          empty
        else
          "firewall policy does not declare required host \($host) in appliesToHosts"
        end),

    if (rules | type) != "array" or (rules | length) == 0 then
      "ingressRules must be a non-empty array"
    else empty end,

    if any(rules[]?; is_allow and is_tcp and is_public_cidr and covers_port(80)) then
      empty
    else
      "missing public tcp/80 allow rule"
    end,

    if any(rules[]?; is_allow and is_tcp and is_public_cidr and covers_port(443)) then
      empty
    else
      "missing public tcp/443 allow rule"
    end,

    (rules[]? as $rule
      | if ($rule | is_allow and is_tcp and is_public_cidr and (is_public_web_port_only | not)) then
          "public tcp/\($rule | port_string) is allowed from \($rule | cidr_string)"
        else empty end),

    (rules[]? as $rule
      | if ($rule | is_allow and is_tcp and has_non_private_source and (is_public_web_port_only | not) and ((is_ssh_port_only and is_ssh_management_source) | not)) then
          "non-private tcp/\($rule | port_string) is allowed from \($rule | cidr_string)"
        else empty end),

    (rules[]? as $rule
      | if ($rule | is_allow and is_tcp and covers_port(22) and is_public_cidr) then
          "ssh tcp/22 is publicly allowed from \($rule | cidr_string)"
        else empty end),

    (rules[]? as $rule
      | if ($rule | is_allow and is_tcp and covers_port(22) and (is_ssh_management_source | not)) then
          "ssh tcp/22 rule must declare sourceType fixed-management-ip, vpn, or private-management-network"
        else empty end),

    (rules[]? as $rule
      | if ($rule | is_allow and is_tcp and covers_port(22) and source_type == "fixed-management-ip" and (is_single_host_source | not)) then
          "ssh tcp/22 fixed-management-ip source must be a single host CIDR (/32 or /128), got \($rule | cidr_string)"
        else empty end),

    (rules[]? as $rule
      | if ($rule | is_allow and is_tcp and covers_port(22) and source_type == "private-management-network" and (is_private_management_source | not)) then
          "ssh tcp/22 private-management-network source must be a private network, got \($rule | cidr_string)"
        else empty end),

    (rules[]? as $rule
      | if ($rule | is_allow and is_tcp and (covers_port(6379) or covers_port(5432)) and has_non_private_source) then
          "database/cache tcp/\($rule | port_string) is allowed from non-private source \($rule | cidr_string)"
        else empty end)
  ]
  | .[]
' "$POLICY_FILE")" || {
  printf '[production-firewall-policy] failed\n' >&2
  printf -- '- invalid firewall policy evidence JSON or verifier expression failed: %s\n' "$POLICY_FILE" >&2
  exit 1
}

failures=()
if [[ -n "$jq_output" ]]; then
  mapfile -t failures <<<"$jq_output"
fi

if (( ${#failures[@]} > 0 )); then
  printf '[production-firewall-policy] failed\n' >&2
  for failure in "${failures[@]}"; do
    printf -- '- %s\n' "$failure" >&2
  done
  exit 1
fi

printf '[production-firewall-policy] ok\n'
