#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REQUEST_FILE="${FSUSBLOG_PRODUCTION_EXPOSURE_REQUEST:-$ROOT_DIR/.tmp/security/production-exposure-evidence-request.json}"
STATUS_FILE="${FSUSBLOG_PRODUCTION_EXPOSURE_STATUS:-$ROOT_DIR/.tmp/security/production-exposure-status.json}"
LIVE_EVIDENCE_FILE="${FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE:-$ROOT_DIR/.tmp/security/production-exposure-live.json}"
FIREWALL_POLICY_FILE="${FSUSBLOG_FIREWALL_POLICY_EVIDENCE:-$ROOT_DIR/.tmp/security/production-firewall-policy.json}"
DNS_READINESS_FILE="${FSUSBLOG_DNS_READINESS_EVIDENCE:-$ROOT_DIR/.tmp/security/production-dns-readiness.json}"
DNS_DELEGATION_FILE="${FSUSBLOG_DNS_DELEGATION_EVIDENCE:-$ROOT_DIR/.tmp/security/production-dns-delegation.json}"
MANIFEST_FILE="${1:-${FSUSBLOG_RELEASE_EVIDENCE_MANIFEST:-}}"
ALLOW_TEMP_EVIDENCE="${FSUSBLOG_ALLOW_TEMP_EVIDENCE:-0}"

failures=()

AddFailure() {
    failures+=("$1")
}

JsonValue() {
    local file="$1"
    local expr="$2"
    jq -r "$expr" "$file" 2>/dev/null || true
}

ManifestArtifact() {
    local key="$1"
    jq -r --arg key "$key" '
    .artifacts[$key] | if type == "string" then . else "" end
  ' "$MANIFEST_FILE" 2>/dev/null || true
}

ManifestDigestAlgorithm() {
    local key="$1"
    jq -r --arg key "$key" '.artifactDigests[$key].algorithm // ""' "$MANIFEST_FILE" 2>/dev/null || true
}

ManifestDigestValue() {
    local key="$1"
    jq -r --arg key "$key" '.artifactDigests[$key].value // ""' "$MANIFEST_FILE" 2>/dev/null || true
}

CheckArtifactDigest() {
    local label="$1"
    local key="$2"
    local artifactFile="$3"
    local digestAlgorithm digestValue actualDigest

    digestAlgorithm="$(ManifestDigestAlgorithm "$key")"
    digestValue="$(ManifestDigestValue "$key")"
    if [[ "$digestAlgorithm" != "sha256" || -z "$digestValue" ]]; then
        AddFailure "manifest is missing sha256 digest for $label"
        return
    fi

    actualDigest="$(sha256sum "$artifactFile" | awk '{print $1}')"
    if [[ "$digestValue" != "$actualDigest" ]]; then
        AddFailure "manifest sha256 digest for $label does not match bundled artifact"
    fi
}

CheckBundledArtifact() {
    local label="$1"
    local key="$2"
    local sourceFile="$3"
    local expectedArtifact="$4"
    local artifact artifactFile digestAlgorithm digestValue

    artifact="$(ManifestArtifact "$key")"
    if [[ -z "$artifact" ]]; then
        if [[ -e "$sourceFile" ]]; then
            AddFailure "manifest does not index $label even though source file exists: $sourceFile"
        fi
        digestAlgorithm="$(ManifestDigestAlgorithm "$key")"
        digestValue="$(ManifestDigestValue "$key")"
        if [[ -n "$digestAlgorithm" || -n "$digestValue" ]]; then
            AddFailure "manifest has digest for missing $label"
        fi
        return
    fi

    if [[ "$artifact" != "$expectedArtifact" ]]; then
        AddFailure "manifest indexes unexpected artifact for $label: $artifact"
        return
    fi

    artifactFile="$manifest_dir/$artifact"
    if [[ ! -f "$artifactFile" ]]; then
        AddFailure "manifest bundle is missing $label: $artifact"
    elif [[ ! -f "$sourceFile" ]]; then
        AddFailure "source file for bundled $label is missing: $sourceFile"
    elif ! cmp -s "$sourceFile" "$artifactFile"; then
        AddFailure "manifest bundled $label does not match configured source file"
    else
        CheckArtifactDigest "$label" "$key" "$artifactFile"
    fi
}

ResultStatusForFile() {
    local file="$1"
    if [[ ! -f "$file" ]]; then
        printf 'missing'
        return
    fi

    jq -r '
    if (.results // [] | length) == 0 then
      "present"
    elif any(.results[]?; .status != "ok") then
      "blocked"
    else
      "ok"
    end
  ' "$file" 2>/dev/null || printf 'invalid'
}

FirewallPolicyStatusForFile() {
    local file="$1"
    if [[ -f "$file" ]]; then
        printf 'present'
    else
        printf 'missing'
    fi
}

CheckManifestExternalStatus() {
    local label="$1"
    local key="$2"
    local expected="$3"
    local actual

    actual="$(JsonValue "$MANIFEST_FILE" ".evidenceSummary.externalExposure.$key // \"\"")"
    if [[ "$actual" != "$expected" ]]; then
        AddFailure "manifest externalExposure.$key ($actual) does not match $label status ($expected)"
    fi
}

CheckRequestEvidencePath() {
    local label="$1"
    local key="$2"
    local expected="$3"
    local actual

    actual="$(JsonValue "$REQUEST_FILE" ".evidenceFiles.$key // \"\"")"
    if [[ "$actual" != "$expected" ]]; then
        AddFailure "request $label path ($actual) does not match configured source file ($expected)"
    fi
}

CheckRequestHandoffSchema() {
    if ! jq -e '
    . as $request
    | ($request.requiredEvidence // []) as $required
    | ($required | type == "array")
    and all(
      [
        {key: "firewallPolicy", source: "firewall-policy", artifactName: "production-firewall-policy.json"},
        {key: "dnsReadiness", source: "dns-readiness", artifactName: "production-dns-readiness.json"},
        {key: "dnsDelegation", source: "dns-delegation", artifactName: "production-dns-delegation.json"},
        {key: "liveExposure", source: "live-evidence", artifactName: "production-exposure-live.json"},
        {key: "statusReport", source: "status-report", artifactName: "production-exposure-status.json"}
      ][] as $expected
      | any(
        $required[]?;
        .key == $expected.key
        and .source == $expected.source
        and .artifactName == $expected.artifactName
        and .path == ($request.evidenceFiles[$expected.key] // "")
        and .requiredForCloseout == true
        and (if $expected.key == "firewallPolicy" then .sourceSha256Required == true else true end)
      )
    )
    and ($request.firewallPolicyRequirements.rawSourceSha256Required == true)
  ' "$REQUEST_FILE" >/dev/null 2>&1; then
        AddFailure "request requiredEvidence must cover every production exposure evidence file with standard artifact names and firewall source sha256 requirements"
    fi

    if ! jq -e '
    any(.verificationCommands[]?; .name == "complete-closeout" and .command == "tools/security/complete-production-exposure-closeout.sh" and .requiredForCloseout == true)
    and any(.verificationCommands[]?; .name == "verify-returned-evidence" and .command == "tools/security/verify-production-exposure-returned-evidence.sh <returned-evidence-dir>" and .requiredBeforeReturnedCloseout == true)
    and any(.verificationCommands[]?; .name == "complete-returned-evidence" and .command == "tools/security/complete-production-exposure-from-returned-evidence.sh <returned-evidence-dir>" and .requiredForCloseout == true)
    and any(.verificationCommands[]?; .name == "complete-returned-handoff" and .command == "tools/security/complete-production-exposure-from-returned-handoff-bundle.sh <handoff-dir-or-tar.gz>" and .requiredForCloseout == true)
    and any(.verificationCommands[]?; .name == "release-evidence" and .command == "tools/operations/collect-release-evidence.sh" and .outputPattern == ".tmp/release-evidence/<release-identity>/manifest.json")
    and any(.verificationCommands[]?; .name == "handoff-check" and .command == "tools/security/check-production-exposure-handoff.sh <manifest.json>" and .requiredBeforeExternalHandoff == true)
    and any(.handoffChecks[]?; .id == "request-status-manifest-alignment" and .requiredBeforeExternalHandoff == true)
    and .finalCloseoutCommand == "tools/security/complete-production-exposure-closeout.sh"
    and .returnedEvidenceVerifierCommand == "tools/security/verify-production-exposure-returned-evidence.sh <returned-evidence-dir>"
    and .returnedEvidenceCloseoutCommand == "tools/security/complete-production-exposure-from-returned-evidence.sh <returned-evidence-dir>"
    and .returnedHandoffCloseoutCommand == "tools/security/complete-production-exposure-from-returned-handoff-bundle.sh <handoff-dir-or-tar.gz>"
    and .releaseEvidenceCommand == "tools/operations/collect-release-evidence.sh"
  ' "$REQUEST_FILE" >/dev/null 2>&1; then
        AddFailure "request verificationCommands, closeout command fields and handoffChecks must describe direct, returned-evidence, returned-handoff and release evidence verification"
    fi
}

if [[ ! -f "$REQUEST_FILE" ]]; then
    AddFailure "missing production exposure request file: $REQUEST_FILE"
fi

if [[ ! -f "$STATUS_FILE" ]]; then
    AddFailure "missing production exposure status file: $STATUS_FILE"
fi

if [[ -n "$MANIFEST_FILE" && ! -f "$MANIFEST_FILE" ]]; then
    AddFailure "missing release evidence manifest file: $MANIFEST_FILE"
fi

if ((${#failures[@]} == 0)); then
    if ! jq -e '.status == "awaiting-external-evidence"' "$REQUEST_FILE" >/dev/null 2>&1; then
        AddFailure "request status must be awaiting-external-evidence"
    fi

    if ! jq -e '.requiredHosts | type == "array" and length > 0' "$REQUEST_FILE" >/dev/null 2>&1; then
        AddFailure "request requiredHosts must be a non-empty array"
    fi

    if ! jq -e '.delegationDomains | type == "array" and length > 0' "$REQUEST_FILE" >/dev/null 2>&1; then
        AddFailure "request delegationDomains must be a non-empty array"
    fi

    request_status="$(JsonValue "$REQUEST_FILE" '.currentStatus.status // ""')"
    status_status="$(JsonValue "$STATUS_FILE" '.status // ""')"
    if [[ "$request_status" != "$status_status" ]]; then
        AddFailure "request currentStatus.status ($request_status) does not match status report ($status_status)"
    fi

    request_count="$(JsonValue "$REQUEST_FILE" '.currentStatus.blockerCount // 0')"
    status_count="$(JsonValue "$STATUS_FILE" '.blockers // [] | length')"
    if [[ "$request_count" != "$status_count" ]]; then
        AddFailure "request blockerCount ($request_count) does not match status blockers ($status_count)"
    fi

    if ! jq -e --slurpfile status "$STATUS_FILE" '
    (.currentStatus.blockerSources // [] | sort) == ($status[0].blockers // [] | map(.source) | unique | sort)
  ' "$REQUEST_FILE" >/dev/null 2>&1; then
        AddFailure "request blockerSources do not match status report blocker sources"
    fi

    if ! jq -e --slurpfile status "$STATUS_FILE" '
    (.currentStatus.blockers // []) == ($status[0].blockers // [])
  ' "$REQUEST_FILE" >/dev/null 2>&1; then
        AddFailure "request blockers do not match status report blockers"
    fi

    if ! jq -e --slurpfile status "$STATUS_FILE" '
    (.requiredHosts // [] | sort) == ($status[0].requiredHosts // [] | sort)
  ' "$REQUEST_FILE" >/dev/null 2>&1; then
        AddFailure "request requiredHosts do not match status report requiredHosts"
    fi

    if ! jq -e --slurpfile status "$STATUS_FILE" '
    (.delegationDomains // [] | sort) == ($status[0].delegationDomains // [] | sort)
  ' "$REQUEST_FILE" >/dev/null 2>&1; then
        AddFailure "request delegationDomains do not match status report delegationDomains"
    fi

    if ! jq -e '
    (.currentStatus.blockerSources // []) as $sources
    | (.nextActions // [] | map(.source)) as $actions
    | all($sources[]?; . as $source | $actions | index($source) != null)
  ' "$REQUEST_FILE" >/dev/null 2>&1; then
        AddFailure "request nextActions must cover every blocker source"
    fi

    if ! jq -e '
    (.currentStatus.blockerSources // []) as $sources
    | (.unblockPlan // [] | map(.source)) as $plans
    | all($sources[]?; . as $source | $plans | index($source) != null)
    and all(.unblockPlan[]?; (.blockerCount // 0) > 0 and (.artifactNames // [] | length) > 0 and (.commands // [] | length) > 0)
    and (if (.currentStatus.status // "") == "missing" then any(.unblockPlan[]?; .source == "status-report") else true end)
  ' "$REQUEST_FILE" >/dev/null 2>&1; then
        AddFailure "request unblockPlan must cover every blocker source with artifact names, commands and blocker counts"
    fi

    CheckRequestEvidencePath "firewallPolicy" firewallPolicy "$FIREWALL_POLICY_FILE"
    CheckRequestEvidencePath "dnsReadiness" dnsReadiness "$DNS_READINESS_FILE"
    CheckRequestEvidencePath "dnsDelegation" dnsDelegation "$DNS_DELEGATION_FILE"
    CheckRequestEvidencePath "liveExposure" liveExposure "$LIVE_EVIDENCE_FILE"
    CheckRequestEvidencePath "statusReport" statusReport "$STATUS_FILE"
    CheckRequestHandoffSchema

    if [[ "$ALLOW_TEMP_EVIDENCE" != "1" ]]; then
        if jq -e '.evidenceFiles | to_entries[]? | select(.value | startswith("/tmp/tmp"))' "$REQUEST_FILE" >/dev/null 2>&1; then
            AddFailure "request evidenceFiles contain /tmp/tmp paths; rerun real closeout to refresh production artifacts"
        fi
    fi
fi

if [[ -n "$MANIFEST_FILE" && -f "$MANIFEST_FILE" && -f "$REQUEST_FILE" ]]; then
    manifest_dir="$(cd "$(dirname "$MANIFEST_FILE")" && pwd)"
    bundled_request_artifact="$(ManifestArtifact productionExposureRequest)"
    bundled_status_artifact="$(ManifestArtifact productionExposureStatus)"
    bundled_request_file=""
    bundled_status_file=""

    if ! jq -e '.artifacts.productionExposureRequest == "production-exposure-evidence-request.json"' "$MANIFEST_FILE" >/dev/null 2>&1; then
        AddFailure "manifest does not index production-exposure-evidence-request.json"
    else
        bundled_request_file="$manifest_dir/$bundled_request_artifact"
        if [[ ! -f "$bundled_request_file" ]]; then
            AddFailure "manifest bundle is missing production-exposure-evidence-request.json"
        elif ! cmp -s "$REQUEST_FILE" "$bundled_request_file"; then
            AddFailure "manifest bundled request does not match configured request file"
        else
            CheckArtifactDigest "production exposure request" productionExposureRequest "$bundled_request_file"
        fi
    fi

    if ! jq -e '.artifacts.productionExposureStatus == "production-exposure-status.json"' "$MANIFEST_FILE" >/dev/null 2>&1; then
        AddFailure "manifest does not index production-exposure-status.json"
    else
        bundled_status_file="$manifest_dir/$bundled_status_artifact"
        if [[ ! -f "$bundled_status_file" ]]; then
            AddFailure "manifest bundle is missing production-exposure-status.json"
        elif ! cmp -s "$STATUS_FILE" "$bundled_status_file"; then
            AddFailure "manifest bundled status does not match configured status file"
        else
            CheckArtifactDigest "production exposure status" productionExposureStatus "$bundled_status_file"
        fi
    fi

    CheckBundledArtifact "production exposure live evidence" productionExposureLive "$LIVE_EVIDENCE_FILE" production-exposure-live.json
    CheckBundledArtifact "DNS readiness evidence" dnsReadiness "$DNS_READINESS_FILE" production-dns-readiness.json
    CheckBundledArtifact "DNS delegation evidence" dnsDelegation "$DNS_DELEGATION_FILE" production-dns-delegation.json
    CheckBundledArtifact "firewall policy evidence" firewallPolicy "$FIREWALL_POLICY_FILE" production-firewall-policy.json

    CheckManifestExternalStatus "production exposure live evidence" liveExposure "$(ResultStatusForFile "$LIVE_EVIDENCE_FILE")"
    CheckManifestExternalStatus "DNS readiness evidence" dnsReadiness "$(ResultStatusForFile "$DNS_READINESS_FILE")"
    CheckManifestExternalStatus "DNS delegation evidence" dnsDelegation "$(ResultStatusForFile "$DNS_DELEGATION_FILE")"
    CheckManifestExternalStatus "firewall policy evidence" firewallPolicy "$(FirewallPolicyStatusForFile "$FIREWALL_POLICY_FILE")"

    summary_request_file="$REQUEST_FILE"
    summary_status_file="$STATUS_FILE"
    if [[ -f "$bundled_request_file" ]]; then
        summary_request_file="$bundled_request_file"
    fi
    if [[ -f "$bundled_status_file" ]]; then
        summary_status_file="$bundled_status_file"
    fi

    if ! jq -e --slurpfile request "$summary_request_file" --slurpfile status "$summary_status_file" '
    def returned_closeout_command_count($request):
      [
        $request.verificationCommands[]?
        | select(
            (.name == "verify-returned-evidence"
              and .command == "tools/security/verify-production-exposure-returned-evidence.sh <returned-evidence-dir>"
              and .requiredBeforeReturnedCloseout == true)
            or (.name == "complete-returned-evidence"
              and .command == "tools/security/complete-production-exposure-from-returned-evidence.sh <returned-evidence-dir>"
              and .requiredForCloseout == true)
            or (.name == "complete-returned-handoff"
              and .command == "tools/security/complete-production-exposure-from-returned-handoff-bundle.sh <handoff-dir-or-tar.gz>"
              and .requiredForCloseout == true)
          )
      ] | length;
    .evidenceSummary.externalExposure.status == ($status[0].status // null)
    and .evidenceSummary.externalExposure.valid == (($status[0].status // null) == "ok")
    and (.evidenceSummary.externalExposure.blockers // []) == ($status[0].blockers // [])
    and .evidenceSummary.externalExposure.request.status == ($request[0].status // null)
    and .evidenceSummary.externalExposure.request.currentStatus == ($request[0].currentStatus.status // null)
    and (.evidenceSummary.externalExposure.request.blockerCount // null) == ($request[0].currentStatus.blockerCount // 0)
	    and (.evidenceSummary.externalExposure.request.blockerSources // [] | sort) == ($request[0].currentStatus.blockerSources // [] | sort)
	    and (.evidenceSummary.externalExposure.request.nextActionSources // [] | sort) == ($request[0].nextActions // [] | map(.source) | sort)
	    and (.evidenceSummary.externalExposure.request.unblockPlanSources // [] | sort) == ($request[0].unblockPlan // [] | map(.source) | sort)
	    and (.evidenceSummary.externalExposure.request.unblockPlanCount // null) == ($request[0].unblockPlan // [] | length)
	    and (.evidenceSummary.externalExposure.request.requiredHosts // [] | sort) == ($request[0].requiredHosts // [] | sort)
    and (.evidenceSummary.externalExposure.request.delegationDomains // [] | sort) == ($request[0].delegationDomains // [] | sort)
    and (.evidenceSummary.externalExposure.request.requiredEvidenceKeys // [] | sort) == ($request[0].requiredEvidence // [] | map(.key) | sort)
    and (.evidenceSummary.externalExposure.request.requiredEvidenceCount // null) == ($request[0].requiredEvidence // [] | length)
    and (.evidenceSummary.externalExposure.request.firewallSourceSha256Required // false) == any($request[0].requiredEvidence[]?; .key == "firewallPolicy" and .sourceSha256Required == true)
    and (.evidenceSummary.externalExposure.request.rawSourceSha256Required // false) == ($request[0].firewallPolicyRequirements.rawSourceSha256Required == true)
    and (.evidenceSummary.externalExposure.request.handoffCheckCount // null) == ($request[0].handoffChecks // [] | length)
    and (.evidenceSummary.externalExposure.request.verificationCommandNames // [] | sort) == ($request[0].verificationCommands // [] | map(.name) | sort)
    and (.evidenceSummary.externalExposure.request.verificationCommandCount // null) == ($request[0].verificationCommands // [] | length)
    and (.evidenceSummary.externalExposure.request.returnedCloseoutCommandCount // null) == returned_closeout_command_count($request[0])
    and (.evidenceSummary.externalExposure.request.closeoutCommands.finalCloseout // null) == ($request[0].finalCloseoutCommand // null)
    and (.evidenceSummary.externalExposure.request.closeoutCommands.returnedEvidenceVerifier // null) == ($request[0].returnedEvidenceVerifierCommand // null)
    and (.evidenceSummary.externalExposure.request.closeoutCommands.returnedEvidenceCloseout // null) == ($request[0].returnedEvidenceCloseoutCommand // null)
    and (.evidenceSummary.externalExposure.request.closeoutCommands.returnedHandoffCloseout // null) == ($request[0].returnedHandoffCloseoutCommand // null)
    and (.evidenceSummary.externalExposure.request.closeoutCommands.releaseEvidence // null) == ($request[0].releaseEvidenceCommand // null)
  ' "$MANIFEST_FILE" >/dev/null 2>&1; then
        AddFailure "manifest request summary does not match status report and request package"
    fi
fi

if ((${#failures[@]} > 0)); then
    printf '[production-exposure-handoff] failed\n' >&2
    for failure in "${failures[@]}"; do
        printf -- '- %s\n' "$failure" >&2
    done
    exit 1
fi

printf '[production-exposure-handoff] ok\n'
