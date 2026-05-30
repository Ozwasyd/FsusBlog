#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAMP="${FSUSBLOG_RELEASE_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
OUT_DIR="${FSUSBLOG_RELEASE_EVIDENCE_DIR:-$ROOT_DIR/.tmp/release-evidence/$STAMP}"
SECURITY_DIR="${FSUSBLOG_SECURITY_EVIDENCE_SOURCE_DIR:-$ROOT_DIR/.tmp/security}"
OPERATIONS_DIR="${FSUSBLOG_OPERATIONS_EVIDENCE_SOURCE_DIR:-$ROOT_DIR/.tmp/operations}"
COVERAGE_DIR="${FSUSBLOG_COVERAGE_EVIDENCE_DIR:-$ROOT_DIR/artifacts/coverage}"
if [[ ! -d "$COVERAGE_DIR" && -d "$ROOT_DIR/.tmp/coverage" ]]; then
  COVERAGE_DIR="$ROOT_DIR/.tmp/coverage"
fi
GATE_LOG_DIR="${FSUSBLOG_GATE_LOG_SOURCE_DIR:-$ROOT_DIR/.tmp/gate-logs}"
mkdir -p "$OUT_DIR"

copy_if_present() {
  local src="$1"
  local name="$2"
  if [[ -e "$src" ]]; then
    cp -a "$src" "$OUT_DIR/$name"
    printf '"%s"' "$name"
  else
    printf 'null'
  fi
}

artifact_digest_json() {
  local artifact_json="$1"
  local artifact path digest

  artifact="$(jq -r '.' <<<"$artifact_json" 2>/dev/null || true)"
  if [[ -z "$artifact" || "$artifact" == "null" ]]; then
    printf 'null'
    return
  fi

  path="$OUT_DIR/$artifact"
  if [[ ! -f "$path" ]]; then
    printf 'null'
    return
  fi

  digest="$(sha256sum "$path" | awk '{print $1}')"
  jq -n --arg digest "$digest" '{
    algorithm: "sha256",
    value: $digest
  }'
}

json_status_or_missing() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    printf 'missing'
    return
  fi

  jq -r '.status // "present"' "$file" 2>/dev/null || printf 'invalid'
}

result_status_or_missing() {
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

blockers_json_or_empty() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    printf '[]'
    return
  fi

  jq -c '.blockers // []' "$file" 2>/dev/null || printf '[]'
}

request_summary_json() {
  local file="$SECURITY_DIR/production-exposure-evidence-request.json"
  if [[ ! -f "$file" ]]; then
    jq -n '{status: "missing", currentStatus: null, blockerSources: [], nextActionSources: [], nextActionCount: 0, unblockPlanSources: [], unblockPlanCount: 0, requiredHosts: [], delegationDomains: [], requiredEvidenceKeys: [], requiredEvidenceCount: 0, firewallSourceSha256Required: false, rawSourceSha256Required: false, handoffCheckCount: 0, verificationCommandNames: [], verificationCommandCount: 0, returnedCloseoutCommandCount: 0, closeoutCommands: {finalCloseout: null, returnedEvidenceVerifier: null, returnedEvidenceCloseout: null, returnedHandoffCloseout: null, releaseEvidence: null}}'
    return
  fi

  jq -c '
  def returned_closeout_command_count:
    [
      .verificationCommands[]?
      | select(
          (.name == "verify-returned-evidence"
            and .command == "tools/security/verify-production-exposure-returned-evidence.sh <returned-evidence-dir>"
            and .requiredBeforeReturnedCloseout == true)
          or (.name == "complete-returned-evidence"
            and .command == "tools/security/complete-production-exposure-from-returned-evidence.sh <returned-evidence-dir>"
            and .closesTodoWhenPassing == true)
          or (.name == "complete-returned-handoff"
            and .command == "tools/security/complete-production-exposure-from-returned-handoff-bundle.sh <handoff-dir-or-tar.gz>"
            and .closesTodoWhenPassing == true)
        )
    ] | length;
  {
    status: (.status // "present"),
    currentStatus: (.currentStatus.status // null),
    blockerCount: (.currentStatus.blockerCount // (.currentStatus.blockers // [] | length) // 0),
	    blockerSources: (.currentStatus.blockerSources // []),
	    nextActionSources: (.nextActions // [] | map(.source)),
	    nextActionCount: (.nextActions // [] | length),
	    unblockPlanSources: (.unblockPlan // [] | map(.source)),
	    unblockPlanCount: (.unblockPlan // [] | length),
	    requiredHosts: (.requiredHosts // []),
    delegationDomains: (.delegationDomains // []),
    requiredEvidenceKeys: (.requiredEvidence // [] | map(.key)),
    requiredEvidenceCount: (.requiredEvidence // [] | length),
    firewallSourceSha256Required: any(.requiredEvidence[]?; .key == "firewallPolicy" and .sourceSha256Required == true),
    rawSourceSha256Required: (.firewallPolicyRequirements.rawSourceSha256Required == true),
    handoffCheckCount: (.handoffChecks // [] | length),
    verificationCommandNames: (.verificationCommands // [] | map(.name)),
    verificationCommandCount: (.verificationCommands // [] | length),
    returnedCloseoutCommandCount: returned_closeout_command_count,
    closeoutCommands: {
      finalCloseout: (.finalCloseoutCommand // null),
      returnedEvidenceVerifier: (.returnedEvidenceVerifierCommand // null),
      returnedEvidenceCloseout: (.returnedEvidenceCloseoutCommand // null),
      returnedHandoffCloseout: (.returnedHandoffCloseoutCommand // null),
      releaseEvidence: (.releaseEvidenceCommand // null)
    }
	  }' "$file" 2>/dev/null || jq -n '{status: "invalid", currentStatus: null, blockerSources: [], nextActionSources: [], nextActionCount: 0, unblockPlanSources: [], unblockPlanCount: 0, requiredHosts: [], delegationDomains: [], requiredEvidenceKeys: [], requiredEvidenceCount: 0, firewallSourceSha256Required: false, rawSourceSha256Required: false, handoffCheckCount: 0, verificationCommandNames: [], verificationCommandCount: 0, returnedCloseoutCommandCount: 0, closeoutCommands: {finalCloseout: null, returnedEvidenceVerifier: null, returnedEvidenceCloseout: null, returnedHandoffCloseout: null, releaseEvidence: null}}'
}

coverage_summary_json() {
  local merged="$COVERAGE_DIR/merged/Summary.json"
  local backend="$COVERAGE_DIR/backend-merged/Summary.json"

  if [[ ! -f "$merged" && ! -f "$backend" ]]; then
    jq -n '{status: "missing", merged: null, backend: null}'
    return
  fi

  jq -n \
    --slurpfile merged "$merged" \
    --slurpfile backend "$backend" '
      def summary($value):
        if ($value | length) == 0 then null
        else {
          linecoverage: $value[0].summary.linecoverage,
          branchcoverage: $value[0].summary.branchcoverage,
          methodcoverage: $value[0].summary.methodcoverage,
          assemblies: $value[0].summary.assemblies,
          classes: $value[0].summary.classes,
          files: $value[0].summary.files
        } end;

      (summary($merged)) as $mergedSummary
      | (summary($backend)) as $backendSummary
      | {
          status: (
            if ($mergedSummary == null or $backendSummary == null) then "partial"
            elif ($mergedSummary.linecoverage == 100 and $mergedSummary.branchcoverage == 100 and $mergedSummary.methodcoverage == 100
              and $backendSummary.linecoverage == 100 and $backendSummary.branchcoverage == 100 and $backendSummary.methodcoverage == 100) then "ok"
            else "blocked" end
          ),
          merged: $mergedSummary,
          backend: $backendSummary
        }
    ' 2>/dev/null || jq -n '{status: "invalid", merged: null, backend: null}'
}

PRODUCTION_STATUS="$(copy_if_present "$SECURITY_DIR/production-exposure-status.json" production-exposure-status.json)"
PRODUCTION_REQUEST="$(copy_if_present "$SECURITY_DIR/production-exposure-evidence-request.json" production-exposure-evidence-request.json)"
PRODUCTION_LIVE="$(copy_if_present "$SECURITY_DIR/production-exposure-live.json" production-exposure-live.json)"
FIREWALL_POLICY="$(copy_if_present "$SECURITY_DIR/production-firewall-policy.json" production-firewall-policy.json)"
DNS_READY="$(copy_if_present "$SECURITY_DIR/production-dns-readiness.json" production-dns-readiness.json)"
DNS_DELEGATION="$(copy_if_present "$SECURITY_DIR/production-dns-delegation.json" production-dns-delegation.json)"
ATTACK_MATRIX="$(copy_if_present "$SECURITY_DIR/attack-matrix.json" attack-matrix.json)"
PERMISSION_MATRIX="$(copy_if_present "$SECURITY_DIR/permission-matrix.json" permission-matrix.json)"
ZAP="$(copy_if_present "$SECURITY_DIR/zap" zap)"
RESTORE_DRILL="$(copy_if_present "$OPERATIONS_DIR/backup-restore-drill.json" backup-restore-drill.json)"
SMOKE="$(copy_if_present "$OPERATIONS_DIR/post-deploy-smoke.json" post-deploy-smoke.json)"
SLO_ALERTS="$(copy_if_present "$OPERATIONS_DIR/slo-alert-fixture.json" slo-alert-fixture.json)"
RETENTION_CLEANUP="$(copy_if_present "$OPERATIONS_DIR/retention-cleanup.json" retention-cleanup.json)"
COVERAGE_ARTIFACT="$(copy_if_present "$COVERAGE_DIR" coverage)"
GATE_LOGS="$(copy_if_present "$GATE_LOG_DIR" gate-logs)"

PRODUCTION_STATUS_DIGEST="$(artifact_digest_json "$PRODUCTION_STATUS")"
PRODUCTION_REQUEST_DIGEST="$(artifact_digest_json "$PRODUCTION_REQUEST")"
PRODUCTION_LIVE_DIGEST="$(artifact_digest_json "$PRODUCTION_LIVE")"
FIREWALL_POLICY_DIGEST="$(artifact_digest_json "$FIREWALL_POLICY")"
DNS_READY_DIGEST="$(artifact_digest_json "$DNS_READY")"
DNS_DELEGATION_DIGEST="$(artifact_digest_json "$DNS_DELEGATION")"

PRODUCTION_STATUS_VALUE="$(json_status_or_missing "$SECURITY_DIR/production-exposure-status.json")"
LIVE_STATUS_VALUE="$(result_status_or_missing "$SECURITY_DIR/production-exposure-live.json")"
DNS_READY_STATUS_VALUE="$(result_status_or_missing "$SECURITY_DIR/production-dns-readiness.json")"
DNS_DELEGATION_STATUS_VALUE="$(result_status_or_missing "$SECURITY_DIR/production-dns-delegation.json")"
FIREWALL_POLICY_STATUS_VALUE="$([[ "$FIREWALL_POLICY" == "null" ]] && printf 'missing' || printf 'present')"
ATTACK_MATRIX_STATUS_VALUE="$(json_status_or_missing "$SECURITY_DIR/attack-matrix.json")"
PERMISSION_MATRIX_STATUS_VALUE="$(json_status_or_missing "$SECURITY_DIR/permission-matrix.json")"
BACKUP_RESTORE_STATUS_VALUE="$(json_status_or_missing "$OPERATIONS_DIR/backup-restore-drill.json")"
POST_DEPLOY_SMOKE_STATUS_VALUE="$(json_status_or_missing "$OPERATIONS_DIR/post-deploy-smoke.json")"
SLO_STATUS_VALUE="$(json_status_or_missing "$OPERATIONS_DIR/slo-alert-fixture.json")"
RETENTION_STATUS_VALUE="$(json_status_or_missing "$OPERATIONS_DIR/retention-cleanup.json")"
IMAGE_DIGEST_VALUE="${FSUSBLOG_IMAGE_DIGEST:-unknown}"
IMAGE_DIGEST_STATUS="$([[ "$IMAGE_DIGEST_VALUE" == "unknown" || -z "$IMAGE_DIGEST_VALUE" ]] && printf 'missing' || printf 'present')"
EXTERNAL_BLOCKERS="$(blockers_json_or_empty "$SECURITY_DIR/production-exposure-status.json")"
REQUEST_SUMMARY="$(request_summary_json)"
COVERAGE_SUMMARY="$(coverage_summary_json)"

MANIFEST_STATUS="collected-ok"
if [[ "$PRODUCTION_STATUS_VALUE" != "ok" \
  || "$LIVE_STATUS_VALUE" != "ok" \
  || "$DNS_READY_STATUS_VALUE" != "ok" \
  || "$DNS_DELEGATION_STATUS_VALUE" != "ok" \
  || "$FIREWALL_POLICY_STATUS_VALUE" != "present" \
  || "$ATTACK_MATRIX_STATUS_VALUE" != "ok" \
  || "$PERMISSION_MATRIX_STATUS_VALUE" != "ok" \
  || "$BACKUP_RESTORE_STATUS_VALUE" != "ok" \
  || "$POST_DEPLOY_SMOKE_STATUS_VALUE" != "ok" \
  || "$IMAGE_DIGEST_STATUS" != "present" ]]; then
  MANIFEST_STATUS="collected-blocked"
fi

cat > "$OUT_DIR/manifest.json" <<JSON
{
  "status": "$MANIFEST_STATUS",
  "releaseStamp": "$STAMP",
  "generatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "gitRevision": "$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)",
  "imageDigest": "$IMAGE_DIGEST_VALUE",
  "artifacts": {
    "productionExposureStatus": $PRODUCTION_STATUS,
    "productionExposureRequest": $PRODUCTION_REQUEST,
    "productionExposureLive": $PRODUCTION_LIVE,
    "firewallPolicy": $FIREWALL_POLICY,
    "dnsReadiness": $DNS_READY,
    "dnsDelegation": $DNS_DELEGATION,
    "attackMatrix": $ATTACK_MATRIX,
    "permissionMatrix": $PERMISSION_MATRIX,
    "dastZap": $ZAP,
    "backupRestoreDrill": $RESTORE_DRILL,
    "postDeploySmoke": $SMOKE,
    "sloAlerts": $SLO_ALERTS,
    "retentionCleanup": $RETENTION_CLEANUP,
    "coverage": $COVERAGE_ARTIFACT,
    "gateLogs": $GATE_LOGS,
    "securitySourceDir": "$(realpath --relative-to="$OUT_DIR" "$SECURITY_DIR" 2>/dev/null || true)"
  },
  "artifactDigests": {
    "productionExposureStatus": $PRODUCTION_STATUS_DIGEST,
    "productionExposureRequest": $PRODUCTION_REQUEST_DIGEST,
    "productionExposureLive": $PRODUCTION_LIVE_DIGEST,
    "firewallPolicy": $FIREWALL_POLICY_DIGEST,
    "dnsReadiness": $DNS_READY_DIGEST,
    "dnsDelegation": $DNS_DELEGATION_DIGEST
  },
  "evidenceSummary": {
    "image": {
      "digest": "$IMAGE_DIGEST_VALUE",
      "status": "$IMAGE_DIGEST_STATUS"
    },
    "coverage": $COVERAGE_SUMMARY,
    "operations": {
      "backupRestoreDrill": "$BACKUP_RESTORE_STATUS_VALUE",
      "postDeploySmoke": "$POST_DEPLOY_SMOKE_STATUS_VALUE",
      "sloAlerts": "$SLO_STATUS_VALUE",
      "retentionCleanup": "$RETENTION_STATUS_VALUE"
    },
    "security": {
      "attackMatrix": "$ATTACK_MATRIX_STATUS_VALUE",
      "permissionMatrix": "$PERMISSION_MATRIX_STATUS_VALUE",
      "dastZap": $ZAP
    },
    "externalExposure": {
      "status": "$PRODUCTION_STATUS_VALUE",
      "valid": $([[ "$PRODUCTION_STATUS_VALUE" == "ok" ]] && printf true || printf false),
      "firewallPolicy": "$FIREWALL_POLICY_STATUS_VALUE",
      "dnsReadiness": "$DNS_READY_STATUS_VALUE",
      "dnsDelegation": "$DNS_DELEGATION_STATUS_VALUE",
      "liveExposure": "$LIVE_STATUS_VALUE",
      "request": $REQUEST_SUMMARY,
      "blockers": $EXTERNAL_BLOCKERS
    }
  },
  "securityEvidenceIndex": [
    { "kind": "dast", "artifact": $ZAP },
    { "kind": "attack-matrix", "artifact": $ATTACK_MATRIX },
    { "kind": "permission-matrix", "artifact": $PERMISSION_MATRIX },
    { "kind": "production-exposure-status", "artifact": $PRODUCTION_STATUS },
    { "kind": "production-exposure-request", "artifact": $PRODUCTION_REQUEST },
    { "kind": "firewall-policy", "artifact": $FIREWALL_POLICY },
    { "kind": "dns-readiness", "artifact": $DNS_READY },
    { "kind": "dns-delegation", "artifact": $DNS_DELEGATION },
    { "kind": "live-exposure", "artifact": $PRODUCTION_LIVE }
  ]
}
JSON

echo "[release-evidence] wrote $OUT_DIR/manifest.json"
