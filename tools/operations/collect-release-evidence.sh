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
PERF_DIR="${FSUSBLOG_PERF_EVIDENCE_DIR:-$ROOT_DIR/.tmp/perf}"
FAULT_DIR="${FSUSBLOG_FAULT_EVIDENCE_DIR:-$ROOT_DIR/.tmp/fault-injection}"
SOAK_DIR="${FSUSBLOG_SOAK_EVIDENCE_DIR:-$ROOT_DIR/.tmp/soak}"
FUZZ_DIR="${FSUSBLOG_FUZZ_EVIDENCE_DIR:-$ROOT_DIR/.tmp/fuzz}"
mkdir -p "$OUT_DIR"

restore_downloaded_artifacts() {
  local downloaded_dir="$ROOT_DIR/.tmp/downloaded-artifacts"
  local artifact_dir name
  [[ -d "$downloaded_dir" ]] || return 0

  for artifact_dir in "$downloaded_dir"/*; do
    [[ -d "$artifact_dir" ]] || continue
    for name in gate-logs release-evidence docs frontend ux perf security coverage fault-injection fuzz soak operations; do
      if [[ -d "$artifact_dir/$name" ]]; then
        mkdir -p "$ROOT_DIR/.tmp/$name"
        cp -a "$artifact_dir/$name/." "$ROOT_DIR/.tmp/$name/"
      fi
    done
  done
}

restore_downloaded_artifacts

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

zap_status_or_missing() {
  local dir="$1"
  if [[ ! -d "$dir" ]]; then
    printf 'missing'
    return
  fi

  if find "$dir" -type f -name '*.json' -print -quit | grep -q .; then
    printf 'ok'
    return
  fi

  printf 'invalid'
}

blockers_json_or_empty() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    printf '[]'
    return
  fi

  jq -c '.blockers // []' "$file" 2>/dev/null || printf '[]'
}

slo_critical_count_or_zero() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    printf '0'
    return
  fi

  jq -r '[.alerts[]? | select(.severity == "critical" and ((.status // "firing") == "firing"))] | length' "$file" 2>/dev/null || printf '0'
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
            and .requiredForCloseout == true)
          or (.name == "complete-returned-handoff"
            and .command == "tools/security/complete-production-exposure-from-returned-handoff-bundle.sh <handoff-dir-or-tar.gz>"
            and .requiredForCloseout == true)
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

runtime_tuning_json() {
  jq -n \
    --arg readyToRun "${DOTNET_ReadyToRun:-}" \
    --arg quickJitForLoops "${DOTNET_TC_QuickJitForLoops:-}" \
    --arg tieredPgo "${DOTNET_TieredPGO:-}" \
    --arg minWorkerThreads "${FSUSBLOG_RUNTIME_THREADPOOL_MIN_WORKER_THREADS:-}" \
    --arg minCompletionPortThreads "${FSUSBLOG_RUNTIME_THREADPOOL_MIN_COMPLETION_PORT_THREADS:-}" \
    --arg benchmarkEvidence "$PERF_ARTIFACT" '
    {
      readyToRun: (if $readyToRun == "" then null else $readyToRun end),
      quickJitForLoops: (if $quickJitForLoops == "" then null else $quickJitForLoops end),
      tieredPgo: (if $tieredPgo == "" then null else $tieredPgo end),
      threadPool: {
        minWorkerThreads: (if $minWorkerThreads == "" then null else $minWorkerThreads end),
        minCompletionPortThreads: (if $minCompletionPortThreads == "" then null else $minCompletionPortThreads end)
      },
      benchmarkEvidence: (if $benchmarkEvidence == "null" then null else $benchmarkEvidence end),
      nonDefaultPresetsRequireBenchmarkEvidence: true,
      rollback: "unset RuntimeTuning/DOTNET_* overrides and restart on the same image"
    }'
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
SUPPLY_CHAIN="$(copy_if_present "$SECURITY_DIR/supply-chain" supply-chain)"
SBOM="$(copy_if_present "$SECURITY_DIR/sbom" sbom)"
SECURITY_MATRICES="$(copy_if_present "$ROOT_DIR/security" security-matrices)"
RESTORE_DRILL="$(copy_if_present "$OPERATIONS_DIR/backup-restore-drill.json" backup-restore-drill.json)"
SMOKE="$(copy_if_present "$OPERATIONS_DIR/post-deploy-smoke.json" post-deploy-smoke.json)"
SLO_ALERTS="$(copy_if_present "$OPERATIONS_DIR/slo-alert-fixture.json" slo-alert-fixture.json)"
RETENTION_CLEANUP="$(copy_if_present "$OPERATIONS_DIR/retention-cleanup.json" retention-cleanup.json)"
COVERAGE_ARTIFACT="$(copy_if_present "$COVERAGE_DIR" coverage)"
PERF_ARTIFACT="$(copy_if_present "$PERF_DIR" perf)"
TEST_PLAN_ARTIFACT="$(copy_if_present "$ROOT_DIR/.tmp/release-evidence/test-plan.json" test-plan.json)"
ENDPOINT_DEPTH_SUMMARY="$(copy_if_present "$ROOT_DIR/.tmp/release-evidence/endpoint-depth-summary.json" endpoint-depth-summary.json)"
DATA_SCALE_SUMMARY="$(copy_if_present "$ROOT_DIR/.tmp/release-evidence/data-scale-summary.json" data-scale-summary.json)"
PERF_SUMMARY_ARTIFACT="$(copy_if_present "$ROOT_DIR/.tmp/release-evidence/perf-summary.json" perf-summary.json)"
SECURITY_DEPTH_SUMMARY="$(copy_if_present "$ROOT_DIR/.tmp/release-evidence/security-depth-summary.json" security-depth-summary.json)"
FUZZ_SEEDS_SUMMARY="$(copy_if_present "$ROOT_DIR/.tmp/release-evidence/fuzz-seeds.json" fuzz-seeds.json)"
BUSINESS_STATE_SUMMARY="$(copy_if_present "$ROOT_DIR/.tmp/release-evidence/playwright-business-state-summary.json" playwright-business-state-summary.json)"
AOT_CACHE_RESILIENCE_SUMMARY="$(copy_if_present "$ROOT_DIR/.tmp/release-evidence/aot-cache-resilience-summary.json" aot-cache-resilience-summary.json)"
HYDRATION_LONG_SMOKE_SUMMARY="$(copy_if_present "$ROOT_DIR/.tmp/release-evidence/hydration-long-smoke-summary.json" hydration-long-smoke-summary.json)"
UX_ARTIFACT="$(copy_if_present "$ROOT_DIR/.tmp/ux" ux)"
UX_VIEWPORT_SUMMARY="$(copy_if_present "$ROOT_DIR/.tmp/release-evidence/ux-viewport-summary.json" ux-viewport-summary.json)"
FRONTEND_RENDER_PRESSURE_SUMMARY="$(copy_if_present "$ROOT_DIR/.tmp/release-evidence/frontend-render-pressure-summary.json" frontend-render-pressure-summary.json)"
BACKEND_QPS_SUMMARY="$(copy_if_present "$ROOT_DIR/.tmp/release-evidence/backend-qps-summary.json" backend-qps-summary.json)"
DOC_SYNC_SUMMARY="$(copy_if_present "$ROOT_DIR/.tmp/release-evidence/doc-sync-summary.json" doc-sync-summary.json)"
DOM_BUDGET_SUMMARY="$(copy_if_present "$ROOT_DIR/.tmp/frontend/dom-budget.json" dom-budget.json)"
ROUTE_RENDER_PRESSURE_SUMMARY="$(copy_if_present "$ROOT_DIR/.tmp/frontend/route-render-pressure.json" route-render-pressure.json)"
MARKDOWN_RENDER_BUDGET_SUMMARY="$(copy_if_present "$ROOT_DIR/.tmp/frontend/markdown-render-budget.json" markdown-render-budget.json)"
DOM_DEPTH_STATIC_SUMMARY="$(copy_if_present "$ROOT_DIR/.tmp/frontend/dom-depth-static.json" dom-depth-static.json)"
FAULT_ARTIFACT="$(copy_if_present "$FAULT_DIR" fault-injection)"
SOAK_ARTIFACT="$(copy_if_present "$SOAK_DIR" soak)"
FUZZ_ARTIFACT="$(copy_if_present "$FUZZ_DIR" fuzz)"
AUTHENTICATED_DAST="$(copy_if_present "$SECURITY_DIR/authenticated-dast" authenticated-dast)"
GATE_LOGS="$(copy_if_present "$GATE_LOG_DIR" gate-logs)"
VISUAL_GATE_SKIP="$(copy_if_present "$GATE_LOG_DIR/visual-gate-skip.json" visual-gate-skip.json)"
RUNTIME_TUNING_SUMMARY="$(runtime_tuning_json)"

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
SUPPLY_CHAIN_STATUS_VALUE="$(json_status_or_missing "$SECURITY_DIR/supply-chain/summary.json")"
SBOM_STATUS_VALUE="$(json_status_or_missing "$SECURITY_DIR/sbom/summary.json")"
BACKUP_RESTORE_STATUS_VALUE="$(json_status_or_missing "$OPERATIONS_DIR/backup-restore-drill.json")"
POST_DEPLOY_SMOKE_STATUS_VALUE="$(json_status_or_missing "$OPERATIONS_DIR/post-deploy-smoke.json")"
SLO_STATUS_VALUE="$(json_status_or_missing "$OPERATIONS_DIR/slo-alert-fixture.json")"
SLO_CRITICAL_COUNT="$(slo_critical_count_or_zero "$OPERATIONS_DIR/slo-alert-fixture.json")"
RETENTION_STATUS_VALUE="$(json_status_or_missing "$OPERATIONS_DIR/retention-cleanup.json")"
IMAGE_DIGEST_VALUE="${FSUSBLOG_IMAGE_DIGEST:-unknown}"
IMAGE_DIGEST_STATUS="$([[ "$IMAGE_DIGEST_VALUE" == "unknown" || -z "$IMAGE_DIGEST_VALUE" ]] && printf 'missing' || printf 'present')"
EXTERNAL_BLOCKERS="$(blockers_json_or_empty "$SECURITY_DIR/production-exposure-status.json")"
REQUEST_SUMMARY="$(request_summary_json)"
COVERAGE_SUMMARY="$(coverage_summary_json)"
COVERAGE_STATUS_VALUE="$(jq -r '.status // "missing"' <<<"$COVERAGE_SUMMARY" 2>/dev/null || printf 'invalid')"
ZAP_STATUS_VALUE="$(zap_status_or_missing "$SECURITY_DIR/zap")"
FAULT_STATUS_VALUE="$(json_status_or_missing "$FAULT_DIR/summary.json")"
AUTHENTICATED_DAST_STATUS_VALUE="$(json_status_or_missing "$SECURITY_DIR/authenticated-dast/summary.json")"
WASM_FUZZ_STATUS_VALUE="$(json_status_or_missing "$FUZZ_DIR/wasm/summary.json")"
UX_VIEWPORT_STATUS_VALUE="$(json_status_or_missing "$ROOT_DIR/.tmp/release-evidence/ux-viewport-summary.json")"
FRONTEND_RENDER_PRESSURE_STATUS_VALUE="$(json_status_or_missing "$ROOT_DIR/.tmp/release-evidence/frontend-render-pressure-summary.json")"
BACKEND_QPS_STATUS_VALUE="$(json_status_or_missing "$ROOT_DIR/.tmp/release-evidence/backend-qps-summary.json")"
DOC_SYNC_STATUS_VALUE="$(json_status_or_missing "$ROOT_DIR/.tmp/release-evidence/doc-sync-summary.json")"

MANIFEST_STATUS="collected-ok"
if [[ "$PRODUCTION_STATUS_VALUE" != "ok" \
  || "$LIVE_STATUS_VALUE" != "ok" \
  || "$DNS_READY_STATUS_VALUE" != "ok" \
  || "$DNS_DELEGATION_STATUS_VALUE" != "ok" \
  || "$FIREWALL_POLICY_STATUS_VALUE" != "present" \
  || "$ATTACK_MATRIX_STATUS_VALUE" != "ok" \
  || "$PERMISSION_MATRIX_STATUS_VALUE" != "ok" \
  || "$ZAP_STATUS_VALUE" != "ok" \
  || "$SUPPLY_CHAIN_STATUS_VALUE" != "ok" \
  || "$SBOM_STATUS_VALUE" != "ok" \
  || "$COVERAGE_STATUS_VALUE" != "ok" \
  || "$BACKUP_RESTORE_STATUS_VALUE" != "ok" \
  || "$POST_DEPLOY_SMOKE_STATUS_VALUE" != "ok" \
  || "$SLO_STATUS_VALUE" != "ok" \
  || "$SLO_CRITICAL_COUNT" != "0" \
  || "$FRONTEND_RENDER_PRESSURE_STATUS_VALUE" != "ok" \
  || "$BACKEND_QPS_STATUS_VALUE" != "ok" \
  || "$DOC_SYNC_STATUS_VALUE" != "ok" \
  || "$IMAGE_DIGEST_STATUS" != "present" ]]; then
  MANIFEST_STATUS="collected-blocked"
fi

cat > "$OUT_DIR/manifest.json" <<JSON
{
  "status": "$MANIFEST_STATUS",
  "releaseStamp": "$STAMP",
  "generatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "gitRevision": "$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)",
  "commitSha": "$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || echo unknown)",
  "workflowRun": {
    "id": "${GITHUB_RUN_ID:-unknown}",
    "attempt": "${GITHUB_RUN_ATTEMPT:-unknown}",
    "workflow": "${GITHUB_WORKFLOW:-unknown}"
  },
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
    "supplyChain": $SUPPLY_CHAIN,
    "sbom": $SBOM,
    "securityMatrices": $SECURITY_MATRICES,
    "backupRestoreDrill": $RESTORE_DRILL,
    "postDeploySmoke": $SMOKE,
    "sloAlerts": $SLO_ALERTS,
    "retentionCleanup": $RETENTION_CLEANUP,
    "coverage": $COVERAGE_ARTIFACT,
    "perf": $PERF_ARTIFACT,
    "testPlan": $TEST_PLAN_ARTIFACT,
    "endpointDepthSummary": $ENDPOINT_DEPTH_SUMMARY,
    "dataScaleSummary": $DATA_SCALE_SUMMARY,
    "perfSummary": $PERF_SUMMARY_ARTIFACT,
    "securityDepthSummary": $SECURITY_DEPTH_SUMMARY,
    "fuzzSeeds": $FUZZ_SEEDS_SUMMARY,
    "playwrightBusinessStateSummary": $BUSINESS_STATE_SUMMARY,
    "aotCacheResilienceSummary": $AOT_CACHE_RESILIENCE_SUMMARY,
    "hydrationLongSmokeSummary": $HYDRATION_LONG_SMOKE_SUMMARY,
    "ux": $UX_ARTIFACT,
    "uxViewportSummary": $UX_VIEWPORT_SUMMARY,
    "frontendRenderPressureSummary": $FRONTEND_RENDER_PRESSURE_SUMMARY,
    "backendQpsSummary": $BACKEND_QPS_SUMMARY,
    "docSyncSummary": $DOC_SYNC_SUMMARY,
    "domBudgetSummary": $DOM_BUDGET_SUMMARY,
    "routeRenderPressureSummary": $ROUTE_RENDER_PRESSURE_SUMMARY,
    "markdownRenderBudgetSummary": $MARKDOWN_RENDER_BUDGET_SUMMARY,
    "domDepthStaticSummary": $DOM_DEPTH_STATIC_SUMMARY,
    "faultInjection": $FAULT_ARTIFACT,
    "soak": $SOAK_ARTIFACT,
    "fuzz": $FUZZ_ARTIFACT,
    "authenticatedDast": $AUTHENTICATED_DAST,
    "visualGateSkip": $VISUAL_GATE_SKIP,
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
      "sloCriticalFiring": $SLO_CRITICAL_COUNT,
      "retentionCleanup": "$RETENTION_STATUS_VALUE",
      "runtimeTuning": $RUNTIME_TUNING_SUMMARY
    },
    "gates": {
      "visualGateSkip": $VISUAL_GATE_SKIP,
      "uxViewport": "$UX_VIEWPORT_STATUS_VALUE",
      "frontendRenderPressure": "$FRONTEND_RENDER_PRESSURE_STATUS_VALUE",
      "backendQps": "$BACKEND_QPS_STATUS_VALUE",
      "docSync": "$DOC_SYNC_STATUS_VALUE"
    },
    "security": {
      "attackMatrix": "$ATTACK_MATRIX_STATUS_VALUE",
      "permissionMatrix": "$PERMISSION_MATRIX_STATUS_VALUE",
      "supplyChain": "$SUPPLY_CHAIN_STATUS_VALUE",
      "sbom": "$SBOM_STATUS_VALUE",
      "dastZap": "$ZAP_STATUS_VALUE",
      "authenticatedDast": "$AUTHENTICATED_DAST_STATUS_VALUE",
      "wasmFuzz": "$WASM_FUZZ_STATUS_VALUE"
    },
    "resilienceDepth": {
      "faultInjection": "$FAULT_STATUS_VALUE",
      "soak": $SOAK_ARTIFACT
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
    { "kind": "authenticated-dast", "artifact": $AUTHENTICATED_DAST },
    { "kind": "wasm-fuzz", "artifact": $FUZZ_ARTIFACT },
    { "kind": "supply-chain", "artifact": $SUPPLY_CHAIN },
    { "kind": "sbom", "artifact": $SBOM },
    { "kind": "security-matrices", "artifact": $SECURITY_MATRICES },
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
