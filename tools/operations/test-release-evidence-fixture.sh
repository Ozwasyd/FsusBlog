#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_ROOT="$(mktemp -d)"
RESTORE_DIR="$TMP_ROOT/restore"
TRACKED_TMP_FILES=(
  ".tmp/release-evidence/frontend-render-pressure-summary.json"
  ".tmp/release-evidence/doc-sync-summary.json"
  ".tmp/release-evidence/backend-qps-summary.json"
  ".tmp/release-evidence/public-hydration-detector-summary.json"
  ".tmp/release-evidence/public-hydration-clock-matrix-summary.json"
  ".tmp/release-evidence/public-hydration-browser-env-summary.json"
  ".tmp/release-evidence/public-hydration-payload-fixture-summary.json"
  ".tmp/frontend/dom-budget.json"
  ".tmp/frontend/route-render-pressure.json"
  ".tmp/frontend/markdown-render-budget.json"
  ".tmp/frontend/dom-depth-static.json"
)

preserve_tracked_tmp_files() {
  local relative
  for relative in "${TRACKED_TMP_FILES[@]}"; do
    if [[ -f "$ROOT_DIR/$relative" ]]; then
      mkdir -p "$RESTORE_DIR/$(dirname "$relative")"
      cp "$ROOT_DIR/$relative" "$RESTORE_DIR/$relative"
    else
      mkdir -p "$RESTORE_DIR/$(dirname "$relative")"
      touch "$RESTORE_DIR/$relative.__missing"
    fi
  done
}

restore_tracked_tmp_files() {
  local relative
  for relative in "${TRACKED_TMP_FILES[@]}"; do
    if [[ -f "$RESTORE_DIR/$relative" ]]; then
      mkdir -p "$(dirname "$ROOT_DIR/$relative")"
      cp "$RESTORE_DIR/$relative" "$ROOT_DIR/$relative"
    elif [[ -f "$RESTORE_DIR/$relative.__missing" ]]; then
      rm -f "$ROOT_DIR/$relative"
    fi
  done
  rm -rf "$TMP_ROOT"
}

trap restore_tracked_tmp_files EXIT
preserve_tracked_tmp_files

SECURITY_DIR="$TMP_ROOT/security"
OPERATIONS_DIR="$TMP_ROOT/operations"
COVERAGE_DIR="$TMP_ROOT/coverage"
OUT_DIR="$TMP_ROOT/release-evidence"
PERF_DIR="$TMP_ROOT/perf"
GATE_LOG_DIR="$TMP_ROOT/gate-logs"
FAULT_DIR="$TMP_ROOT/fault-injection"
SOAK_DIR="$TMP_ROOT/soak"
FUZZ_DIR="$TMP_ROOT/fuzz"
mkdir -p "$SECURITY_DIR/zap/run-1" "$SECURITY_DIR/supply-chain" "$SECURITY_DIR/sbom" "$OPERATIONS_DIR" "$COVERAGE_DIR/merged" "$COVERAGE_DIR/backend-merged" "$PERF_DIR" "$GATE_LOG_DIR"

printf '{"status":"blocked","requiredHosts":["fsus.blog"],"delegationDomains":["fsus.blog"],"blockers":[{"source":"fixture","message":"synthetic"}]}\n' > "$SECURITY_DIR/production-exposure-status.json"
jq -n \
  --arg firewallPolicy "$SECURITY_DIR/production-firewall-policy.json" \
  --arg dnsReadiness "$SECURITY_DIR/production-dns-readiness.json" \
  --arg dnsDelegation "$SECURITY_DIR/production-dns-delegation.json" \
  --arg liveExposure "$SECURITY_DIR/production-exposure-live.json" \
  --arg statusReport "$SECURITY_DIR/production-exposure-status.json" '{
  status: "awaiting-external-evidence",
  requiredHosts: ["fsus.blog"],
  delegationDomains: ["fsus.blog"],
  evidenceFiles: {
    firewallPolicy: $firewallPolicy,
    dnsReadiness: $dnsReadiness,
    dnsDelegation: $dnsDelegation,
    liveExposure: $liveExposure,
    statusReport: $statusReport
  },
  requiredEvidence: [
    {
      key: "firewallPolicy",
      source: "firewall-policy",
      path: $firewallPolicy,
      artifactName: "production-firewall-policy.json",
      requiredForCloseout: true,
      sourceSha256Required: true
    },
    {
      key: "dnsReadiness",
      source: "dns-readiness",
      path: $dnsReadiness,
      artifactName: "production-dns-readiness.json",
      requiredForCloseout: true
    },
    {
      key: "dnsDelegation",
      source: "dns-delegation",
      path: $dnsDelegation,
      artifactName: "production-dns-delegation.json",
      requiredForCloseout: true
    },
    {
      key: "liveExposure",
      source: "live-evidence",
      path: $liveExposure,
      artifactName: "production-exposure-live.json",
      requiredForCloseout: true
    },
    {
      key: "statusReport",
      source: "status-report",
      path: $statusReport,
      artifactName: "production-exposure-status.json",
      requiredForCloseout: true
    }
  ],
  firewallPolicyRequirements: {
    rawSourceSha256Required: true
  },
  currentStatus: {
    status: "blocked",
    blockerCount: 1,
    blockerSources: ["fixture"],
    blockers: [
      {
        source: "fixture",
        message: "synthetic"
      }
    ]
  },
	  nextActions: [
	    {
	      source: "fixture",
	      action: "provide synthetic evidence",
	      command: "true"
	    }
	  ],
  unblockPlan: [
    {
      source: "fixture",
      blockerCount: 1,
      blockers: [
        {
          source: "fixture",
          message: "synthetic"
        }
      ],
      evidenceKeys: ["statusReport"],
      artifactNames: ["production-exposure-status.json"],
      evidenceFiles: [$statusReport],
      commands: ["true"],
      returnedEvidenceRequired: false
    }
  ],
  verificationCommands: [
    {
      name: "complete-closeout",
      command: "tools/security/complete-production-exposure-closeout.sh",
      requiredForCloseout: true
    },
    {
      name: "verify-returned-evidence",
      command: "tools/security/verify-production-exposure-returned-evidence.sh <returned-evidence-dir>",
      requiredBeforeReturnedCloseout: true
    },
    {
      name: "complete-returned-evidence",
      command: "tools/security/complete-production-exposure-from-returned-evidence.sh <returned-evidence-dir>",
      requiredForCloseout: true
    },
    {
      name: "complete-returned-handoff",
      command: "tools/security/complete-production-exposure-from-returned-handoff-bundle.sh <handoff-dir-or-tar.gz>",
      requiredForCloseout: true
    },
    {
      name: "release-evidence",
      command: "tools/operations/collect-release-evidence.sh",
      outputPattern: ".tmp/release-evidence/<timestamp>/manifest.json"
    },
    {
      name: "handoff-check",
      command: "tools/security/check-production-exposure-handoff.sh <manifest.json>",
      requiredBeforeExternalHandoff: true
    }
  ],
  handoffChecks: [
    {
      id: "request-status-manifest-alignment",
      command: "tools/security/check-production-exposure-handoff.sh <manifest.json>",
      requiredBeforeExternalHandoff: true
    }
  ],
  finalCloseoutCommand: "tools/security/complete-production-exposure-closeout.sh",
  returnedEvidenceVerifierCommand: "tools/security/verify-production-exposure-returned-evidence.sh <returned-evidence-dir>",
  returnedEvidenceCloseoutCommand: "tools/security/complete-production-exposure-from-returned-evidence.sh <returned-evidence-dir>",
  returnedHandoffCloseoutCommand: "tools/security/complete-production-exposure-from-returned-handoff-bundle.sh <handoff-dir-or-tar.gz>",
  releaseEvidenceCommand: "tools/operations/collect-release-evidence.sh"
}' > "$SECURITY_DIR/production-exposure-evidence-request.json"
printf '{"generatedAt":"2026-05-18T00:00:00Z","requiredHosts":["fsus.blog"]}\n' > "$SECURITY_DIR/production-exposure-live.json"
printf '{"generatedAt":"2026-05-18T00:00:00Z","appliesToHosts":["fsus.blog"],"evidenceSource":{"kind":"aws-security-groups","sourceFile":"fixture/aws-security-groups-ok.json","sourceSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}\n' > "$SECURITY_DIR/production-firewall-policy.json"
printf '{"generatedAt":"2026-05-18T00:00:00Z","requiredHosts":"fsus.blog"}\n' > "$SECURITY_DIR/production-dns-readiness.json"
printf '{"generatedAt":"2026-05-18T00:00:00Z","delegationDomains":"fsus.blog"}\n' > "$SECURITY_DIR/production-dns-delegation.json"
printf '{"status":"ok","checks":["synthetic-attack"]}\n' > "$SECURITY_DIR/attack-matrix.json"
printf '{"status":"ok","checks":["synthetic-permission"]}\n' > "$SECURITY_DIR/permission-matrix.json"
printf '{"site":"frontend","status":"ok"}\n' > "$SECURITY_DIR/zap/run-1/zap.json"
printf '{"status":"ok"}\n' > "$SECURITY_DIR/supply-chain/summary.json"
printf '{"status":"ok"}\n' > "$SECURITY_DIR/sbom/summary.json"
cat > "$OPERATIONS_DIR/backup-restore-drill.json" <<'JSON'
{
  "status": "ok",
  "mode": "real",
  "timings": { "rpoSeconds": 1, "rtoSeconds": 1 },
  "checks": [
    "postgres-restore:ok",
    "redis-restore:ok",
    "webroot-artifact-restore:ok",
    "restored-backend-start:ok",
    "public-page:ok",
    "binary-api:ok",
    "search-index:ok",
    "notification-stream-live:ok",
    "admin-login:ok"
  ],
  "blockers": []
}
JSON
cat > "$OPERATIONS_DIR/post-deploy-smoke.json" <<'JSON'
{
  "status": "ok",
  "dryRun": false,
  "verifiedCoverage": [
    "anonymous-public",
    "feed-rss",
    "feed-atom",
    "feed-json",
    "sitemap",
    "robots",
    "health-live",
    "health-ready"
  ],
  "manualChecklist": ["admin-login", "binary-api", "notification-stream", "upload", "passkey-mfa"],
  "manualChecklistCompleted": false,
  "blockers": []
}
JSON
printf '{"status":"ok"}\n' > "$OPERATIONS_DIR/slo-alert-fixture.json"
printf '{"status":"ok"}\n' > "$OPERATIONS_DIR/retention-cleanup.json"
printf '{"summary":{"linecoverage":80,"branchcoverage":60,"methodcoverage":95,"assemblies":1,"classes":1,"files":1},"totals":{"lines":{"covered":80,"total":100},"branches":{"covered":60,"total":100},"methods":{"covered":95,"total":100}},"sources":{"mergeMethod":"covered-over-total-weighted"}}\n' > "$COVERAGE_DIR/merged/Summary.json"
printf '{"summary":{"linecoverage":78,"branchcoverage":58,"methodcoverage":96,"assemblies":1,"classes":1,"files":1},"totals":{"lines":{"covered":78,"total":100},"branches":{"covered":58,"total":100},"methods":{"covered":96,"total":100}},"source":"backend-cobertura","reportPaths":["coverage/backend/fixture.cobertura.xml"]}\n' > "$COVERAGE_DIR/backend-merged/Summary.json"
mkdir -p "$ROOT_DIR/.tmp/frontend" "$ROOT_DIR/.tmp/release-evidence"
printf '{"status":"ok","results":[{"scenario":"fixture","status":"ok"}]}\n' > "$ROOT_DIR/.tmp/release-evidence/frontend-render-pressure-summary.json"
printf '{"status":"ok","results":[{"scenario":"fixture","status":"ok"}]}\n' > "$ROOT_DIR/.tmp/release-evidence/doc-sync-summary.json"
printf '{"schema":"fsusblog.public-hydration-detector.v1","status":"success","fatalHydrationIssueCount":0,"routesChecked":[{"route":"/","routeName":"home","stage":"home:first-visit:hydrate","browser":"chromium","viewport":{"name":"desktop","width":1440,"height":900},"status":"success"}],"warnings":[],"errors":[]}\n' > "$ROOT_DIR/.tmp/release-evidence/public-hydration-detector-summary.json"
printf '{"schema":"fsusblog.public-hydration-clock-matrix.v1","status":"success","cases":[{"id":"fixture","ssrClock":"2026-06-16T12:00:00.000Z","hydrationClock":"2026-06-16T12:01:10.000Z","serverTimeZone":"UTC","browserTimeZone":"Asia/Shanghai","locale":"zh-CN","rows":[{"kind":"ArticleDetail","timestampCase":"just-now","renderTimestamp":"2026-06-16T12:00:00.000Z","renderTimeZone":"UTC","timeNodeCount":1}]}]}\n' > "$ROOT_DIR/.tmp/release-evidence/public-hydration-clock-matrix-summary.json"
printf '{"schema":"fsusblog.public-hydration-browser-env-matrix.v1","status":"success","coverage":{"environmentCells":4,"routesChecked":12,"routesSkipped":0,"sessionStates":["anonymous","user","admin"],"themePreferences":["empty","light","dark","system"],"storageBehaviors":["normal","unavailable","cleared-after-reload"],"motionPreferences":["normal","reduced"],"colorSchemes":["light","dark"],"viewports":["desktop","tablet","mobile","narrowMobile"]},"rows":[{"routeId":"home","status":"success","environment":{"id":"fixture","sessionState":"anonymous","themePreference":"empty"}}]}\n' > "$ROOT_DIR/.tmp/release-evidence/public-hydration-browser-env-summary.json"
printf '{"schema":"fsusblog.public-hydration-payload-fixture-matrix.v1","status":"success","coverage":{"dimensions":["article-list:empty","article-body:code-blocks","filter:tag-by-name","archive:large","footer:complete","payload:duplicate-scalars-absent"],"missingDimensions":[]},"fixtures":[{"id":"fixture","status":"success","route":"/","kind":"Home","dimensions":["article-list:empty"]}]}\n' > "$ROOT_DIR/.tmp/release-evidence/public-hydration-payload-fixture-summary.json"
printf '{"status":"ok","results":[{"scenario":"fixture","status":"ok"}]}\n' > "$ROOT_DIR/.tmp/frontend/dom-budget.json"
printf '{"status":"ok","results":[{"scenario":"fixture","status":"ok"}]}\n' > "$ROOT_DIR/.tmp/frontend/route-render-pressure.json"
printf '{"status":"ok","results":[{"scenario":"fixture","status":"ok"}]}\n' > "$ROOT_DIR/.tmp/frontend/markdown-render-budget.json"
printf '{"status":"ok","results":[{"scenario":"fixture","status":"ok"}]}\n' > "$ROOT_DIR/.tmp/frontend/dom-depth-static.json"
printf '{"status":"ok","results":[{"scenario":"fixture","status":"ok"}]}\n' > "$ROOT_DIR/.tmp/release-evidence/backend-qps-summary.json"
mkdir -p "$SECURITY_DIR/authenticated-dast" "$FUZZ_DIR/wasm" "$FAULT_DIR" "$SOAK_DIR/short"
printf '{"status":"ok","activeScan":{"executed":true}}\n' > "$SECURITY_DIR/authenticated-dast/summary.json"
printf '{"status":"ok","seedsRun":1,"crashes":[]}\n' > "$FUZZ_DIR/wasm/summary.json"
printf '{"status":"ok","caseCount":1,"cases":[{"case":"redis-restart","status":"ok","injection":"injected","recoveryTimeMs":1}]}\n' > "$FAULT_DIR/summary.json"
printf '{"status":"ok","mode":"short","durationSeconds":1,"sampleCount":1,"latencyMs":{"p95":1}}\n' > "$SOAK_DIR/short/summary.json"

FSUSBLOG_RELEASE_STAMP=fixture \
FSUSBLOG_RELEASE_EVIDENCE_DIR="$OUT_DIR" \
FSUSBLOG_SECURITY_EVIDENCE_SOURCE_DIR="$SECURITY_DIR" \
FSUSBLOG_OPERATIONS_EVIDENCE_SOURCE_DIR="$OPERATIONS_DIR" \
FSUSBLOG_COVERAGE_EVIDENCE_DIR="$COVERAGE_DIR" \
FSUSBLOG_PERF_EVIDENCE_DIR="$PERF_DIR" \
FSUSBLOG_FAULT_EVIDENCE_DIR="$FAULT_DIR" \
FSUSBLOG_SOAK_EVIDENCE_DIR="$SOAK_DIR" \
FSUSBLOG_FUZZ_EVIDENCE_DIR="$FUZZ_DIR" \
FSUSBLOG_GATE_LOG_SOURCE_DIR="$GATE_LOG_DIR" \
  "$ROOT_DIR/tools/operations/collect-release-evidence.sh"

"$ROOT_DIR/tools/operations/check-release-evidence-manifest.mjs" "$OUT_DIR/manifest.json" >/dev/null

jq -e '
  .releaseStamp == "fixture"
  and .status == "collected-blocked"
  and .artifacts.attackMatrix == "attack-matrix.json"
  and .artifacts.permissionMatrix == "permission-matrix.json"
  and .artifacts.dastZap == "zap"
  and .artifacts.productionExposureStatus == "production-exposure-status.json"
  and .artifacts.productionExposureRequest == "production-exposure-evidence-request.json"
  and .artifacts.firewallPolicy == "production-firewall-policy.json"
  and .artifacts.coverage == "coverage"
  and .artifacts.authenticatedDast == "authenticated-dast"
  and .artifacts.fuzz == "fuzz"
  and .artifacts.faultInjection == "fault-injection"
  and .artifacts.soak == "soak"
  and .artifacts.backendQpsSummary == "backend-qps-summary.json"
  and .artifacts.publicHydrationDetectorSummary == "public-hydration-detector-summary.json"
  and .artifacts.publicHydrationClockMatrixSummary == "public-hydration-clock-matrix-summary.json"
  and .artifacts.publicHydrationBrowserEnvSummary == "public-hydration-browser-env-summary.json"
  and .artifacts.publicHydrationPayloadFixtureSummary == "public-hydration-payload-fixture-summary.json"
  and .artifactDigests.productionExposureStatus.algorithm == "sha256"
  and (.artifactDigests.productionExposureStatus.value | test("^[0-9a-f]{64}$"))
  and .artifactDigests.productionExposureRequest.algorithm == "sha256"
  and (.artifactDigests.productionExposureRequest.value | test("^[0-9a-f]{64}$"))
  and .artifactDigests.productionExposureLive.algorithm == "sha256"
  and .artifactDigests.firewallPolicy.algorithm == "sha256"
  and .artifactDigests.dnsReadiness.algorithm == "sha256"
  and .artifactDigests.dnsDelegation.algorithm == "sha256"
  and .evidenceSummary.image.status == "missing"
  and .evidenceSummary.coverage.status == "ok"
  and .evidenceSummary.externalExposure.status == "blocked"
  and .evidenceSummary.externalExposure.valid == false
  and .evidenceSummary.externalExposure.firewallPolicy == "present"
  and .evidenceSummary.externalExposure.dnsReadiness == "present"
  and .evidenceSummary.externalExposure.dnsDelegation == "present"
  and .evidenceSummary.externalExposure.liveExposure == "present"
  and .evidenceSummary.externalExposure.request.status == "awaiting-external-evidence"
  and .evidenceSummary.externalExposure.request.currentStatus == "blocked"
  and .evidenceSummary.externalExposure.request.blockerCount == 1
	  and .evidenceSummary.externalExposure.request.nextActionSources == ["fixture"]
	  and .evidenceSummary.externalExposure.request.nextActionCount == 1
	  and .evidenceSummary.externalExposure.request.unblockPlanSources == ["fixture"]
	  and .evidenceSummary.externalExposure.request.unblockPlanCount == 1
	  and .evidenceSummary.externalExposure.request.requiredEvidenceCount == 5
  and (.evidenceSummary.externalExposure.request.requiredEvidenceKeys | sort) == ["dnsDelegation","dnsReadiness","firewallPolicy","liveExposure","statusReport"]
  and .evidenceSummary.externalExposure.request.firewallSourceSha256Required == true
  and .evidenceSummary.externalExposure.request.rawSourceSha256Required == true
	  and .evidenceSummary.externalExposure.request.handoffCheckCount == 1
	  and .evidenceSummary.externalExposure.request.verificationCommandCount == 6
	  and .evidenceSummary.externalExposure.request.returnedCloseoutCommandCount == 3
	  and (.evidenceSummary.externalExposure.request.verificationCommandNames | sort) == ["complete-closeout","complete-returned-evidence","complete-returned-handoff","handoff-check","release-evidence","verify-returned-evidence"]
	  and .evidenceSummary.externalExposure.request.closeoutCommands.finalCloseout == "tools/security/complete-production-exposure-closeout.sh"
	  and .evidenceSummary.externalExposure.request.closeoutCommands.returnedEvidenceVerifier == "tools/security/verify-production-exposure-returned-evidence.sh <returned-evidence-dir>"
	  and .evidenceSummary.externalExposure.request.closeoutCommands.returnedEvidenceCloseout == "tools/security/complete-production-exposure-from-returned-evidence.sh <returned-evidence-dir>"
	  and .evidenceSummary.externalExposure.request.closeoutCommands.returnedHandoffCloseout == "tools/security/complete-production-exposure-from-returned-handoff-bundle.sh <handoff-dir-or-tar.gz>"
	  and .evidenceSummary.externalExposure.request.closeoutCommands.releaseEvidence == "tools/operations/collect-release-evidence.sh"
	  and .evidenceSummary.operations.backupRestoreDrill == "ok"
  and .evidenceSummary.operations.postDeploySmoke == "ok"
  and .evidenceSummary.operations.sloAlerts == "ok"
  and .evidenceSummary.operations.sloCriticalFiring == 0
  and .evidenceSummary.operations.runtimeTuning.nonDefaultPresetsRequireBenchmarkEvidence == true
  and .evidenceSummary.operations.runtimeTuning.rollback == "unset RuntimeTuning/DOTNET_* overrides and restart on the same image"
  and .evidenceSummary.gates.backendQps == "ok"
  and .evidenceSummary.gates.publicHydrationDetector == "success"
  and .evidenceSummary.gates.publicHydrationClockMatrix == "success"
  and .evidenceSummary.gates.publicHydrationBrowserEnv == "success"
  and .evidenceSummary.gates.publicHydrationPayloadFixture == "success"
  and .evidenceSummary.security.attackMatrix == "ok"
  and .evidenceSummary.security.permissionMatrix == "ok"
  and .evidenceSummary.security.supplyChain == "ok"
  and .evidenceSummary.security.sbom == "ok"
  and .evidenceSummary.security.dastZap == "ok"
  and .evidenceSummary.security.authenticatedDast == "ok"
  and .evidenceSummary.security.wasmFuzz == "ok"
  and .evidenceSummary.resilienceDepth.faultInjection == "ok"
  and .evidenceSummary.resilienceDepth.soak == "ok"
  and (.securityEvidenceIndex | map(.kind) | index("dast") != null)
  and (.securityEvidenceIndex | map(.kind) | index("authenticated-dast") != null)
  and (.securityEvidenceIndex | map(.kind) | index("wasm-fuzz") != null)
  and (.securityEvidenceIndex | map(.kind) | index("attack-matrix") != null)
  and (.securityEvidenceIndex | map(.kind) | index("permission-matrix") != null)
  and (.securityEvidenceIndex | map(.kind) | index("production-exposure-status") != null)
  and (.securityEvidenceIndex | map(.kind) | index("production-exposure-request") != null)
' "$OUT_DIR/manifest.json" >/dev/null

[[ -f "$OUT_DIR/attack-matrix.json" ]]
[[ -f "$OUT_DIR/permission-matrix.json" ]]
[[ -f "$OUT_DIR/zap/run-1/zap.json" ]]

FSUSBLOG_PRODUCTION_EXPOSURE_REQUEST="$SECURITY_DIR/production-exposure-evidence-request.json" \
FSUSBLOG_PRODUCTION_EXPOSURE_STATUS="$SECURITY_DIR/production-exposure-status.json" \
FSUSBLOG_PRODUCTION_EXPOSURE_EVIDENCE="$SECURITY_DIR/production-exposure-live.json" \
FSUSBLOG_FIREWALL_POLICY_EVIDENCE="$SECURITY_DIR/production-firewall-policy.json" \
FSUSBLOG_DNS_READINESS_EVIDENCE="$SECURITY_DIR/production-dns-readiness.json" \
FSUSBLOG_DNS_DELEGATION_EVIDENCE="$SECURITY_DIR/production-dns-delegation.json" \
FSUSBLOG_ALLOW_TEMP_EVIDENCE=1 \
  "$ROOT_DIR/tools/security/check-production-exposure-handoff.sh" "$OUT_DIR/manifest.json" >/dev/null

echo "[release-evidence-fixture] ok"
