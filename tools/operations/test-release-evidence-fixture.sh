#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_ROOT="$(mktemp -d)"
RESTORE_DIR="$TMP_ROOT/restore"
TRACKED_TMP_FILES=(
    ".tmp/release-evidence/frontend-render-pressure-summary.json"
    ".tmp/release-evidence/frontend-render-structure-summary.json"
    ".tmp/release-evidence/theme-css-safety-summary.json"
    ".tmp/release-evidence/aeds-decode-budget-summary.json"
    ".tmp/release-evidence/aeds-wasm-browser-summary.json"
    ".tmp/release-evidence/doc-sync-summary.json"
    ".tmp/release-evidence/backend-qps-summary.json"
    ".tmp/release-evidence/runtime-cache-summary.json"
    ".tmp/release-evidence/aot-cache-resilience-summary.json"
    ".tmp/release-evidence/public-hydration-detector-summary.json"
    ".tmp/release-evidence/public-hydration-clock-matrix-summary.json"
    ".tmp/release-evidence/public-hydration-browser-env-summary.json"
    ".tmp/release-evidence/public-hydration-payload-fixture-summary.json"
    ".tmp/release-evidence/public-hydration-dom-diff-summary.json"
    ".tmp/release-evidence/public-hydration-sidecar-summary.json"
    ".tmp/release-evidence/public-hydration-matrix-summary.json"
    ".tmp/release-evidence/ux-viewport-summary.json"
    ".tmp/frontend/dom-budget.json"
    ".tmp/frontend/route-render-pressure.json"
    ".tmp/frontend/markdown-render-budget.json"
    ".tmp/frontend/dom-depth-static.json"
)

PreserveTrackedTmpFiles() {
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

RestoreTrackedTmpFiles() {
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

trap RestoreTrackedTmpFiles EXIT
PreserveTrackedTmpFiles

SECURITY_DIR="$TMP_ROOT/security"
OPERATIONS_DIR="$TMP_ROOT/operations"
COVERAGE_DIR="$TMP_ROOT/coverage"
OUT_DIR="$TMP_ROOT/release-evidence"
PERF_DIR="$TMP_ROOT/perf"
GATE_LOG_DIR="$TMP_ROOT/gate-logs"
FAULT_DIR="$TMP_ROOT/fault-injection"
SOAK_DIR="$TMP_ROOT/soak"
FUZZ_DIR="$TMP_ROOT/fuzz"
mkdir -p "$SECURITY_DIR/zap/run-1" "$SECURITY_DIR/supply-chain" "$SECURITY_DIR/sbom" "$OPERATIONS_DIR" "$COVERAGE_DIR/merged" "$COVERAGE_DIR/backend-merged" "$COVERAGE_DIR/frontend" "$PERF_DIR" "$GATE_LOG_DIR"

RELEASE_ID="20260711010101-$(git -C "$ROOT_DIR" rev-parse --short=12 HEAD)"
COMMIT_SHA="$(git -C "$ROOT_DIR" rev-parse HEAD)"
IMAGE_DIGEST="sha256:$(printf 'a%.0s' {1..64})"
IMAGE_DIGEST_HEX="${IMAGE_DIGEST#sha256:}"
EXPECTED_RELEASE_NAMESPACE="${RELEASE_ID}--${IMAGE_DIGEST_HEX:0:12}"
IMAGE_REPOSITORY="ghcr.io/fsusblog/app"
IMAGE_REF="$IMAGE_REPOSITORY@$IMAGE_DIGEST"
RELEASE_MANIFEST="$TMP_ROOT/release-manifest.json"
RUNTIME_MATRIX_EVIDENCE="$TMP_ROOT/runtime-publish-matrix.json"
RUNTIME_PROFILE_ID="throughput-musl"
RUNTIME_PROFILE_MANIFEST_DIGEST="sha256:$(printf 'e%.0s' {1..64})"
RUNTIME_PROFILE_DIGEST="sha256:$(printf 'f%.0s' {1..64})"
GATEWAY_TRANSITION_EVIDENCE="$TMP_ROOT/gateway-transition.json"
node "$ROOT_DIR/tools/release/create-release-manifest.mjs" \
    --output "$RELEASE_MANIFEST" \
    --release-id "$RELEASE_ID" \
    --commit-sha "$COMMIT_SHA" \
    --image-repository "$IMAGE_REPOSITORY" \
    --image-tag "$IMAGE_REPOSITORY:$RELEASE_ID" \
    --image-digest "$IMAGE_DIGEST" \
    --frontend-manifest-hash "sha256:$(printf 'b%.0s' {1..64})" \
    --wasm-artifact-hash "sha256:$(printf 'c%.0s' {1..64})" \
    --identity-roster "${FSUSBLOG_RELEASE_IDENTITY_ROSTER:?explicit closed identity roster required}" \
  --identity-roster-sha256 "${FSUSBLOG_RELEASE_IDENTITY_ROSTER_SHA256:?explicit identity roster digest required}" \
  --current-schema-receipt "${FSUSBLOG_CURRENT_SCHEMA_RECEIPT:?explicit canonical current-schema receipt required}" \
    --current-schema-receipt-sha256 "${FSUSBLOG_CURRENT_SCHEMA_RECEIPT_SHA256:?explicit artifact digest required}" \
    --dotnet-version "10.0.100-fixture" \
    --node-version "v20.19.0-fixture" \
    --docker-version "28.0.0-fixture" \
    --dockerfile-digest "sha256:$(sha256sum "$ROOT_DIR/ops/docker/FsusBlog.Server.Dockerfile" | awk '{print $1}')" \
    --runtime-profile-id "$RUNTIME_PROFILE_ID" \
    --runtime-profile-manifest-digest "$RUNTIME_PROFILE_MANIFEST_DIGEST" \
    --runtime-profile-digest "$RUNTIME_PROFILE_DIGEST" \
    --runtime-base-family "musl" \
    --target-runtime "linux-musl-x64" \
    --publish-single-file "true" \
    --publish-ready-to-run "false" \
    --tiered-pgo "true" \
    --quick-jit-for-loops "true" \
    --server-gc "true" \
    --native-aot "false" \
    --thread-pool-mode "runtime-default" \
    --topology-mode "smt-visible" \
    --created-at-utc "2026-07-11T01:01:01.000Z" >/dev/null

node --input-type=module - \
    "$ROOT_DIR" \
    "$RUNTIME_MATRIX_EVIDENCE" \
    "$COMMIT_SHA" \
    "$RUNTIME_PROFILE_MANIFEST_DIGEST" \
    "$RUNTIME_PROFILE_DIGEST" <<'NODE'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const [rootDir, output, commitSha, profileManifestDigest, profileDigest] = process.argv.slice(2)
const fixtureModule = await import(pathToFileURL(path.join(rootDir, 'tests/tools/fixtures/release-runtime-matrix.mjs')).href)
const evidence = fixtureModule.createReleaseRuntimeMatrixFixture({ commitSha, profileManifestDigest, profileDigest })
fs.writeFileSync(output, `${JSON.stringify(evidence)}\n`)
NODE

jq -n \
    --arg releaseId "$RELEASE_ID" \
    --arg imageDigest "$IMAGE_DIGEST" \
    --arg sourceDigest "sha256:$(printf 'f%.0s' {1..64})" \
    --arg upstreamBefore "sha256:$(printf '1%.0s' {1..64})" \
    --arg upstreamAfter "sha256:$(printf '2%.0s' {1..64})" '
  {
    schema: "fsusblog.gateway-transition-evidence.v1",
    kind: "switch",
    status: "ok",
    generation: 2,
    startedAtUtc: "2026-07-11T01:02:00.000Z",
    completedAtUtc: "2026-07-11T01:02:01.000Z",
    durationMs: 1000,
    source: {slot: "blue", releaseId: "20260710010101-deadbeefcafe", imageDigest: $sourceDigest},
    target: {slot: "green", releaseId: $releaseId, imageDigest: $imageDigest},
    checks: {
      targetIdentity: true,
      targetReadiness: true,
      sourcePublicRelease: true,
      stagedConfigTest: true,
      stateBegin: true,
      upstreamInstall: true,
      activeConfigTest: true,
      reload: true,
      publicReleaseProbe: true,
      targetLoopbackAfterReload: true,
      stateCommit: true,
      sourceRuntimeStatus: true,
      targetRuntimeStatus: true,
      targetActivation: true,
      sourceDrain: true,
      sourceDrainDeferred: false
    },
    lifecycle: {
      sourceBefore: {releaseId: "20260710010101-deadbeefcafe", slot: "blue", mode: "active", state: "active", generation: 1, canReceiveTraffic: true, canClaimBackgroundWork: true, canAcceptNotificationStream: true, inFlightHttpRequests: 0, notificationStreamConnections: 0, activeBackgroundClaims: 0, drain: {requested: false, drained: false, timedOut: false, blockers: []}},
      targetBefore: {releaseId: $releaseId, slot: "green", mode: "candidate", state: "ready", generation: 2, canReceiveTraffic: false, canClaimBackgroundWork: false, canAcceptNotificationStream: false, inFlightHttpRequests: 0, notificationStreamConnections: 0, activeBackgroundClaims: 0, drain: {requested: false, drained: false, timedOut: false, blockers: []}},
      targetAfterActivation: {releaseId: $releaseId, slot: "green", mode: "active", state: "active", generation: 2, canReceiveTraffic: true, canClaimBackgroundWork: true, canAcceptNotificationStream: true, inFlightHttpRequests: 0, notificationStreamConnections: 0, activeBackgroundClaims: 0, drain: {requested: false, drained: false, timedOut: false, blockers: []}},
      sourceAfterDrain: {releaseId: "20260710010101-deadbeefcafe", slot: "blue", mode: "draining", state: "draining", generation: 1, canReceiveTraffic: false, canClaimBackgroundWork: false, canAcceptNotificationStream: false, inFlightHttpRequests: 0, notificationStreamConnections: 0, activeBackgroundClaims: 0, drain: {requested: true, drained: true, timedOut: false, blockers: []}}
    },
    publicProbeUrl: "https://fsus.blog/health/ready",
    postSwitchProbeUrl: "https://fsus.blog/health/ready",
    upstreamBeforeSha256: $upstreamBefore,
    upstreamAfterSha256: $upstreamAfter,
    failureStage: null,
    error: null,
    recoveryAction: "none"
  }
' >"$GATEWAY_TRANSITION_EVIDENCE"

printf '{"status":"blocked","requiredHosts":["fsus.blog"],"delegationDomains":["fsus.blog"],"blockers":[{"source":"fixture","message":"synthetic"}]}\n' >"$SECURITY_DIR/production-exposure-status.json"
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
      outputPattern: ".tmp/release-evidence/<release-identity>/manifest.json"
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
}' >"$SECURITY_DIR/production-exposure-evidence-request.json"
printf '{"generatedAt":"2026-05-18T00:00:00Z","requiredHosts":["fsus.blog"]}\n' >"$SECURITY_DIR/production-exposure-live.json"
printf '{"generatedAt":"2026-05-18T00:00:00Z","appliesToHosts":["fsus.blog"],"evidenceSource":{"kind":"aws-security-groups","sourceFile":"fixture/aws-security-groups-ok.json","sourceSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}\n' >"$SECURITY_DIR/production-firewall-policy.json"
printf '{"generatedAt":"2026-05-18T00:00:00Z","requiredHosts":"fsus.blog"}\n' >"$SECURITY_DIR/production-dns-readiness.json"
printf '{"generatedAt":"2026-05-18T00:00:00Z","delegationDomains":"fsus.blog"}\n' >"$SECURITY_DIR/production-dns-delegation.json"
printf '{"status":"ok","checks":["synthetic-attack"]}\n' >"$SECURITY_DIR/attack-matrix.json"
printf '{"status":"ok","checks":["synthetic-permission"]}\n' >"$SECURITY_DIR/permission-matrix.json"
printf '{"site":"frontend","status":"ok"}\n' >"$SECURITY_DIR/zap/run-1/zap.json"
printf '{"status":"ok"}\n' >"$SECURITY_DIR/supply-chain/summary.json"
printf '{"status":"ok"}\n' >"$SECURITY_DIR/sbom/summary.json"
cat >"$OPERATIONS_DIR/backup-restore-drill.json" <<'JSON'
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
cat >"$OPERATIONS_DIR/post-deploy-smoke.json" <<'JSON'
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
printf '{"status":"ok"}\n' >"$OPERATIONS_DIR/slo-alert-fixture.json"
printf '{"status":"ok"}\n' >"$OPERATIONS_DIR/retention-cleanup.json"
printf '{"summary":{"linecoverage":80,"branchcoverage":60,"methodcoverage":95,"assemblies":1,"classes":1,"files":1},"totals":{"lines":{"covered":80,"total":100},"branches":{"covered":60,"total":100},"methods":{"covered":95,"total":100}},"sources":{"mergeMethod":"covered-over-total-weighted"}}\n' >"$COVERAGE_DIR/merged/Summary.json"
printf '{"summary":{"linecoverage":78,"branchcoverage":58,"methodcoverage":96,"assemblies":1,"classes":1,"files":1},"totals":{"lines":{"covered":78,"total":100},"branches":{"covered":58,"total":100},"methods":{"covered":96,"total":100}},"source":"backend-cobertura","reportPaths":["coverage/backend/fixture.cobertura.xml"]}\n' >"$COVERAGE_DIR/backend-merged/Summary.json"
printf '{"summary":{"linecoverage":76,"branchcoverage":56,"functioncoverage":86,"assemblies":0,"classes":1,"files":1},"totals":{"lines":{"covered":76,"total":100},"branches":{"covered":56,"total":100},"methods":{"covered":86,"total":100}},"source":"frontend-vitest","reportPaths":["coverage/frontend/coverage-summary.json"]}\n' >"$COVERAGE_DIR/frontend/Summary.json"
mkdir -p "$ROOT_DIR/.tmp/frontend" "$ROOT_DIR/.tmp/release-evidence"
printf '{"schema":"fsusblog.frontend-render-pressure.v1","status":"ok","evidenceClass":"diagnostic","affectsCorrectness":false,"executionBoundary":"real-browser-render-diagnostics","results":[{"scenario":"fixture","status":"ok"}]}\n' >"$ROOT_DIR/.tmp/release-evidence/frontend-render-pressure-summary.json"
printf '{"schema":"fsusblog.frontend-render-structure.v1","status":"ok","evidenceClass":"correctness","affectsCorrectness":true,"executionBoundary":"browserless-static-analysis","checks":["dom-depth-static","markdown-render-budget"]}\n' >"$ROOT_DIR/.tmp/release-evidence/frontend-render-structure-summary.json"
printf '{"schema":"fsusblog.theme.css-safety.v1","themeId":"fsusblog.theme.minimal-ink","status":"ok","cssBytes":42112,"assetBytes":210944,"previewBytes":120000,"selectorCount":312,"maxSelectorDepth":3,"importantCount":2,"maxMotionDurationMs":180,"violations":[],"warnings":[]}\n' >"$ROOT_DIR/.tmp/release-evidence/theme-css-safety-summary.json"
node - "$ROOT_DIR/.tmp/release-evidence" "$COMMIT_SHA" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')

const [outputDir, commitSha] = process.argv.slice(2)
const workerModel = (resourceSource) => ({
  resourceSource,
  logicalProcessors: 8,
  instancesPerPage: 1,
  activeRequests: 4,
  minimumActiveRequests: 1,
  maximumActiveRequests: 8
})
const copyBudget = {
  measurementSource: 'executed-arena-and-owned-payload-copy',
  measuredDecodeCount: 120,
  jsToWasmCopiedBytes: 1024,
  expectedJsToWasmCopiedBytes: 1024,
  wasmToJsCopiedBytes: 512,
  expectedWasmToJsCopiedBytes: 512,
  structuredCloneFullBufferCopies: 0
}
fs.writeFileSync(path.join(outputDir, 'aeds-decode-budget-summary.json'), `${JSON.stringify({
  status: 'ok',
  evidenceClass: 'correctness',
  affectsCorrectness: true,
  executionBoundary: 'browserless-node-wasm-runtime',
  commitSha,
  measurementSource: 'real-basic-speed-wasm-runtime',
  workerModel: workerModel('os.availableParallelism'),
  tiers: ['basic', 'speed'].map((tier) => ({
    tier,
    artifact: { rawBytes: 1024, gzipBytes: 512, brotliBytes: 480 },
    compileP95Ms: 1,
    initialMemoryPages: tier === 'speed' ? 1024 : 256,
    memoryPages: tier === 'speed' ? 1024 : 256,
    peakMemoryPages: tier === 'speed' ? 1024 : 256,
    growCount: 0,
    arenaReallocationCount: 3,
    arenaClearCount: 150,
    sensitiveBytesCleared: true,
    copyBudget
  })),
  throughput: [4096, 65536, 1048576].map((frameBytes, index) => ({
    frameBytes,
    basicMBps: 200 + index,
    speedMBps: 240 + index,
    speedup: 1.2
  })),
  budgets: { measuredMedianSpeedup: 1.2 }
})}\n`)
fs.writeFileSync(path.join(outputDir, 'aeds-wasm-browser-summary.json'), `${JSON.stringify({
  status: 'ok',
  evidenceClass: 'diagnostic',
  affectsCorrectness: false,
  executionBoundary: 'real-browser-engines',
  commitSha,
  hydrationTakeoverEvidence: '.tmp/release-evidence/public-hydration-sidecar-summary.json',
  selectionRate: 1,
  fallbackRate: 1,
  browsers: [{
    browser: 'chromium',
    supported: true,
    status: 'ok',
    selectedTier: 'speed',
    fallbackTier: 'basic',
    fallbackCount: 1,
    load: { downloadMs: 1, compileMs: 1, instantiateMs: 1 },
    decode: {
      megabytesPerSecond: 250,
      decodeCount: 40,
      decodedBytes: 10486400,
      jsToWasmCopiedBytes: 10486400,
      wasmToJsCopiedBytes: 10485760,
      initialPages: 1024,
      peakPages: 1024,
      growCount: 0,
      workerModel: workerModel('navigator.hardwareConcurrency'),
      arenaReallocationCount: 1,
      arenaClearCount: 39,
      longTaskDurationMs: 0
    },
    workerTransferMs: 0
  }]
})}\n`)
NODE
printf '{"status":"ok","results":[{"scenario":"fixture","status":"ok"}]}\n' >"$ROOT_DIR/.tmp/release-evidence/doc-sync-summary.json"
cat >"$ROOT_DIR/.tmp/release-evidence/aot-cache-resilience-summary.json" <<'JSON'
{
  "schema": "fsusblog.public-aot-cache-resilience.v1",
  "status": "success",
  "gitSha": "fixture",
  "rendererVersion": "fixture",
  "placeholderOnly": false,
  "cases": [
    { "name": "corrupt-document", "route": "/article/1", "status": "success", "initialState": "fresh", "mutation": "truncate-document", "mutationVerified": true, "observedState": "fallback", "recovered": true, "durationMs": 1, "errors": [] },
    { "name": "invalid-document-bytes", "route": "/article/1", "status": "success", "initialState": "fresh", "mutation": "overwrite-document", "mutationVerified": true, "observedState": "fallback", "recovered": true, "durationMs": 1, "errors": [] },
    { "name": "missing-sidecar", "route": "/article/1", "status": "success", "initialState": "fresh", "mutation": "delete-sidecar", "mutationVerified": true, "observedState": "fallback", "recovered": true, "durationMs": 1, "errors": [] },
    { "name": "corrupt-sidecar", "route": "/article/1", "status": "success", "initialState": "fresh", "mutation": "overwrite-sidecar", "mutationVerified": true, "observedState": "fallback", "recovered": true, "durationMs": 1, "errors": [] },
    { "name": "old-asset-version", "route": "/article/1", "status": "success", "initialState": "fresh", "mutation": "seed-old-asset-version", "mutationVerified": true, "observedState": "stale", "recovered": true, "durationMs": 1, "errors": [] },
    { "name": "html-payload-mismatch", "route": "/article/1", "status": "success", "initialState": "fresh", "mutation": "swap-sidecar-payload", "mutationVerified": true, "observedState": "blocked", "recovered": true, "durationMs": 1, "errors": [] },
    { "name": "sw-stale-cache-poisoning", "route": "/article/1", "status": "success", "initialState": "fresh", "mutation": "prime-stale-browser-cache", "mutationVerified": true, "observedState": "network-recovered", "recovered": true, "durationMs": 1, "errors": [] }
  ]
}
JSON
printf '{"schema":"fsusblog.public-hydration-detector.v1","status":"success","fatalHydrationIssueCount":0,"routesChecked":[{"route":"/","routeName":"home","stage":"home:first-visit:hydrate","browser":"chromium","viewport":{"name":"desktop","width":1440,"height":900},"status":"success"}],"warnings":[],"errors":[]}\n' >"$ROOT_DIR/.tmp/release-evidence/public-hydration-detector-summary.json"
printf '{"schema":"fsusblog.public-hydration-clock-matrix.v1","status":"success","cases":[{"id":"fixture","ssrClock":"2026-06-16T12:00:00.000Z","hydrationClock":"2026-06-16T12:01:10.000Z","serverTimeZone":"UTC","browserTimeZone":"Asia/Shanghai","locale":"zh-CN","rows":[{"kind":"ArticleDetail","timestampCase":"just-now","renderTimestamp":"2026-06-16T12:00:00.000Z","renderTimeZone":"UTC","timeNodeCount":1}]}]}\n' >"$ROOT_DIR/.tmp/release-evidence/public-hydration-clock-matrix-summary.json"
printf '{"schema":"fsusblog.public-hydration-browser-env-matrix.v1","status":"success","coverage":{"environmentCells":4,"routesChecked":12,"routesSkipped":0,"sessionStates":["anonymous","user","admin"],"themePreferences":["empty","light","dark","system"],"storageBehaviors":["normal","unavailable","cleared-after-reload"],"motionPreferences":["normal","reduced"],"colorSchemes":["light","dark"],"viewports":["desktop","tablet","mobile","narrowMobile"]},"rows":[{"routeId":"home","status":"success","environment":{"id":"fixture","sessionState":"anonymous","themePreference":"empty"}}]}\n' >"$ROOT_DIR/.tmp/release-evidence/public-hydration-browser-env-summary.json"
printf '{"schema":"fsusblog.public-hydration-payload-fixture-matrix.v1","status":"success","coverage":{"dimensions":["article-list:empty","article-body:code-blocks","filter:tag-by-name","archive:large","footer:complete","payload:duplicate-scalars-absent"],"missingDimensions":[]},"fixtures":[{"id":"fixture","status":"success","route":"/","kind":"Home","dimensions":["article-list:empty"]}]}\n' >"$ROOT_DIR/.tmp/release-evidence/public-hydration-payload-fixture-summary.json"
printf '{"schema":"fsusblog.public-hydration-dom-diff.v1","status":"success","coverage":{"pageKinds":["Home","ArticleDetail","Archive","Filter","About","Privacy","Guidelines","Copyright"],"missingPageKinds":[]},"canary":{"status":"success","diffCount":1},"cases":[{"routeKey":"home","pageKind":"Home","diffCount":0}]}\n' >"$ROOT_DIR/.tmp/release-evidence/public-hydration-dom-diff-summary.json"
cat >"$ROOT_DIR/.tmp/release-evidence/public-hydration-sidecar-summary.json" <<'JSON'
{
  "schema": "fsusblog.public-hydration-sidecar-smoke.v1",
  "status": "success",
  "modeCounts": {
    "sidecar-primary": 8,
    "inline-fallback": 0
  },
  "requiredPageKinds": ["Home", "ArticleDetail", "Archive", "Filter", "About", "Privacy", "Guidelines", "Copyright"],
  "missingRequiredKinds": [],
  "canary": {
    "status": "success",
    "error": "missing public hydration sidecar: /__canary/missing-sidecar -> /aot-cache/payloads/00/0000000000000000000000000000000000000000000000000000000000000000.aeds HTTP 404"
  },
  "checks": [
    { "route": "/", "expectedPageKind": "Home", "pageKind": "Home", "mode": "sidecar-primary", "status": "success" },
    { "route": "/article/1", "expectedPageKind": "ArticleDetail", "pageKind": "ArticleDetail", "mode": "sidecar-primary", "status": "success" },
    { "route": "/archive", "expectedPageKind": "Archive", "pageKind": "Archive", "mode": "sidecar-primary", "status": "success" },
    { "route": "/category/0", "expectedPageKind": "Filter", "pageKind": "Filter", "mode": "sidecar-primary", "status": "success" },
    { "route": "/about", "expectedPageKind": "About", "pageKind": "About", "mode": "sidecar-primary", "status": "success" },
    { "route": "/privacy", "expectedPageKind": "Privacy", "pageKind": "Privacy", "mode": "sidecar-primary", "status": "success" },
    { "route": "/guidelines", "expectedPageKind": "Guidelines", "pageKind": "Guidelines", "mode": "sidecar-primary", "status": "success" },
    { "route": "/copyright", "expectedPageKind": "Copyright", "pageKind": "Copyright", "mode": "sidecar-primary", "status": "success" }
  ]
}
JSON
printf '{"schema":"fsusblog.public-hydration-matrix-summary.v1","status":"success","lane":"release","gitSha":"fixture","rendererVersion":"fixture","coverage":{"routes":[{"kind":"Home","route":"/","routeKey":"home"}],"pageKinds":["Home","ArticleDetail","Archive","Filter","About","Privacy","Guidelines","Copyright"],"phases":["direct-first-load","reload"],"browsers":["chromium"],"states":["anonymous","user","admin"],"fixtures":["payload-fixture-matrix"]},"requiredArtifacts":{"detector":"public-hydration-detector-summary.json","clock":"public-hydration-clock-matrix-summary.json","browserEnv":"public-hydration-browser-env-summary.json","payloadFixture":"public-hydration-payload-fixture-summary.json","domDiff":"public-hydration-dom-diff-summary.json"},"artifactStatuses":{"detector":"success","clock":"success","browserEnv":"success","payloadFixture":"success","domDiff":"success"},"cells":[{"source":"detector","route":"/","pageKind":"Home","phase":"direct-first-load","browser":"chromium","viewport":{"name":"desktop","width":1440,"height":900},"state":{"session":"anonymous"},"clock":null,"fixtureId":null,"result":"success","fatalHydrationIssueCount":0,"warnings":[],"errors":[],"durationMs":1}],"fatalHydrationIssueCount":0,"warnings":[],"errors":[]}\n' >"$ROOT_DIR/.tmp/release-evidence/public-hydration-matrix-summary.json"
printf '{"status":"ok","evidenceClass":"diagnostic","affectsCorrectness":false,"executionBoundary":"real-browser-ux-viewport","latestMode":"boundaries","planFingerprint":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","plannedCaseCount":1,"completedCaseCount":1,"plannedNavigationCount":1,"completedNavigationCount":1,"completedRouteThemeGroupCount":1,"failedRouteThemeGroupCount":0,"artifacts":{"smoke":null,"visual":null,"boundaries":".tmp/ux/viewport-boundaries.json"}}\n' >"$ROOT_DIR/.tmp/release-evidence/ux-viewport-summary.json"
printf '{"status":"ok","results":[{"scenario":"fixture","status":"ok"}]}\n' >"$ROOT_DIR/.tmp/frontend/dom-budget.json"
printf '{"status":"ok","results":[{"scenario":"fixture","status":"ok"}]}\n' >"$ROOT_DIR/.tmp/frontend/route-render-pressure.json"
printf '{"status":"ok","results":[{"scenario":"fixture","status":"ok"}]}\n' >"$ROOT_DIR/.tmp/frontend/markdown-render-budget.json"
printf '{"status":"ok","results":[{"scenario":"fixture","status":"ok"}]}\n' >"$ROOT_DIR/.tmp/frontend/dom-depth-static.json"
# Keep an old status-only artifact present to prove the release consumer does not accept it.
printf '{"status":"ok","results":[{"scenario":"fixture","status":"ok"}]}\n' >"$ROOT_DIR/.tmp/release-evidence/backend-qps-summary.json"
if node "$ROOT_DIR/tools/operations/check-evidence-metrics.mjs" \
    --validate-runtime-cache-evidence >/dev/null 2>&1; then
    echo "[release-evidence-fixture] status-only backend QPS evidence must not satisfy the strict runtime-cache reader" >&2
    exit 1
fi
mkdir -p "$SECURITY_DIR/authenticated-dast" "$FUZZ_DIR/wasm" "$FAULT_DIR" "$SOAK_DIR/short"
printf '%s\n' '{"schema":"fsusblog.security.authenticated-dast.v1","status":"ok","executionSource":"fresh-current-lane","targetPolicy":{"loopbackOnly":true,"productionTargetAllowed":false},"fixture":{"executionSource":"fresh-current-lane","historicalStateAccepted":false,"cleanup":"success"},"activeScan":{"executed":true,"requestCount":4,"passedCount":4,"failedCount":0},"contexts":{"anonymous":{"executed":true,"requestCount":1,"passedCount":1,"failedCount":0},"user":{"executed":true,"requestCount":1,"passedCount":1,"failedCount":0},"admin":{"executed":true,"requestCount":1,"passedCount":1,"failedCount":0},"author-console":{"executed":true,"requestCount":1,"passedCount":1,"failedCount":0}},"checks":[{"context":"anonymous","passed":true},{"context":"user","passed":true},{"context":"admin","passed":true},{"context":"author-console","passed":true}]}' >"$SECURITY_DIR/authenticated-dast/summary.json"
printf '%s\n' '{"schema":"fsusblog.security.local-runtime-exposure.v1","status":"ok","executionSource":"fresh-loopback-runtime","scope":{"loopbackRuntimeOnly":true,"externalProductionDnsChecked":false,"externalFirewallEvidenceChecked":false,"countsAsProductionCloseout":false},"targets":[{"id":"backend","status":200},{"id":"frontend","status":200},{"id":"release-preview","status":200}],"listeners":[{"id":"backend","addresses":["127.0.0.1:25001"]},{"id":"frontend","addresses":["127.0.0.1:25002"]},{"id":"release-preview","addresses":["127.0.0.1:25003"]}],"restrictedServices":[{"id":"postgres","loopbackOnly":true},{"id":"redis","loopbackOnly":true}],"failures":[]}' >"$SECURITY_DIR/local-runtime-exposure.json"
printf '{"status":"ok","executionSource":"fresh-wasm-runtime","seedsRun":1,"seedPlan":[{"corpus":"fixture","firstSeed":1,"count":1}],"decoder":{"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"crashes":[]}\n' >"$FUZZ_DIR/wasm/summary.json"
cat >"$FAULT_DIR/summary.json" <<'JSON'
{
  "status": "ok",
  "caseCount": 9,
  "cases": [
    {
      "case": "redis-restart",
      "status": "completed",
      "actionStatus": "executed",
      "actionStartedAt": "2026-06-18T00:00:00Z",
      "actionCompletedAt": "2026-06-18T00:00:10Z",
      "unavailableDurationMs": 1,
      "recoveryDurationMs": 2,
      "recoveryTimeMs": 2,
      "publicReadResult": { "status": "completed", "sampleCount": 1, "p95Ms": 1 },
      "authenticatedImpact": { "status": "not-configured" },
      "notificationStreamImpact": { "status": "not-configured" },
      "finalHealthStatus": "healthy"
    },
    {
      "case": "redis-reconnect",
      "status": "completed",
      "actionStatus": "executed",
      "actionStartedAt": "2026-06-18T00:01:00Z",
      "actionCompletedAt": "2026-06-18T00:01:10Z",
      "unavailableDurationMs": 0,
      "recoveryDurationMs": 3,
      "recoveryTimeMs": 3,
      "publicReadResult": { "status": "completed", "sampleCount": 1, "p95Ms": 1 },
      "authenticatedImpact": { "status": "not-configured" },
      "notificationStreamImpact": { "status": "not-configured" },
      "finalHealthStatus": "healthy"
    },
    {
      "case": "redis-latency",
      "status": "completed",
      "actionStatus": "executed",
      "actionStartedAt": "2026-06-18T00:02:00Z",
      "actionCompletedAt": "2026-06-18T00:02:10Z",
      "unavailableDurationMs": 1200,
      "recoveryDurationMs": 4,
      "recoveryTimeMs": 4,
      "publicReadResult": { "status": "completed", "sampleCount": 1, "p95Ms": 1 },
      "authenticatedImpact": { "status": "not-configured" },
      "notificationStreamImpact": { "status": "not-configured" },
      "finalHealthStatus": "healthy"
    },
    {
      "case": "postgres-readiness",
      "status": "completed",
      "actionStatus": "executed",
      "actionStartedAt": "2026-06-18T00:03:00Z",
      "actionCompletedAt": "2026-06-18T00:03:10Z",
      "affectedEndpoint": "/health/ready",
      "unavailableDurationMs": 1,
      "dbReconnectDurationMs": 5,
      "recoveryDurationMs": 5,
      "recoveryTimeMs": 5,
      "publicReadRecoveryResult": { "status": "completed", "sampleCount": 1, "p95Ms": 1 },
      "writePathRollbackResult": { "status": "not-mutated" },
      "finalHealthStatus": "healthy"
    },
    {
      "case": "postgres-reconnect",
      "status": "completed",
      "actionStatus": "executed",
      "actionStartedAt": "2026-06-18T00:04:00Z",
      "actionCompletedAt": "2026-06-18T00:04:10Z",
      "affectedEndpoint": "/health/ready",
      "unavailableDurationMs": 0,
      "dbReconnectDurationMs": 6,
      "recoveryDurationMs": 6,
      "recoveryTimeMs": 6,
      "publicReadRecoveryResult": { "status": "completed", "sampleCount": 1, "p95Ms": 1 },
      "writePathRollbackResult": { "status": "not-mutated" },
      "finalHealthStatus": "healthy"
    },
    {
      "case": "postgres-lock-timeout",
      "status": "completed",
      "actionStatus": "executed",
      "actionStartedAt": "2026-06-18T00:05:00Z",
      "actionCompletedAt": "2026-06-18T00:05:10Z",
      "affectedEndpoint": "/api/binary/article/list/home/1/10.aeds",
      "unavailableDurationMs": 1200,
      "dbReconnectDurationMs": 7,
      "recoveryDurationMs": 7,
      "recoveryTimeMs": 7,
      "publicReadRecoveryResult": { "status": "completed", "sampleCount": 1, "p95Ms": 1 },
      "writePathRollbackResult": { "status": "verified" },
      "finalHealthStatus": "healthy"
    },
    {
      "case": "notification-stream-slow-consumer",
      "status": "completed",
      "actionStatus": "executed",
      "actionStartedAt": "2026-06-18T00:06:00Z",
      "actionCompletedAt": "2026-06-18T00:06:10Z",
      "unavailableDurationMs": 0,
      "recoveryDurationMs": 8,
      "recoveryTimeMs": 8,
      "connectionCount": 3,
      "heartbeatFrameCount": 2,
      "businessFrameCount": 8,
      "deliveredFrameCount": 8,
      "droppedOrBackpressuredCount": 1,
      "reconnectSuccess": true,
      "replayedEventCount": 1,
      "closeObserved": true,
      "eventIds": [101, 102],
      "routeKey": "g:ContentGovernanceGroup",
      "slowConsumerPolicy": "controlled-degradation",
      "finalHealthStatus": "healthy"
    },
    {
      "case": "graceful-shutdown",
      "status": "completed",
      "actionStatus": "executed",
      "actionStartedAt": "2026-06-18T00:07:00Z",
      "actionCompletedAt": "2026-06-18T00:07:10Z",
      "shutdownRequestedAt": "2026-06-18T00:07:01Z",
      "drainDurationMs": 300,
      "restartRecoveryDurationMs": 500,
      "recoveryDurationMs": 800,
      "recoveryTimeMs": 800,
      "processStopResult": { "status": "stopped", "signal": "SIGTERM", "exitObserved": true },
      "livenessBefore": { "status": "completed", "sampleCount": 1 },
      "livenessDuringShutdown": { "status": "unavailable", "statusCode": null },
      "notificationCloseObserved": true,
      "notificationCloseCode": 1001,
      "notificationReconnectSuccess": true,
      "publicReadRecoveryResult": { "status": "completed", "sampleCount": 1, "p95Ms": 1 },
      "basicAuthRecoveryResult": { "status": "completed", "sampleCount": 1, "p95Ms": 1 },
      "backgroundWorkerState": { "status": "clean", "source": "log-scan" },
      "finalHealthStatus": "healthy"
    },
    {
      "case": "disk-artifact-storage-write-failure",
      "status": "completed",
      "actionStatus": "executed",
      "actionStartedAt": "2026-06-18T00:08:00Z",
      "actionCompletedAt": "2026-06-18T00:08:10Z",
      "targetPath": ".tmp/fault-injection-storage/fixture/artifact-target/probe-artifact.json",
      "expectedErrorClassification": "EACCES|EPERM|ENOSPC|EROFS",
      "recoveryDurationMs": 100,
      "recoveryTimeMs": 100,
      "writeFailureResult": {
        "status": "expected-error",
        "code": "EACCES",
        "targetPath": ".tmp/fault-injection-storage/fixture/artifact-target/probe-artifact.json"
      },
      "recoveryResult": {
        "status": "completed",
        "targetPath": ".tmp/fault-injection-storage/fixture/artifact-target/recovered-artifact.json",
        "bytesWritten": 9
      },
      "cleanupResult": {
        "status": "completed",
        "targetPath": ".tmp/fault-injection-storage/fixture"
      },
      "finalHealthStatus": "healthy"
    }
  ]
}
JSON
cat >"$SOAK_DIR/short/summary.json" <<'JSON'
{
  "status": "ok",
  "mode": "short",
  "executionMode": "runtime",
  "countsAsReleaseFinal": true,
  "durationSeconds": 1,
  "sampleCount": 1,
  "latencyMs": {
    "p95": 1,
    "p99": 1
  },
  "errorRate": 0,
  "resourceMetricSummary": {
    "status": "ok",
    "metrics": [
      {
        "name": "backend_rss_bytes",
        "unit": "bytes",
        "startValue": 100,
        "endValue": 104,
        "maxValue": 104,
        "delta": 4,
        "status": "observed"
      }
    ],
    "unavailableMetrics": []
  }
}
JSON

MANIFEST_STATUS_CONDITION="$(
    awk '
    /^MANIFEST_STATUS="collected-ok"/ { capture = 1 }
    /^cat[[:space:]]*>[[:space:]]*"\$OUT_DIR\/manifest.json"/ { capture = 0 }
    capture { print }
  ' "$ROOT_DIR/tools/operations/collect-release-evidence.sh"
)"
grep -Fq 'FRONTEND_RENDER_STRUCTURE_STATUS_VALUE' <<<"$MANIFEST_STATUS_CONDITION"
if grep -Eq 'UX_VIEWPORT_STATUS_VALUE|FRONTEND_RENDER_PRESSURE_STATUS_VALUE' <<<"$MANIFEST_STATUS_CONDITION"; then
    echo "[release-evidence-fixture] diagnostic browser evidence must not block correctness collection" >&2
    exit 1
fi

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
    FSUSBLOG_GATEWAY_TRANSITION_EVIDENCE="$GATEWAY_TRANSITION_EVIDENCE" \
    FSUSBLOG_RUNTIME_MATRIX_EVIDENCE="$RUNTIME_MATRIX_EVIDENCE" \
    FSUSBLOG_RUNTIME_PROFILE_ID="$RUNTIME_PROFILE_ID" \
    FSUSBLOG_RUNTIME_PROFILE_MANIFEST_DIGEST="$RUNTIME_PROFILE_MANIFEST_DIGEST" \
    FSUSBLOG_RUNTIME_PROFILE_DIGEST="$RUNTIME_PROFILE_DIGEST" \
    FSUSBLOG_RELEASE_MANIFEST="$RELEASE_MANIFEST" \
    FSUSBLOG_RELEASE_ID="$RELEASE_ID" \
    FSUSBLOG_RELEASE_SLOT="green" \
    FSUSBLOG_COMMIT_SHA="$COMMIT_SHA" \
    FSUSBLOG_IMAGE_REF="$IMAGE_REF" \
    FSUSBLOG_IMAGE_DIGEST="$IMAGE_DIGEST" \
    bash "$ROOT_DIR/tools/operations/collect-release-evidence.sh"

node "$ROOT_DIR/tools/operations/check-release-evidence-manifest.mjs" "$OUT_DIR/manifest.json" >/dev/null
jq -e '
  .schema == "fsusblog.runtime-cache-evidence-summary.v2"
  and .status == "failed"
  and (.scenarioIds | length) == 13
  and (.receiptDigests | length) == 0
  and (.errors | length) > 0
  and (.contentDigest | test("^sha256:[0-9a-f]{64}$"))
' "$OUT_DIR/runtime-cache-summary.json" >/dev/null
[[ ! -e "$OUT_DIR/backend-qps-summary.json" ]]

jq -e \
    --arg releaseId "$RELEASE_ID" \
    --arg releaseNamespace "$EXPECTED_RELEASE_NAMESPACE" \
    --arg commitSha "$COMMIT_SHA" \
    --arg imageRef "$IMAGE_REF" \
    --arg imageDigest "$IMAGE_DIGEST" '
  .schema == "fsusblog.release-evidence-manifest.v2"
  and .evidenceClass == "fresh-run-evidence"
  and .freshExecution == true
  and .releaseBound == true
  and .productionFreshRun == false
  and .releaseStamp == "fixture"
  and .releaseNamespace == $releaseNamespace
  and .storage.authority == "github-actions-artifact"
  and .storage.immutable == true
  and .storage.overwriteAllowed == false
  and .storage.retention.days == 90
  and .storage.storageReference == null
  and .artifactInventory.algorithm == "sha256"
  and .artifactInventory.fileCount > 0
  and (.artifactInventory.artifactSetSha256 | test("^sha256:[0-9a-f]{64}$"))
  and .status == "collected-blocked"
  and .artifacts.attackMatrix == "attack-matrix.json"
  and .artifacts.permissionMatrix == "permission-matrix.json"
  and .artifacts.dastZap == "zap"
  and .artifacts.productionExposureStatus == "production-exposure-status.json"
  and .artifacts.productionExposureRequest == "production-exposure-evidence-request.json"
  and .artifacts.firewallPolicy == "production-firewall-policy.json"
  and .artifacts.coverage == "coverage"
  and .artifacts.authenticatedDast == "authenticated-dast"
  and .artifacts.localRuntimeExposure == "local-runtime-exposure.json"
  and .artifacts.fuzz == "fuzz"
  and .artifacts.faultInjection == "fault-injection"
  and .artifacts.soak == "soak"
  and .artifacts.runtimeCacheSummary == "runtime-cache-summary.json"
  and (.artifacts | has("backendQpsSummary") | not)
  and .artifacts.uxViewportSummary == "ux-viewport-summary.json"
  and .artifacts.frontendRenderPressureSummary == "frontend-render-pressure-summary.json"
  and .artifacts.frontendRenderStructureSummary == "frontend-render-structure-summary.json"
  and .artifacts.themeCssSafetySummary == "theme-css-safety-summary.json"
  and .artifacts.aotCacheResilienceSummary == "aot-cache-resilience-summary.json"
  and .artifacts.publicHydrationDetectorSummary == null
  and .artifacts.publicHydrationClockMatrixSummary == "public-hydration-clock-matrix-summary.json"
  and .artifacts.publicHydrationBrowserEnvSummary == "public-hydration-browser-env-summary.json"
  and .artifacts.publicHydrationPayloadFixtureSummary == "public-hydration-payload-fixture-summary.json"
  and .artifacts.publicHydrationDomDiffSummary == "public-hydration-dom-diff-summary.json"
  and .artifacts.publicHydrationSidecarSummary == "public-hydration-sidecar-summary.json"
  and .artifacts.publicHydrationMatrixSummary == "public-hydration-matrix-summary.json"
  and .artifacts.gatewayTransition == "gateway-transition.json"
  and .artifactDigests.productionExposureStatus.algorithm == "sha256"
  and (.artifactDigests.productionExposureStatus.value | test("^[0-9a-f]{64}$"))
  and .artifactDigests.productionExposureRequest.algorithm == "sha256"
  and (.artifactDigests.productionExposureRequest.value | test("^[0-9a-f]{64}$"))
  and .artifactDigests.productionExposureLive.algorithm == "sha256"
  and .artifactDigests.firewallPolicy.algorithm == "sha256"
  and .artifactDigests.dnsReadiness.algorithm == "sha256"
  and .artifactDigests.dnsDelegation.algorithm == "sha256"
  and .evidenceSummary.image.status == "present"
  and .evidenceSummary.image.releaseIdentityStatus == "ok"
  and .releaseIdentity.releaseId == $releaseId
  and .releaseIdentity.releaseSlot == "green"
  and .releaseIdentity.commitSha == $commitSha
  and .releaseIdentity.imageRef == $imageRef
  and .releaseIdentity.imageDigest == $imageDigest
  and .evidenceSummary.coverage.status == "ok"
  and .evidenceSummary.coverage.frontend.linecoverage == 76
  and .evidenceSummary.coverage.frontend.functioncoverage == 86
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
  and .evidenceSummary.operations.gatewayTransition == "ok"
  and .evidenceSummary.operations.sloAlerts == "ok"
  and .evidenceSummary.operations.sloCriticalFiring == 0
  and .evidenceSummary.operations.runtimeTuning.nonDefaultPresetsRequireBenchmarkEvidence == true
  and .evidenceSummary.operations.runtimeTuning.telemetryPolicies.cacheL1Hit.schema == "fsus.cache-l1-telemetry-policy.v1"
  and .evidenceSummary.operations.runtimeTuning.telemetryPolicies.cacheL1Hit.defaultDurationSampleRate == 64
  and .evidenceSummary.operations.runtimeTuning.telemetryPolicies.cacheL1Hit.countRelativeErrorBudget == 0
  and .evidenceSummary.operations.runtimeTuning.telemetryPolicies.publicHotRead == "Sampled"
  and .evidenceSummary.operations.runtimeTuning.rollback == "unset RuntimeTuning/DOTNET_* overrides and restart on the same image"
  and .evidenceSummary.gates.runtimeCache == "failed"
  and (.evidenceSummary.gates | has("backendQps") | not)
  and .evidenceSummary.gates.uxViewport == "ok"
  and .evidenceSummary.gates.frontendRenderPressure == "ok"
  and .evidenceSummary.gates.frontendRenderStructure == "ok"
  and .evidenceSummary.gates.publicAotCacheResilience == "success"
  and .evidenceSummary.gates.publicHydrationDetector == "diagnostic-only"
  and .evidenceSummary.gates.publicHydrationClockMatrix == "success"
  and .evidenceSummary.gates.publicHydrationBrowserEnv == "success"
  and .evidenceSummary.gates.publicHydrationPayloadFixture == "success"
  and .evidenceSummary.gates.publicHydrationDomDiff == "success"
  and .evidenceSummary.gates.publicHydrationSidecar == "success"
  and .evidenceSummary.gates.publicHydrationMatrix == "success"
  and .evidenceSummary.security.attackMatrix == "ok"
  and .evidenceSummary.security.permissionMatrix == "ok"
  and .evidenceSummary.security.supplyChain == "ok"
  and .evidenceSummary.security.sbom == "ok"
  and .evidenceSummary.security.dastZap == "ok"
  and .evidenceSummary.security.authenticatedDast == "ok"
  and .evidenceSummary.security.localRuntimeExposure == "ok"
  and .evidenceSummary.security.wasmFuzz == "ok"
  and .evidenceSummary.resilienceDepth.faultInjection == "ok"
  and .evidenceSummary.resilienceDepth.soak == "ok"
  and (.securityEvidenceIndex | map(.kind) | index("dast") != null)
  and (.securityEvidenceIndex | map(.kind) | index("authenticated-dast") != null)
  and (.securityEvidenceIndex | map(.kind) | index("local-runtime-exposure") != null)
  and (.securityEvidenceIndex | map(.kind) | index("wasm-fuzz") != null)
  and (.securityEvidenceIndex | map(.kind) | index("attack-matrix") != null)
  and (.securityEvidenceIndex | map(.kind) | index("permission-matrix") != null)
  and (.securityEvidenceIndex | map(.kind) | index("production-exposure-status") != null)
  and (.securityEvidenceIndex | map(.kind) | index("production-exposure-request") != null)
' "$OUT_DIR/manifest.json" >/dev/null

[[ ! -e "$OUT_DIR/release-index.json" ]]

jq -e '
  .schema == "fsusblog.frontend-render-structure.v1"
  and .status == "ok"
  and .evidenceClass == "correctness"
  and .affectsCorrectness == true
  and .executionBoundary == "browserless-static-analysis"
  and .checks == ["dom-depth-static", "markdown-render-budget"]
' "$OUT_DIR/frontend-render-structure-summary.json" >/dev/null
jq -e '.status == "ok" and .evidenceClass == "diagnostic" and .affectsCorrectness == false and .executionBoundary == "real-browser-render-diagnostics"' "$OUT_DIR/frontend-render-pressure-summary.json" >/dev/null
jq -e '.status == "ok" and .evidenceClass == "diagnostic" and .affectsCorrectness == false and .executionBoundary == "real-browser-ux-viewport"' "$OUT_DIR/ux-viewport-summary.json" >/dev/null

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
