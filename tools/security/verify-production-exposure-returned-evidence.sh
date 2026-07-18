#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RETURNED_DIR="${1:-${FSUSBLOG_PRODUCTION_EXPOSURE_RETURNED_DIR:-}}"
STAMP="${FSUSBLOG_RELEASE_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
OUT_DIR="${FSUSBLOG_PRODUCTION_EXPOSURE_RETURNED_OUT_DIR:-$ROOT_DIR/.tmp/release-evidence/returned-$STAMP}"

Fail() {
    printf '[production-exposure-returned-evidence] failed\n' >&2
    printf -- '- %s\n' "$1" >&2
    exit 1
}

JsonArrayWords() {
    local file="$1"
    local expr="$2"
    jq -r "$expr | if type == \"array\" then map(tostring) | join(\" \") else \"\" end" "$file" 2>/dev/null || true
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

DomainFromHost() {
    awk -F '.' '
    NF >= 2 { print $(NF - 1) "." $NF }
  ' <<<"$1"
}

if [[ -z "$RETURNED_DIR" ]]; then
    Fail 'missing returned evidence directory'
fi

if [[ ! -d "$RETURNED_DIR" ]]; then
    Fail "returned evidence directory does not exist: $RETURNED_DIR"
fi

if [[ -L "$RETURNED_DIR" ]]; then
    Fail "returned evidence directory must not be a symlink: $RETURNED_DIR"
fi

RETURNED_DIR="$(cd "$RETURNED_DIR" && pwd)"
symlink_path="$(find "$RETURNED_DIR" -type l -print -quit 2>/dev/null || true)"
if [[ -n "$symlink_path" ]]; then
    Fail "returned evidence directory contains a symlink: ${symlink_path#$RETURNED_DIR/}"
fi

FIREWALL_POLICY_FILE="$RETURNED_DIR/production-firewall-policy.json"
DNS_READINESS_FILE="$RETURNED_DIR/production-dns-readiness.json"
DNS_DELEGATION_FILE="$RETURNED_DIR/production-dns-delegation.json"
LIVE_EVIDENCE_FILE="$RETURNED_DIR/production-exposure-live.json"
STATUS_FILE="$RETURNED_DIR/production-exposure-status.json"
REQUEST_FILE="$RETURNED_DIR/production-exposure-evidence-request.json"
EXPECTED_MANIFEST_FILE="$RETURNED_DIR/expected-evidence-manifest.json"

for required_file in \
    "$FIREWALL_POLICY_FILE" \
    "$DNS_READINESS_FILE" \
    "$DNS_DELEGATION_FILE" \
    "$LIVE_EVIDENCE_FILE"; do
    [[ -f "$required_file" ]] || Fail "returned evidence is missing $(basename "$required_file")"
done

mapfile -t expected_hosts < <("$ROOT_DIR/tools/security/collect-production-hosts.sh")
if ((${#expected_hosts[@]} == 0)); then
    Fail 'no production hosts found; set FSUSBLOG_LIVE_HOSTS or production env values'
fi
expected_host_words="$(printf '%s\n' "${expected_hosts[@]}" | paste -sd ' ' -)"
expected_host_env="$(printf '%s\n' "${expected_hosts[@]}" | paste -sd ',' -)"
expected_domain_words="$(printf '%s\n' "${expected_hosts[@]}" | while read -r host; do
    [[ -n "$host" ]] || continue
    DomainFromHost "$host"
done | sort -u | paste -sd ' ' -)"

ValidateScopeFile() {
    local file="$1"
    local label="$2"
    local scopeHosts scopeDomains expectedHost expectedDomain

    scopeHosts="$(JsonArrayWords "$file" '.requiredHosts')"
    scopeDomains="$(JsonArrayWords "$file" '.delegationDomains')"
    [[ -n "$scopeHosts" ]] || Fail "$label requiredHosts must be a non-empty array"
    [[ -n "$scopeDomains" ]] || Fail "$label delegationDomains must be a non-empty array"
    for expectedHost in $expected_host_words; do
        if ! HasWord "$expectedHost" $scopeHosts; then
            Fail "$label does not cover required production host: $expectedHost"
        fi
    done
    for expectedDomain in $expected_domain_words; do
        if ! HasWord "$expectedDomain" $scopeDomains; then
            Fail "$label does not cover required delegation domain: $expectedDomain"
        fi
    done
}

if [[ -f "$EXPECTED_MANIFEST_FILE" ]]; then
    ValidateScopeFile "$EXPECTED_MANIFEST_FILE" 'returned expected evidence manifest'
    jq -e '
    . as $manifest
    | def required_artifacts($source):
        ($manifest.requiredReturnedFiles // [])
        | map(select(.source == $source) | .artifactName)
        | sort;
    def required_keys($source):
        ($manifest.requiredReturnedFiles // [])
        | map(select(.source == $source) | .key)
        | sort;
    def required_commands($source):
        ($manifest.requiredReturnedFiles // [])
        | map(select(.source == $source and (.command // null) != null) | .command)
        | sort;
    def required_plan_commands($source):
        if $source == "firewall-policy" then
          ["tools/security/verify-production-firewall-policy-evidence.sh"]
        elif $source == "dns-readiness" then
          ["tools/security/check-production-dns-readiness.sh"]
        elif $source == "dns-delegation" then
          ["tools/security/check-production-dns-delegation.sh"]
        elif $source == "live-evidence" then
          [
            "tools/security/check-production-exposure-live.sh",
            "tools/security/verify-production-exposure-evidence.sh"
          ]
        else
          []
        end;
    def basenames($items):
        $items
        | map(tostring | split("/")[-1])
        | sort;
    (.contractVersion == 1)
    and (.generatedBy == "tools/security/export-production-exposure-handoff-bundle.sh")
    and (.sourceReleaseManifest | type) == "string"
    and (.sourceReleaseManifest | length) > 0
    and (.sourceReleaseManifestSha256 | test("^[0-9a-f]{64}$"))
    and (.sourceRequestSha256 | test("^[0-9a-f]{64}$"))
    and (.requiredReturnedFiles | type) == "array"
    and ([.requiredReturnedFiles[].artifactName] | sort) == [
      "production-dns-delegation.json",
      "production-dns-readiness.json",
      "production-exposure-live.json",
      "production-firewall-policy.json"
    ]
    and all(.requiredReturnedFiles[]; .requiredForCloseout == true)
    and any(.requiredReturnedFiles[]; .artifactName == "production-firewall-policy.json" and .sourceSha256Required == true)
    and (.unblockPlan | type) == "array"
    and (.unblockPlan | length) > 0
    and (.unblockPlanSources | type) == "array"
    and (.unblockPlanCount | type) == "number"
    and ((.unblockPlanSources | sort) == (.unblockPlan | map(.source) | unique | sort))
    and (.unblockPlanCount == (.unblockPlan | length))
    and all(.unblockPlan[];
      . as $plan
      | (.source | type) == "string"
      and (.source | length) > 0
      and (.returnedEvidenceRequired == true)
      and ((.blockerCount // 0) > 0)
      and ((.artifactNames // []) | type) == "array"
      and ((.artifactNames // []) | length) > 0
      and ((.artifactNames | sort) == required_artifacts($plan.source))
      and ((.evidenceKeys // []) | type) == "array"
      and ((.evidenceKeys | sort) == required_keys($plan.source))
      and ((.evidenceFiles // []) | type) == "array"
      and ((.evidenceFiles // []) | length) > 0
      and (basenames(.evidenceFiles) == (.artifactNames | sort))
      and ((.commands // []) | type) == "array"
      and ((.commands // []) | length) > 0
      and (
        required_commands($plan.source) as $requiredCommands
        | all($requiredCommands[]?; . as $command | ($plan.commands // []) | index($command) != null)
      )
      and (
        required_plan_commands($plan.source) as $requiredPlanCommands
        | all($requiredPlanCommands[]?; . as $command | ($plan.commands // []) | index($command) != null)
      )
    )
    and (.scopeRule | tostring | contains("must not narrow"))
  ' "$EXPECTED_MANIFEST_FILE" >/dev/null ||
        Fail 'returned expected evidence manifest must list source metadata, required returned files, unblock plan sources/count/key/file mappings, firewall source sha256, and scope rule'
fi

if [[ -f "$REQUEST_FILE" ]]; then
    ValidateScopeFile "$REQUEST_FILE" 'returned request'
fi

export FSUSBLOG_LIVE_HOSTS="$expected_host_env"
export FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$FIREWALL_POLICY_FILE"
export FSUSBLOG_DNS_READINESS_EVIDENCE="$DNS_READINESS_FILE"
export FSUSBLOG_DNS_DELEGATION_EVIDENCE="$DNS_DELEGATION_FILE"
export FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$LIVE_EVIDENCE_FILE"
export FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$STATUS_FILE"
export FSUSBLOG_PRODUCTION_EXPOSURE_REQUEST="$REQUEST_FILE"

status_rc=0
"$ROOT_DIR/tools/security/report-production-exposure-status.sh" || status_rc=$?
"$ROOT_DIR/tools/security/write-production-exposure-evidence-request.sh" "$REQUEST_FILE" >/dev/null

FSUSBLOG_SECURITY_EVIDENCE_SOURCE_DIR="$RETURNED_DIR" \
    FSUSBLOG_RELEASE_EVIDENCE_DIR="$OUT_DIR" \
    "$ROOT_DIR/tools/operations/collect-release-evidence.sh" >/dev/null

"$ROOT_DIR/tools/security/check-production-exposure-handoff.sh" "$OUT_DIR/manifest.json" >/dev/null

if ((status_rc != 0)); then
    printf '[production-exposure-returned-evidence] blocked\n' >&2
    printf -- '- wrote %s\n' "$STATUS_FILE" >&2
    printf -- '- wrote %s\n' "$REQUEST_FILE" >&2
    printf -- '- wrote %s\n' "$OUT_DIR/manifest.json" >&2
    exit "$status_rc"
fi

printf '[production-exposure-returned-evidence] ok\n'
printf -- '- wrote %s\n' "$STATUS_FILE"
printf -- '- wrote %s\n' "$REQUEST_FILE"
printf -- '- wrote %s\n' "$OUT_DIR/manifest.json"
