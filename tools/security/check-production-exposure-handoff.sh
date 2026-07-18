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

add_failure() {
  failures+=("$1")
}

json_value() {
  local file="$1"
  local expr="$2"
  jq -r "$expr" "$file" 2>/dev/null || true
}

manifest_artifact() {
  local key="$1"
  jq -r --arg key "$key" '
    .artifacts[$key] | if type == "string" then . else "" end
  ' "$MANIFEST_FILE" 2>/dev/null || true
}

manifest_digest_algorithm() {
  local key="$1"
  jq -r --arg key "$key" '.artifactDigests[$key].algorithm // ""' "$MANIFEST_FILE" 2>/dev/null || true
}

manifest_digest_value() {
  local key="$1"
  jq -r --arg key "$key" '.artifactDigests[$key].value // ""' "$MANIFEST_FILE" 2>/dev/null || true
}

check_artifact_digest() {
  local label="$1"
  local key="$2"
  local artifact_file="$3"
  local digest_algorithm digest_value actual_digest

  digest_algorithm="$(manifest_digest_algorithm "$key")"
  digest_value="$(manifest_digest_value "$key")"
  if [[ "$digest_algorithm" != "sha256" || -z "$digest_value" ]]; then
    add_failure "manifest is missing sha256 digest for $label"
    return
  fi

  actual_digest="$(sha256sum "$artifact_file" | awk '{print $1}')"
  if [[ "$digest_value" != "$actual_digest" ]]; then
    add_failure "manifest sha256 digest for $label does not match bundled artifact"
  fi
}

check_bundled_artifact() {
  local label="$1"
  local key="$2"
  local source_file="$3"
  local expected_artifact="$4"
  local artifact artifact_file digest_algorithm digest_value

  artifact="$(manifest_artifact "$key")"
  if [[ -z "$artifact" ]]; then
    if [[ -e "$source_file" ]]; then
      add_failure "manifest does not index $label even though source file exists: $source_file"
    fi
    digest_algorithm="$(manifest_digest_algorithm "$key")"
    digest_value="$(manifest_digest_value "$key")"
    if [[ -n "$digest_algorithm" || -n "$digest_value" ]]; then
      add_failure "manifest has digest for missing $label"
    fi
    return
  fi

  if [[ "$artifact" != "$expected_artifact" ]]; then
    add_failure "manifest indexes unexpected artifact for $label: $artifact"
    return
  fi

  artifact_file="$manifest_dir/$artifact"
  if [[ ! -f "$artifact_file" ]]; then
    add_failure "manifest bundle is missing $label: $artifact"
  elif [[ ! -f "$source_file" ]]; then
    add_failure "source file for bundled $label is missing: $source_file"
  elif ! cmp -s "$source_file" "$artifact_file"; then
    add_failure "manifest bundled $label does not match configured source file"
  else
    check_artifact_digest "$label" "$key" "$artifact_file"
  fi
}

result_status_for_file() {
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

firewall_policy_status_for_file() {
  local file="$1"
  if [[ -f "$file" ]]; then
    printf 'present'
  else
    printf 'missing'
  fi
}

check_manifest_external_status() {
  local label="$1"
  local key="$2"
  local expected="$3"
  local actual

  actual="$(json_value "$MANIFEST_FILE" ".evidenceSummary.externalExposure.$key // \"\"")"
  if [[ "$actual" != "$expected" ]]; then
    add_failure "manifest externalExposure.$key ($actual) does not match $label status ($expected)"
  fi
}

check_request_evidence_path() {
  local label="$1"
  local key="$2"
  local expected="$3"
  local actual

  actual="$(json_value "$REQUEST_FILE" ".evidenceFiles.$key // \"\"")"
  if [[ "$actual" != "$expected" ]]; then
    add_failure "request $label path ($actual) does not match configured source file ($expected)"
  fi
}

check_request_handoff_schema() {
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
    add_failure "request requiredEvidence must cover every production exposure evidence file with standard artifact names and firewall source sha256 requirements"
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
    add_failure "request verificationCommands, closeout command fields and handoffChecks must describe direct, returned-evidence, returned-handoff and release evidence verification"
  fi
}

if [[ ! -f "$REQUEST_FILE" ]]; then
  add_failure "missing production exposure request file: $REQUEST_FILE"
fi

if [[ ! -f "$STATUS_FILE" ]]; then
  add_failure "missing production exposure status file: $STATUS_FILE"
fi

if [[ -n "$MANIFEST_FILE" && ! -f "$MANIFEST_FILE" ]]; then
  add_failure "missing release evidence manifest file: $MANIFEST_FILE"
fi

if (( ${#failures[@]} == 0 )); then
  if ! jq -e '.status == "awaiting-external-evidence"' "$REQUEST_FILE" >/dev/null 2>&1; then
    add_failure "request status must be awaiting-external-evidence"
  fi

  if ! jq -e '.requiredHosts | type == "array" and length > 0' "$REQUEST_FILE" >/dev/null 2>&1; then
    add_failure "request requiredHosts must be a non-empty array"
  fi

  if ! jq -e '.delegationDomains | type == "array" and length > 0' "$REQUEST_FILE" >/dev/null 2>&1; then
    add_failure "request delegationDomains must be a non-empty array"
  fi

  request_status="$(json_value "$REQUEST_FILE" '.currentStatus.status // ""')"
  status_status="$(json_value "$STATUS_FILE" '.status // ""')"
  if [[ "$request_status" != "$status_status" ]]; then
    add_failure "request currentStatus.status ($request_status) does not match status report ($status_status)"
  fi

  request_count="$(json_value "$REQUEST_FILE" '.currentStatus.blockerCount // 0')"
  status_count="$(json_value "$STATUS_FILE" '.blockers // [] | length')"
  if [[ "$request_count" != "$status_count" ]]; then
    add_failure "request blockerCount ($request_count) does not match status blockers ($status_count)"
  fi

  if ! jq -e --slurpfile status "$STATUS_FILE" '
    (.currentStatus.blockerSources // [] | sort) == ($status[0].blockers // [] | map(.source) | unique | sort)
  ' "$REQUEST_FILE" >/dev/null 2>&1; then
    add_failure "request blockerSources do not match status report blocker sources"
  fi

  if ! jq -e --slurpfile status "$STATUS_FILE" '
    (.currentStatus.blockers // []) == ($status[0].blockers // [])
  ' "$REQUEST_FILE" >/dev/null 2>&1; then
    add_failure "request blockers do not match status report blockers"
  fi

  if ! jq -e --slurpfile status "$STATUS_FILE" '
    (.requiredHosts // [] | sort) == ($status[0].requiredHosts // [] | sort)
  ' "$REQUEST_FILE" >/dev/null 2>&1; then
    add_failure "request requiredHosts do not match status report requiredHosts"
  fi

  if ! jq -e --slurpfile status "$STATUS_FILE" '
    (.delegationDomains // [] | sort) == ($status[0].delegationDomains // [] | sort)
  ' "$REQUEST_FILE" >/dev/null 2>&1; then
    add_failure "request delegationDomains do not match status report delegationDomains"
  fi

  if ! jq -e '
    (.currentStatus.blockerSources // []) as $sources
    | (.nextActions // [] | map(.source)) as $actions
    | all($sources[]?; . as $source | $actions | index($source) != null)
  ' "$REQUEST_FILE" >/dev/null 2>&1; then
    add_failure "request nextActions must cover every blocker source"
  fi

  if ! jq -e '
    (.currentStatus.blockerSources // []) as $sources
    | (.unblockPlan // [] | map(.source)) as $plans
    | all($sources[]?; . as $source | $plans | index($source) != null)
    and all(.unblockPlan[]?; (.blockerCount // 0) > 0 and (.artifactNames // [] | length) > 0 and (.commands // [] | length) > 0)
    and (if (.currentStatus.status // "") == "missing" then any(.unblockPlan[]?; .source == "status-report") else true end)
  ' "$REQUEST_FILE" >/dev/null 2>&1; then
    add_failure "request unblockPlan must cover every blocker source with artifact names, commands and blocker counts"
  fi

  check_request_evidence_path "firewallPolicy" firewallPolicy "$FIREWALL_POLICY_FILE"
  check_request_evidence_path "dnsReadiness" dnsReadiness "$DNS_READINESS_FILE"
  check_request_evidence_path "dnsDelegation" dnsDelegation "$DNS_DELEGATION_FILE"
  check_request_evidence_path "liveExposure" liveExposure "$LIVE_EVIDENCE_FILE"
  check_request_evidence_path "statusReport" statusReport "$STATUS_FILE"
  check_request_handoff_schema

  if [[ "$ALLOW_TEMP_EVIDENCE" != "1" ]]; then
    if jq -e '.evidenceFiles | to_entries[]? | select(.value | startswith("/tmp/tmp"))' "$REQUEST_FILE" >/dev/null 2>&1; then
      add_failure "request evidenceFiles contain /tmp/tmp paths; rerun real closeout to refresh production artifacts"
    fi
  fi
fi

if [[ -n "$MANIFEST_FILE" && -f "$MANIFEST_FILE" && -f "$REQUEST_FILE" ]]; then
  manifest_dir="$(cd "$(dirname "$MANIFEST_FILE")" && pwd)"
  bundled_request_artifact="$(manifest_artifact productionExposureRequest)"
  bundled_status_artifact="$(manifest_artifact productionExposureStatus)"
  bundled_request_file=""
  bundled_status_file=""

  if ! jq -e '.artifacts.productionExposureRequest == "production-exposure-evidence-request.json"' "$MANIFEST_FILE" >/dev/null 2>&1; then
    add_failure "manifest does not index production-exposure-evidence-request.json"
  else
    bundled_request_file="$manifest_dir/$bundled_request_artifact"
    if [[ ! -f "$bundled_request_file" ]]; then
      add_failure "manifest bundle is missing production-exposure-evidence-request.json"
    elif ! cmp -s "$REQUEST_FILE" "$bundled_request_file"; then
      add_failure "manifest bundled request does not match configured request file"
    else
      check_artifact_digest "production exposure request" productionExposureRequest "$bundled_request_file"
    fi
  fi

  if ! jq -e '.artifacts.productionExposureStatus == "production-exposure-status.json"' "$MANIFEST_FILE" >/dev/null 2>&1; then
    add_failure "manifest does not index production-exposure-status.json"
  else
    bundled_status_file="$manifest_dir/$bundled_status_artifact"
    if [[ ! -f "$bundled_status_file" ]]; then
      add_failure "manifest bundle is missing production-exposure-status.json"
    elif ! cmp -s "$STATUS_FILE" "$bundled_status_file"; then
      add_failure "manifest bundled status does not match configured status file"
    else
      check_artifact_digest "production exposure status" productionExposureStatus "$bundled_status_file"
    fi
  fi

  check_bundled_artifact "production exposure live evidence" productionExposureLive "$LIVE_EVIDENCE_FILE" production-exposure-live.json
  check_bundled_artifact "DNS readiness evidence" dnsReadiness "$DNS_READINESS_FILE" production-dns-readiness.json
  check_bundled_artifact "DNS delegation evidence" dnsDelegation "$DNS_DELEGATION_FILE" production-dns-delegation.json
  check_bundled_artifact "firewall policy evidence" firewallPolicy "$FIREWALL_POLICY_FILE" production-firewall-policy.json

  check_manifest_external_status "production exposure live evidence" liveExposure "$(result_status_for_file "$LIVE_EVIDENCE_FILE")"
  check_manifest_external_status "DNS readiness evidence" dnsReadiness "$(result_status_for_file "$DNS_READINESS_FILE")"
  check_manifest_external_status "DNS delegation evidence" dnsDelegation "$(result_status_for_file "$DNS_DELEGATION_FILE")"
  check_manifest_external_status "firewall policy evidence" firewallPolicy "$(firewall_policy_status_for_file "$FIREWALL_POLICY_FILE")"

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
    add_failure "manifest request summary does not match status report and request package"
  fi
fi

if (( ${#failures[@]} > 0 )); then
  printf '[production-exposure-handoff] failed\n' >&2
  for failure in "${failures[@]}"; do
    printf -- '- %s\n' "$failure" >&2
  done
  exit 1
fi

printf '[production-exposure-handoff] ok\n'
