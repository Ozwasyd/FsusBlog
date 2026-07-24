#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REQUIRE_OK=0
if [[ $# -gt 1 ]]; then
    echo "usage: collect-release-evidence.sh [--require-ok]" >&2
    exit 2
fi
if [[ $# -eq 1 && "$1" != "--require-ok" ]]; then
    echo "usage: collect-release-evidence.sh [--require-ok]" >&2
    exit 2
fi
if [[ $# -eq 1 ]]; then
    REQUIRE_OK=1
fi
STAMP="${FSUSBLOG_RELEASE_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
RELEASE_NAMESPACE="$STAMP"
if [[ -n "${FSUSBLOG_RELEASE_MANIFEST:-}" ]]; then
    [[ -f "$FSUSBLOG_RELEASE_MANIFEST" ]] || { echo "FSUSBLOG_RELEASE_MANIFEST is missing" >&2; exit 2; }
    identity_args=(--manifest "$FSUSBLOG_RELEASE_MANIFEST")
    [[ -n "${FSUSBLOG_RELEASE_ID:-}" ]] && identity_args+=(--release-id "$FSUSBLOG_RELEASE_ID")
    [[ -n "${FSUSBLOG_COMMIT_SHA:-}" ]] && identity_args+=(--commit-sha "$FSUSBLOG_COMMIT_SHA")
    [[ -n "${FSUSBLOG_IMAGE_REF:-}" ]] && identity_args+=(--image-ref "$FSUSBLOG_IMAGE_REF")
    [[ -n "${FSUSBLOG_IMAGE_DIGEST:-}" ]] && identity_args+=(--image-digest "$FSUSBLOG_IMAGE_DIGEST")
    RELEASE_IDENTITY_INPUT="$(node "$ROOT_DIR/tools/release/check-release-manifest.mjs" "${identity_args[@]}")" || exit 2
    export FSUSBLOG_RELEASE_ID="$(jq -r '.releaseId' <<<"$RELEASE_IDENTITY_INPUT")"
    export FSUSBLOG_RELEASE_CREATED_AT_UTC="$(jq -r '.createdAtUtc' <<<"$RELEASE_IDENTITY_INPUT")"
    export FSUSBLOG_COMMIT_SHA="$(jq -r '.commitSha' <<<"$RELEASE_IDENTITY_INPUT")"
    export FSUSBLOG_IMAGE_REF="$(jq -r '.imageRef' <<<"$RELEASE_IDENTITY_INPUT")"
    export FSUSBLOG_IMAGE_DIGEST="$(jq -r '.imageDigest' <<<"$RELEASE_IDENTITY_INPUT")"
    IMAGE_NAMESPACE_DIGEST="${FSUSBLOG_IMAGE_DIGEST#sha256:}"
    RELEASE_NAMESPACE="${FSUSBLOG_RELEASE_ID}--${IMAGE_NAMESPACE_DIGEST:0:12}"
elif [[ -n "${FSUSBLOG_RELEASE_ID:-}${FSUSBLOG_COMMIT_SHA:-}${FSUSBLOG_IMAGE_REF:-}${FSUSBLOG_IMAGE_DIGEST:-}" ]]; then
    echo "release-bound evidence identity requires FSUSBLOG_RELEASE_MANIFEST" >&2
    exit 2
fi
export FSUSBLOG_RELEASE_NAMESPACE="$RELEASE_NAMESPACE"
OUT_DIR="${FSUSBLOG_RELEASE_EVIDENCE_DIR:-$ROOT_DIR/.tmp/release-evidence/$RELEASE_NAMESPACE}"
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

RestoreDownloadedArtifacts() {
    bash "$ROOT_DIR/tools/operations/restore-downloaded-artifacts.sh" \
        "$ROOT_DIR/.tmp/downloaded-artifacts" \
        "$ROOT_DIR/.tmp"
}

RestoreDownloadedArtifacts

CopyIfPresent() {
    local src="$1"
    local name="$2"
    if [[ -e "$src" ]]; then
        cp -a "$src" "$OUT_DIR/$name"
        printf '"%s"' "$name"
    else
        printf 'null'
    fi
}

ArtifactDigestJson() {
    local artifactJson="$1"
    local artifact path digest

    artifact="$(jq -r '.' <<<"$artifactJson" 2>/dev/null || true)"
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

JsonStatusOrMissing() {
    local file="$1"
    if [[ ! -f "$file" ]]; then
        printf 'missing'
        return
    fi

    jq -r '.status // "present"' "$file" 2>/dev/null || printf 'invalid'
}

SemanticStatusOrMissing() {
    local file="$1"
    local predicate="$2"
    if [[ ! -f "$file" ]]; then
        printf 'missing'
        return
    fi

    if jq -e "$predicate" "$file" >/dev/null 2>&1; then
        printf 'ok'
        return
    fi

    jq -r '
    if .status == "scheduled" then "scheduled"
    elif .status == "ok" then "blocked"
    else (.status // "invalid") end
  ' "$file" 2>/dev/null || printf 'invalid'
}

BackupRestoreStatusOrMissing() {
    SemanticStatusOrMissing "$1" $'
    (.status == "ok")
    and (.mode == "real")
    and (.timings.rpoSeconds != null)
    and (.timings.rtoSeconds != null)
    and (([
      "postgres-restore:ok",
      "redis-restore:ok",
      "webroot-artifact-restore:ok",
      "restored-backend-start:ok",
      "public-page:ok",
      "binary-api:ok",
      "search-index:ok",
      "notification-stream-live:ok",
      "admin-login:ok"
    ] - (.checks // [])) | length == 0)
  '
}

PostDeploySmokeStatusOrMissing() {
    SemanticStatusOrMissing "$1" '
    (.status == "ok")
    and (.dryRun == false)
    and ((.blockers // []) | length == 0)
    and (([
      "anonymous-public",
      "feed-rss",
      "feed-atom",
      "feed-json",
      "sitemap",
      "robots",
      "health-live",
      "health-ready"
    ] - (.verifiedCoverage // [])) | length == 0)
  '
}

GatewayTransitionStatusOrMissing() {
    SemanticStatusOrMissing "$1" '
    (.status == "ok")
    and (.generation | type == "number" and . >= 1)
    and (.durationMs | type == "number" and . >= 0)
    and (
      (
        .schema == "fsusblog.gateway-transition-evidence.v1"
        and (.kind == "switch" or .kind == "rollback")
        and .checks.targetIdentity == true
        and .checks.targetReadiness == true
        and .checks.sourcePublicRelease == true
        and .checks.stagedConfigTest == true
        and .checks.stateBegin == true
        and .checks.upstreamInstall == true
        and .checks.activeConfigTest == true
        and .checks.reload == true
        and .checks.publicReleaseProbe == true
        and .checks.targetLoopbackAfterReload == true
        and .checks.stateCommit == true
        and .checks.sourceRuntimeStatus == true
        and .checks.targetRuntimeStatus == true
        and .checks.targetActivation == true
        and (
          (.checks.sourceDrain == true and .checks.sourceDrainDeferred == false)
          or (.checks.sourceDrain == false and .checks.sourceDrainDeferred == true)
        )
        and .lifecycle.sourceBefore.releaseId == .source.releaseId
        and .lifecycle.sourceBefore.slot == .source.slot
        and .lifecycle.sourceBefore.mode == "active"
        and .lifecycle.sourceBefore.state == "active"
        and .lifecycle.sourceBefore.canReceiveTraffic == true
        and .lifecycle.targetBefore.releaseId == .target.releaseId
        and .lifecycle.targetBefore.slot == .target.slot
        and .lifecycle.targetBefore.mode == "candidate"
        and .lifecycle.targetBefore.state == "ready"
        and .lifecycle.targetBefore.canReceiveTraffic == false
        and .lifecycle.targetBefore.canClaimBackgroundWork == false
        and .lifecycle.targetAfterActivation.releaseId == .target.releaseId
        and .lifecycle.targetAfterActivation.slot == .target.slot
        and .lifecycle.targetAfterActivation.mode == "active"
        and .lifecycle.targetAfterActivation.state == "active"
        and .lifecycle.targetAfterActivation.canReceiveTraffic == true
        and .lifecycle.targetAfterActivation.canClaimBackgroundWork == true
        and .lifecycle.sourceAfterDrain.releaseId == .source.releaseId
        and .lifecycle.sourceAfterDrain.slot == .source.slot
        and (
          (
            .checks.sourceDrain == true
            and .lifecycle.sourceAfterDrain.mode == "draining"
            and .lifecycle.sourceAfterDrain.state == "draining"
            and .lifecycle.sourceAfterDrain.canReceiveTraffic == false
            and .lifecycle.sourceAfterDrain.canClaimBackgroundWork == false
            and .lifecycle.sourceAfterDrain.drain.requested == true
            and .lifecycle.sourceAfterDrain.drain.drained == true
            and .lifecycle.sourceAfterDrain.drain.timedOut == false
            and (.lifecycle.sourceAfterDrain.drain.blockers | type == "array" and length == 0)
          )
          or
          (
            .checks.sourceDrainDeferred == true
            and .lifecycle.sourceAfterDrain.mode == "active"
            and .lifecycle.sourceAfterDrain.state == "active"
            and .lifecycle.sourceAfterDrain.drain.requested == false
          )
        )
      )
      or
      (
        .schema == "fsusblog.gateway-recovery-evidence.v1"
        and .kind == "recovery"
        and (.action == "restore-source" or .action == "commit-target")
        and .checks.activeConfigTest == true
        and .checks.reload == true
        and .checks.publicReleaseProbe == true
        and .checks.stateResolution == true
        and (
          (
            .action == "restore-source"
            and .checks.sourceRuntime == true
            and .checks.sourceRuntimeStatus == true
            and .checks.targetNeutralized == true
            and .lifecycle.sourceBefore.releaseId == .source.releaseId
            and .lifecycle.sourceBefore.slot == .source.slot
            and .lifecycle.sourceBefore.mode == "active"
            and .lifecycle.sourceBefore.state == "active"
            and .lifecycle.sourceBefore.canReceiveTraffic == true
            and (
              .lifecycle.targetAfterActivation == null
              or (
                .lifecycle.targetAfterActivation.releaseId == .target.releaseId
                and .lifecycle.targetAfterActivation.slot == .target.slot
                and .lifecycle.targetAfterActivation.canReceiveTraffic == false
                and .lifecycle.targetAfterActivation.canClaimBackgroundWork == false
              )
            )
          )
          or (
            .action == "commit-target"
            and .checks.targetRuntime == true
            and .checks.targetRuntimeStatus == true
            and .checks.targetActivation == true
            and .checks.sourceRuntimeStatus == true
            and .checks.sourceDrain == true
            and .lifecycle.sourceBefore.releaseId == .source.releaseId
            and .lifecycle.sourceBefore.slot == .source.slot
            and .lifecycle.sourceBefore.mode == "active"
            and .lifecycle.sourceBefore.state == "active"
            and .lifecycle.targetBefore.releaseId == .target.releaseId
            and .lifecycle.targetBefore.slot == .target.slot
            and (
              (.lifecycle.targetBefore.mode == "candidate" and .lifecycle.targetBefore.state == "ready" and .lifecycle.targetBefore.canReceiveTraffic == false)
              or (.lifecycle.targetBefore.mode == "active" and .lifecycle.targetBefore.state == "active" and .lifecycle.targetBefore.canReceiveTraffic == true)
            )
            and .lifecycle.targetAfterActivation.releaseId == .target.releaseId
            and .lifecycle.targetAfterActivation.slot == .target.slot
            and .lifecycle.targetAfterActivation.mode == "active"
            and .lifecycle.targetAfterActivation.state == "active"
            and .lifecycle.targetAfterActivation.canReceiveTraffic == true
            and .lifecycle.sourceAfterDrain.releaseId == .source.releaseId
            and .lifecycle.sourceAfterDrain.slot == .source.slot
            and .lifecycle.sourceAfterDrain.mode == "draining"
            and .lifecycle.sourceAfterDrain.state == "draining"
            and .lifecycle.sourceAfterDrain.canReceiveTraffic == false
            and .lifecycle.sourceAfterDrain.drain.requested == true
            and .lifecycle.sourceAfterDrain.drain.drained == true
            and .lifecycle.sourceAfterDrain.drain.timedOut == false
            and (.lifecycle.sourceAfterDrain.drain.blockers | type == "array" and length == 0)
          )
        )
      )
    )
  '
}

ReleaseRolloutStatusOrMissing() {
    local file="$1"
    if [[ ! -f "$file" ]]; then
        printf 'missing'
        return
    fi

    if node "$ROOT_DIR/tools/deployment/release-rollout-evidence.mjs" verify --evidence "$file" >/dev/null 2>&1 &&
        jq -e \
            --arg releaseId "${FSUSBLOG_RELEASE_ID:-}" \
            --arg releaseSlot "${FSUSBLOG_RELEASE_SLOT:-}" \
            --arg imageDigest "${FSUSBLOG_IMAGE_DIGEST:-}" '
        .schema == "fsusblog.release-rollout-evidence.v1"
        and .status == "pass"
        and (.errors | type == "array" and length == 0)
        and .target.releaseId == $releaseId
        and .target.slot == $releaseSlot
        and .target.imageDigest == $imageDigest
        and (.gatewayGeneration | type == "number" and . >= 1)
        and (.stages | type == "array" and length == 15)
      ' "$file" >/dev/null 2>&1; then
        printf 'ok'
        return
    fi

    jq -r 'if .status == "pass" then "invalid" else (.status // "invalid") end' "$file" 2>/dev/null || printf 'invalid'
}

AuthenticatedDastStatusOrMissing() {
    local query
    IFS= read -r -d '' query <<'JQ' || true
    . as $root
    | (.schema == "fsusblog.security.authenticated-dast.v1")
    and (.status == "ok")
    and (.executionSource == "fresh-current-lane")
    and (.fixture.executionSource == "fresh-current-lane")
    and (.fixture.historicalStateAccepted == false)
    and (.fixture.cleanup == "success")
    and (.targetPolicy.loopbackOnly == true)
    and (.targetPolicy.productionTargetAllowed == false)
    and (.activeScan.executed == true)
    and ((.activeScan.requestCount // 0) | type == "number" and . > 0 and floor == .)
    and (.activeScan.failedCount == 0)
    and (.activeScan.passedCount == .activeScan.requestCount)
    and (["anonymous", "user", "admin", "author-console"] | all(
      . as $context
      | ($root.contexts[$context].executed == true)
      and (($root.contexts[$context].requestCount // 0) | type == "number" and . > 0 and floor == .)
      and ($root.contexts[$context].failedCount == 0)
    ))
    and (($root.checks // []) | type == "array" and length == $root.activeScan.requestCount and all(.passed == true))
JQ
    SemanticStatusOrMissing "$1" "$query"
}

LocalRuntimeExposureStatusOrMissing() {
    SemanticStatusOrMissing "$1" '
    (.schema == "fsusblog.security.local-runtime-exposure.v1")
    and (.status == "ok")
    and (.executionSource == "fresh-loopback-runtime")
    and (.scope.loopbackRuntimeOnly == true)
    and (.scope.externalProductionDnsChecked == false)
    and (.scope.externalFirewallEvidenceChecked == false)
    and (.scope.countsAsProductionCloseout == false)
    and ((.failures // []) | type == "array" and length == 0)
    and ((.targets // []) | type == "array" and ([.[].id] | sort) == ["backend", "frontend", "release-preview"])
    and ((.targets // []) | all((.status // 500) < 500))
    and ((.listeners // []) | type == "array" and length == 3 and all((.addresses // []) | length > 0))
    and ((.restrictedServices // []) | type == "array" and ([.[].id] | sort) == ["postgres", "redis"] and all(.loopbackOnly == true))
  '
}

WasmFuzzStatusOrMissing() {
    SemanticStatusOrMissing "$1" '
    (.status == "ok")
    and (.executionSource == "fresh-wasm-runtime")
    and ((.seedsRun // 0) | type == "number" and . > 0 and floor == .)
    and ((.seedPlan // []) | type == "array" and length > 0)
    and ((.seedPlan // []) | all(
      (.corpus | type == "string" and length > 0)
      and (.firstSeed | type == "number" and floor == .)
      and (.count | type == "number" and . > 0 and floor == .)
    ))
    and (((.seedPlan // []) | map(.count) | add) == .seedsRun)
    and ((.decoder.sha256 // "") | test("^[a-f0-9]{64}$"))
    and ((.crashes // []) | type == "array" and length == 0)
  '
}

FaultInjectionStatusOrMissing() {
    SemanticStatusOrMissing "$1" '
    (.status == "ok")
    and ((.caseCount // 0) > 0)
    and ((.cases // []) | length > 0)
    and (([
      "redis-restart",
      "redis-reconnect",
      "redis-latency",
      "postgres-readiness",
      "postgres-reconnect",
      "postgres-lock-timeout",
      "notification-stream-slow-consumer",
      "graceful-shutdown",
      "disk-artifact-storage-write-failure"
    ] - ([.cases[]?.case])) | length == 0)
    and all(.cases[]?; .status == "completed" and .actionStatus == "executed")
    and all(.cases[]?; ((.case | startswith("redis-")) | not) or (
      ((.actionStartedAt // "") | length > 0)
      and ((.actionCompletedAt // "") | length > 0)
      and ((.unavailableDurationMs // -1) >= 0)
      and (((.recoveryDurationMs // .recoveryTimeMs // 0)) > 0)
      and ((.publicReadResult.status // "") == "completed")
      and ((.publicReadResult.sampleCount // 0) > 0)
      and ((.finalHealthStatus // "") == "healthy")
      and ((.authenticatedImpact.status // "") | length > 0)
      and ((.notificationStreamImpact.status // "") | length > 0)
    ))
    and all(.cases[]?; ((.case | startswith("postgres-")) | not) or (
      ((.actionStartedAt // "") | length > 0)
      and ((.actionCompletedAt // "") | length > 0)
      and ((.affectedEndpoint // "") | length > 0)
      and ((.unavailableDurationMs // -1) >= 0)
      and (((.dbReconnectDurationMs // .recoveryDurationMs // .recoveryTimeMs // 0)) > 0)
      and ((.publicReadRecoveryResult.status // "") == "completed")
      and ((.publicReadRecoveryResult.sampleCount // 0) > 0)
      and (
        ((.writePathRollbackResult.status // "") == "verified")
        or ((.writePathRollbackResult.status // "") == "not-mutated")
        or ((.writePathRollbackResult.status // "") == "idempotent")
      )
      and ((.finalHealthStatus // "") == "healthy")
    ))
    and all(.cases[]?; (.case != "notification-stream-slow-consumer") or (
      ((.connectionCount // 0) > 0)
      and ((.heartbeatFrameCount // 0) > 0)
      and ((.businessFrameCount // 0) > 0)
      and ((.deliveredFrameCount // 0) > 0)
      and ((.droppedOrBackpressuredCount // 0) > 0)
      and (.reconnectSuccess == true)
      and ((.replayedEventCount // 0) > 0)
      and (.closeObserved == true)
      and (((.eventIds // []) | length) > 0)
      and all(.eventIds[]?; . > 0)
      and ((.routeKey // "") | length > 0)
      and ((.slowConsumerPolicy // "") | length > 0)
      and ((.finalHealthStatus // "") == "healthy")
    ))
    and all(.cases[]?; (.case != "graceful-shutdown") or (
      ((.shutdownRequestedAt // "") | length > 0)
      and ((.processStopResult.status // "") == "stopped")
      and (((.drainDurationMs // .recoveryDurationMs // .recoveryTimeMs // 0)) > 0)
      and (((.restartRecoveryDurationMs // .recoveryDurationMs // .recoveryTimeMs // 0)) > 0)
      and ((.livenessBefore.status // "") == "completed")
      and ((.livenessDuringShutdown.status // "") == "unavailable")
      and (.notificationCloseObserved == true)
      and ((.notificationCloseCode // null) != null)
      and (.notificationReconnectSuccess == true)
      and ((.publicReadRecoveryResult.status // "") == "completed")
      and ((.publicReadRecoveryResult.sampleCount // 0) > 0)
      and ((.basicAuthRecoveryResult.status // "") == "completed")
      and ((.basicAuthRecoveryResult.sampleCount // 0) > 0)
      and ((.backgroundWorkerState.status // "") == "clean")
      and ((.finalHealthStatus // "") == "healthy")
    ))
    and all(.cases[]?; (.case != "disk-artifact-storage-write-failure") or (
      ((.targetPath // "") | length > 0)
      and ((.expectedErrorClassification // "") | length > 0)
      and ((.writeFailureResult.status // "") == "expected-error")
      and ((.recoveryResult.status // "") == "completed")
      and ((.cleanupResult.status // "") == "completed")
      and (((.recoveryDurationMs // .recoveryTimeMs // 0)) > 0)
      and ((.finalHealthStatus // "") == "healthy")
    ))
  '
}

ShortSoakStatusOrMissing() {
    SemanticStatusOrMissing "$1" '
    (.status == "ok")
    and (.mode == "short")
    and (.executionMode == "runtime")
    and (.countsAsReleaseFinal == true)
    and ((.durationSeconds // 0) > 0)
    and ((.sampleCount // 0) > 0)
    and ((.latencyMs.p95 // 0) > 0)
    and ((.latencyMs.p99 // 0) > 0)
    and ((.errorRate // -1) >= 0)
    and (
      (((.resourceMetricSummary.metrics // []) | length) > 0)
      or any((.resourceMetricSummary.unavailableMetrics // [])[]?; ((.reason // "") | length) > 0)
    )
  '
}

ResultStatusOrMissing() {
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

ZapStatusOrMissing() {
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

BlockersJsonOrEmpty() {
    local file="$1"
    if [[ ! -f "$file" ]]; then
        printf '[]'
        return
    fi

    jq -c '.blockers // []' "$file" 2>/dev/null || printf '[]'
}

SloCriticalCountOrZero() {
    local file="$1"
    if [[ ! -f "$file" ]]; then
        printf '0'
        return
    fi

    jq -r '[.alerts[]? | select(.severity == "critical" and ((.status // "firing") == "firing"))] | length' "$file" 2>/dev/null || printf '0'
}

RequestSummaryJson() {
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

CoverageSummaryJson() {
    local merged="$COVERAGE_DIR/merged/Summary.json"
    local backend="$COVERAGE_DIR/backend-merged/Summary.json"
    local frontend="$COVERAGE_DIR/frontend/Summary.json"
    local mergedInput="$merged"
    local backendInput="$backend"
    local frontendInput="$frontend"

    if [[ ! -f "$merged" && ! -f "$backend" && ! -f "$frontend" ]]; then
        jq -n '{status: "missing", merged: null, backend: null, frontend: null}'
        return
    fi
    [[ -f "$mergedInput" ]] || mergedInput="/dev/null"
    [[ -f "$backendInput" ]] || backendInput="/dev/null"
    [[ -f "$frontendInput" ]] || frontendInput="/dev/null"

    jq -n \
        --arg profileId "${FSUSBLOG_RUNTIME_PROFILE_ID:-}" \
        --arg profileManifestDigest "${FSUSBLOG_RUNTIME_PROFILE_MANIFEST_DIGEST:-}" \
        --arg profileDigest "${FSUSBLOG_RUNTIME_PROFILE_DIGEST:-}" \
        --slurpfile merged "$mergedInput" \
        --slurpfile backend "$backendInput" \
        --slurpfile frontend "$frontendInput" '
      def summary($value):
        if ($value | length) == 0 then null
        else {
          linecoverage: $value[0].summary.linecoverage,
          branchcoverage: $value[0].summary.branchcoverage,
          methodcoverage: $value[0].summary.methodcoverage,
          functioncoverage: ($value[0].summary.functioncoverage // null),
          assemblies: $value[0].summary.assemblies,
          classes: $value[0].summary.classes,
          files: $value[0].summary.files,
          totals: ($value[0].totals // null),
          source: ($value[0].source // null),
          sources: ($value[0].sources // null),
          reportPaths: ($value[0].reportPaths // [])
        } end;

      (summary($merged)) as $mergedSummary
      | (summary($backend)) as $backendSummary
      | (summary($frontend)) as $frontendSummary
      | {
          status: (
            if ($mergedSummary == null or $backendSummary == null or $frontendSummary == null) then "partial"
            elif (($mergedSummary.totals.lines.total // 0) > 0 and ($backendSummary.totals.lines.total // 0) > 0 and ($frontendSummary.totals.lines.total // 0) > 0) then "ok"
            else "blocked" end
          ),
          merged: $mergedSummary,
          backend: $backendSummary,
          frontend: $frontendSummary
        }
    ' 2>/dev/null || jq -n '{status: "invalid", merged: null, backend: null, frontend: null}'
}

RuntimeTuningJson() {
    local cacheL1CounterMode publicHotReadCounterMode
    local benchmarkEvidence runtimeMatrixEvidence
    cacheL1CounterMode="$(awk -F'"' '/CacheL1CounterMode =/ { print $2; exit }' "$ROOT_DIR/src/backend/Infrastructure/Observability/FsusObservability.cs")"
    publicHotReadCounterMode="$(awk -F'"' '
    /"PublicHotRead"[[:space:]]*:/ { in_public_hot_read = 1; next }
    in_public_hot_read && /"CounterMode"[[:space:]]*:/ { print $4; exit }
    in_public_hot_read && /^[[:space:]]*}/ { exit }
  ' "$ROOT_DIR/src/backend/appsettings.Production.json")"
    cacheL1CounterMode="${cacheL1CounterMode:-unknown}"
    publicHotReadCounterMode="${publicHotReadCounterMode:-unknown}"
    benchmarkEvidence="$(jq -r '.' <<<"${PERF_ARTIFACT:-null}")"
    runtimeMatrixEvidence="$(jq -r '.' <<<"${RUNTIME_MATRIX_ARTIFACT:-null}")"
    jq -n \
        --arg readyToRun "${DOTNET_ReadyToRun:-}" \
        --arg quickJitForLoops "${DOTNET_TC_QuickJitForLoops:-}" \
        --arg tieredPgo "${DOTNET_TieredPGO:-}" \
        --arg minWorkerThreads "${FSUSBLOG_RUNTIME_THREADPOOL_MIN_WORKER_THREADS:-}" \
        --arg minCompletionPortThreads "${FSUSBLOG_RUNTIME_THREADPOOL_MIN_COMPLETION_PORT_THREADS:-}" \
        --arg cacheL1CounterMode "$cacheL1CounterMode" \
        --arg publicHotReadCounterMode "$publicHotReadCounterMode" \
        --arg benchmarkEvidence "$benchmarkEvidence" \
        --arg runtimeMatrixEvidence "$runtimeMatrixEvidence" \
        --arg runtimeMatrixStatus "${RUNTIME_MATRIX_STATUS_VALUE:-missing}" \
        --arg profileId "${FSUSBLOG_RUNTIME_PROFILE_ID:-}" \
        --arg profileManifestDigest "${FSUSBLOG_RUNTIME_PROFILE_MANIFEST_DIGEST:-}" \
        --arg profileDigest "${FSUSBLOG_RUNTIME_PROFILE_DIGEST:-}" '
    {
      profile: {
        id: (if $profileId == "" then null else $profileId end),
        manifestDigest: (if $profileManifestDigest == "" then null else $profileManifestDigest end),
        profileDigest: (if $profileDigest == "" then null else $profileDigest end)
      },
      readyToRun: (if $readyToRun == "" then null else $readyToRun end),
      quickJitForLoops: (if $quickJitForLoops == "" then null else $quickJitForLoops end),
      tieredPgo: (if $tieredPgo == "" then null else $tieredPgo end),
      threadPool: {
        minWorkerThreads: (if $minWorkerThreads == "" then null else $minWorkerThreads end),
        minCompletionPortThreads: (if $minCompletionPortThreads == "" then null else $minCompletionPortThreads end)
      },
      counterModes: {
        cacheL1Hit: $cacheL1CounterMode,
        publicHotRead: $publicHotReadCounterMode
      },
      benchmarkEvidence: (if $benchmarkEvidence == "null" then null else $benchmarkEvidence end),
      runtimeMatrixEvidence: (if $runtimeMatrixEvidence == "null" then null else $runtimeMatrixEvidence end),
      runtimeMatrixStatus: $runtimeMatrixStatus,
      nonDefaultPresetsRequireBenchmarkEvidence: true,
      rollback: "unset RuntimeTuning/DOTNET_* overrides and restart on the same image"
    }'
}

PRODUCTION_STATUS="$(CopyIfPresent "$SECURITY_DIR/production-exposure-status.json" production-exposure-status.json)"
PRODUCTION_REQUEST="$(CopyIfPresent "$SECURITY_DIR/production-exposure-evidence-request.json" production-exposure-evidence-request.json)"
PRODUCTION_LIVE="$(CopyIfPresent "$SECURITY_DIR/production-exposure-live.json" production-exposure-live.json)"
FIREWALL_POLICY="$(CopyIfPresent "$SECURITY_DIR/production-firewall-policy.json" production-firewall-policy.json)"
DNS_READY="$(CopyIfPresent "$SECURITY_DIR/production-dns-readiness.json" production-dns-readiness.json)"
DNS_DELEGATION="$(CopyIfPresent "$SECURITY_DIR/production-dns-delegation.json" production-dns-delegation.json)"
ATTACK_MATRIX="$(CopyIfPresent "$SECURITY_DIR/attack-matrix.json" attack-matrix.json)"
PERMISSION_MATRIX="$(CopyIfPresent "$SECURITY_DIR/permission-matrix.json" permission-matrix.json)"
LOCAL_RUNTIME_EXPOSURE="$(CopyIfPresent "$SECURITY_DIR/local-runtime-exposure.json" local-runtime-exposure.json)"
ZAP="$(CopyIfPresent "$SECURITY_DIR/zap" zap)"
SUPPLY_CHAIN="$(CopyIfPresent "$SECURITY_DIR/supply-chain" supply-chain)"
SBOM="$(CopyIfPresent "$SECURITY_DIR/sbom" sbom)"
SECURITY_MATRICES="$(CopyIfPresent "$ROOT_DIR/security" security-matrices)"
RESTORE_DRILL="$(CopyIfPresent "$OPERATIONS_DIR/backup-restore-drill.json" backup-restore-drill.json)"
SMOKE="$(CopyIfPresent "$OPERATIONS_DIR/post-deploy-smoke.json" post-deploy-smoke.json)"
GATEWAY_TRANSITION_SOURCE="${FSUSBLOG_GATEWAY_TRANSITION_EVIDENCE:-/var/lib/fsusblog/deployment/evidence/latest.json}"
GATEWAY_TRANSITION="$(CopyIfPresent "$GATEWAY_TRANSITION_SOURCE" gateway-transition.json)"
RELEASE_ROLLOUT_SOURCE="${FSUSBLOG_RELEASE_ROLLOUT_EVIDENCE:-$OPERATIONS_DIR/release-rollout.json}"
RELEASE_ROLLOUT="$(CopyIfPresent "$RELEASE_ROLLOUT_SOURCE" release-rollout.json)"
if [[ -f "$RELEASE_ROLLOUT_SOURCE" ]]; then
    node "$ROOT_DIR/tools/operations/collect-release-rollout-bundle.mjs" \
        --input "$RELEASE_ROLLOUT_SOURCE" \
        --output "$OUT_DIR/release-rollout-bundle" >/dev/null
    RELEASE_ROLLOUT_BUNDLE='"release-rollout-bundle"'
else
    RELEASE_ROLLOUT_BUNDLE='null'
fi
SLO_ALERTS="$(CopyIfPresent "$OPERATIONS_DIR/slo-alert-fixture.json" slo-alert-fixture.json)"
RETENTION_CLEANUP="$(CopyIfPresent "$OPERATIONS_DIR/retention-cleanup.json" retention-cleanup.json)"
COVERAGE_ARTIFACT="$(CopyIfPresent "$COVERAGE_DIR" coverage)"
PERF_ARTIFACT="$(CopyIfPresent "$PERF_DIR" perf)"
RUNTIME_MATRIX_SOURCE="${FSUSBLOG_RUNTIME_MATRIX_EVIDENCE:-}"
RUNTIME_MATRIX_ARTIFACT="null"
RUNTIME_MATRIX_STATUS_VALUE="missing"
if [[ -n "$RUNTIME_MATRIX_SOURCE" ]]; then
    if [[ -z "${FSUSBLOG_RUNTIME_PROFILE_ID:-}" || -z "${FSUSBLOG_RUNTIME_PROFILE_MANIFEST_DIGEST:-}" || -z "${FSUSBLOG_RUNTIME_PROFILE_DIGEST:-}" ]]; then
        echo "runtime matrix evidence requires FSUSBLOG_RUNTIME_PROFILE_ID and both profile digests" >&2
        exit 1
    fi
    if [[ "$FSUSBLOG_RUNTIME_PROFILE_MANIFEST_DIGEST" == "sha256:$(printf '0%.0s' {1..64})" ||
    "$FSUSBLOG_RUNTIME_PROFILE_DIGEST" == "sha256:$(printf '0%.0s' {1..64})" ]]; then
        echo "runtime matrix evidence cannot use zero release profile digests" >&2
        exit 1
    fi
    if [[ -n "${FSUSBLOG_RELEASE_MANIFEST:-}" && -f "$FSUSBLOG_RELEASE_MANIFEST" ]]; then
        RELEASE_PROFILE_ID="$(jq -r '.runtimeProfile.id // empty' "$FSUSBLOG_RELEASE_MANIFEST")"
        RELEASE_PROFILE_MANIFEST_DIGEST="$(jq -r '.runtimeProfile.manifestDigest // empty' "$FSUSBLOG_RELEASE_MANIFEST")"
        RELEASE_PROFILE_DIGEST="$(jq -r '.runtimeProfile.profileDigest // empty' "$FSUSBLOG_RELEASE_MANIFEST")"
        if [[ "$FSUSBLOG_RUNTIME_PROFILE_ID" != "$RELEASE_PROFILE_ID" ||
            "$FSUSBLOG_RUNTIME_PROFILE_MANIFEST_DIGEST" != "$RELEASE_PROFILE_MANIFEST_DIGEST" ||
            "$FSUSBLOG_RUNTIME_PROFILE_DIGEST" != "$RELEASE_PROFILE_DIGEST" ]]; then
            echo "runtime matrix profile identity does not match the release manifest" >&2
            exit 1
        fi
    fi
    RUNTIME_MATRIX_COMMIT_SHA="$(git -C "$ROOT_DIR" rev-parse HEAD)"
    node "$ROOT_DIR/tools/runtime-profiles/check-runtime-publish-evidence.mjs" \
        --evidence "$RUNTIME_MATRIX_SOURCE" \
        --expected-commit-sha "$RUNTIME_MATRIX_COMMIT_SHA" \
        --expected-profile-id "$FSUSBLOG_RUNTIME_PROFILE_ID" \
        --expected-profile-manifest-digest "$FSUSBLOG_RUNTIME_PROFILE_MANIFEST_DIGEST" \
        --expected-profile-digest "$FSUSBLOG_RUNTIME_PROFILE_DIGEST" >/dev/null
    RUNTIME_MATRIX_ARTIFACT="$(CopyIfPresent "$RUNTIME_MATRIX_SOURCE" runtime-publish-matrix.json)"
    RUNTIME_MATRIX_STATUS_VALUE="ok"
fi
TEST_PLAN_ARTIFACT="$(CopyIfPresent "$ROOT_DIR/.tmp/release-evidence/test-plan.json" test-plan.json)"
JOB_SUMMARIES="$(CopyIfPresent "$ROOT_DIR/.tmp/release-evidence/jobs" job-summaries)"
ENDPOINT_DEPTH_SUMMARY="$(CopyIfPresent "$ROOT_DIR/.tmp/release-evidence/endpoint-depth-summary.json" endpoint-depth-summary.json)"
DATA_SCALE_SUMMARY="$(CopyIfPresent "$ROOT_DIR/.tmp/release-evidence/data-scale-summary.json" data-scale-summary.json)"
PERF_SUMMARY_ARTIFACT="$(CopyIfPresent "$ROOT_DIR/.tmp/release-evidence/perf-summary.json" perf-summary.json)"
PERFORMANCE_SATURATION_V2="$(CopyIfPresent "$ROOT_DIR/.tmp/perf/release-summaries/performance-saturation-v2.json" performance-saturation-v2.json)"
SECURITY_DEPTH_SUMMARY="$(CopyIfPresent "$ROOT_DIR/.tmp/release-evidence/security-depth-summary.json" security-depth-summary.json)"
FUZZ_SEEDS_SUMMARY="$(CopyIfPresent "$ROOT_DIR/.tmp/release-evidence/fuzz-seeds.json" fuzz-seeds.json)"
BUSINESS_STATE_SUMMARY="$(CopyIfPresent "$ROOT_DIR/.tmp/release-evidence/playwright-business-state-summary.json" playwright-business-state-summary.json)"
AOT_CACHE_RESILIENCE_SUMMARY="$(CopyIfPresent "$ROOT_DIR/.tmp/release-evidence/aot-cache-resilience-summary.json" aot-cache-resilience-summary.json)"
HYDRATION_LONG_SMOKE_SUMMARY="$(CopyIfPresent "$ROOT_DIR/.tmp/release-evidence/hydration-long-smoke-summary.json" hydration-long-smoke-summary.json)"
PUBLIC_HYDRATION_DETECTOR_SUMMARY="null"
PUBLIC_HYDRATION_CLOCK_MATRIX_SUMMARY="$(CopyIfPresent "$ROOT_DIR/.tmp/release-evidence/public-hydration-clock-matrix-summary.json" public-hydration-clock-matrix-summary.json)"
PUBLIC_HYDRATION_BROWSER_ENV_SUMMARY="$(CopyIfPresent "$ROOT_DIR/.tmp/release-evidence/public-hydration-browser-env-summary.json" public-hydration-browser-env-summary.json)"
PUBLIC_HYDRATION_PAYLOAD_FIXTURE_SUMMARY="$(CopyIfPresent "$ROOT_DIR/.tmp/release-evidence/public-hydration-payload-fixture-summary.json" public-hydration-payload-fixture-summary.json)"
PUBLIC_HYDRATION_DOM_DIFF_SUMMARY="$(CopyIfPresent "$ROOT_DIR/.tmp/release-evidence/public-hydration-dom-diff-summary.json" public-hydration-dom-diff-summary.json)"
PUBLIC_HYDRATION_SIDECAR_SUMMARY="$(CopyIfPresent "$ROOT_DIR/.tmp/release-evidence/public-hydration-sidecar-summary.json" public-hydration-sidecar-summary.json)"
PUBLIC_HYDRATION_MATRIX_SUMMARY="$(CopyIfPresent "$ROOT_DIR/.tmp/release-evidence/public-hydration-matrix-summary.json" public-hydration-matrix-summary.json)"
UX_ARTIFACT="$(CopyIfPresent "$ROOT_DIR/.tmp/ux" ux)"
UX_VIEWPORT_SUMMARY="$(CopyIfPresent "$ROOT_DIR/.tmp/release-evidence/ux-viewport-summary.json" ux-viewport-summary.json)"
FRONTEND_RENDER_PRESSURE_SUMMARY="$(CopyIfPresent "$ROOT_DIR/.tmp/release-evidence/frontend-render-pressure-summary.json" frontend-render-pressure-summary.json)"
FRONTEND_RENDER_STRUCTURE_SUMMARY="$(CopyIfPresent "$ROOT_DIR/.tmp/release-evidence/frontend-render-structure-summary.json" frontend-render-structure-summary.json)"
THEME_CSS_SAFETY_SOURCE="$ROOT_DIR/.tmp/release-evidence/theme-css-safety-summary.json"
THEME_CSS_SAFETY_STATUS_VALUE="missing"
if [[ -f "$THEME_CSS_SAFETY_SOURCE" ]]; then
    node "$ROOT_DIR/tools/release/theme-css-safety-evidence.mjs" "$THEME_CSS_SAFETY_SOURCE" >/dev/null
    THEME_CSS_SAFETY_STATUS_VALUE="ok"
fi
THEME_CSS_SAFETY_SUMMARY="$(CopyIfPresent "$THEME_CSS_SAFETY_SOURCE" theme-css-safety-summary.json)"
FONT_LICENSE_SOURCE="$ROOT_DIR/.tmp/release-evidence/font-license-summary.json"
FONT_LICENSE_STATUS_VALUE="missing"
if [[ ! -f "$FONT_LICENSE_SOURCE" && -n "${FSUSBLOG_DATA_ROOT:-}" ]]; then
    node "$ROOT_DIR/tools/release/font-license-evidence.mjs" \
        --generate "$FSUSBLOG_DATA_ROOT/fonts" \
        --output "$FONT_LICENSE_SOURCE" >/dev/null
fi
if [[ -f "$FONT_LICENSE_SOURCE" ]]; then
    node "$ROOT_DIR/tools/release/font-license-evidence.mjs" "$FONT_LICENSE_SOURCE" >/dev/null
    FONT_LICENSE_STATUS_VALUE="ok"
fi
FONT_LICENSE_SUMMARY="$(CopyIfPresent "$FONT_LICENSE_SOURCE" font-license-summary.json)"
PUBLISH_ARTIFACTS_SUMMARY="$(CopyIfPresent "$ROOT_DIR/.tmp/release-evidence/publish-artifacts-summary.json" publish-artifacts-summary.json)"
BACKEND_QPS_SUMMARY="$(CopyIfPresent "$ROOT_DIR/.tmp/release-evidence/backend-qps-summary.json" backend-qps-summary.json)"
MEMORY_LEAK_SUMMARY="$(CopyIfPresent "$ROOT_DIR/.tmp/release-evidence/memory-leak-summary.json" memory-leak-summary.json)"
OPEN_HANDLE_SUMMARY="$(CopyIfPresent "$ROOT_DIR/.tmp/release-evidence/open-handle-summary.json" open-handle-summary.json)"
AEDS_FRAME_COST_SUMMARY="$(CopyIfPresent "$ROOT_DIR/.tmp/release-evidence/aeds-frame-cost-summary.json" aeds-frame-cost-summary.json)"
AEDS_COMPRESSION_PROFILE_SUMMARY="$(CopyIfPresent "$ROOT_DIR/.tmp/release-evidence/aeds-compression-profile-summary.json" aeds-compression-profile-summary.json)"
AEDS_DECODE_BUDGET_SUMMARY="$(CopyIfPresent "$ROOT_DIR/.tmp/release-evidence/aeds-decode-budget-summary.json" aeds-decode-budget-summary.json)"
AEDS_WASM_BROWSER_SUMMARY="$(CopyIfPresent "$ROOT_DIR/.tmp/release-evidence/aeds-wasm-browser-summary.json" aeds-wasm-browser-summary.json)"
DOC_SYNC_SUMMARY="$(CopyIfPresent "$ROOT_DIR/.tmp/release-evidence/doc-sync-summary.json" doc-sync-summary.json)"
DOM_BUDGET_SUMMARY="$(CopyIfPresent "$ROOT_DIR/.tmp/frontend/dom-budget.json" dom-budget.json)"
ROUTE_RENDER_PRESSURE_SUMMARY="$(CopyIfPresent "$ROOT_DIR/.tmp/frontend/route-render-pressure.json" route-render-pressure.json)"
MARKDOWN_RENDER_BUDGET_SUMMARY="$(CopyIfPresent "$ROOT_DIR/.tmp/frontend/markdown-render-budget.json" markdown-render-budget.json)"
AEDS_DECODE_BUDGET_FRONTEND_SUMMARY="$(CopyIfPresent "$ROOT_DIR/.tmp/frontend/aeds-decode-budget/summary.json" aeds-decode-budget-frontend-summary.json)"
AEDS_WASM_BROWSER_FRONTEND_SUMMARY="$(CopyIfPresent "$ROOT_DIR/.tmp/frontend/aeds-wasm-browser/summary.json" aeds-wasm-browser-frontend-summary.json)"
DOM_DEPTH_STATIC_SUMMARY="$(CopyIfPresent "$ROOT_DIR/.tmp/frontend/dom-depth-static.json" dom-depth-static.json)"
FAULT_ARTIFACT="$(CopyIfPresent "$FAULT_DIR" fault-injection)"
SOAK_ARTIFACT="$(CopyIfPresent "$SOAK_DIR" soak)"
FUZZ_ARTIFACT="$(CopyIfPresent "$FUZZ_DIR" fuzz)"
AUTHENTICATED_DAST="$(CopyIfPresent "$SECURITY_DIR/authenticated-dast" authenticated-dast)"
GATE_LOGS="$(CopyIfPresent "$GATE_LOG_DIR" gate-logs)"
VISUAL_GATE_SKIP="$(CopyIfPresent "$GATE_LOG_DIR/visual-gate-skip.json" visual-gate-skip.json)"
RUNTIME_TUNING_SUMMARY="$(RuntimeTuningJson)"

PRODUCTION_STATUS_DIGEST="$(ArtifactDigestJson "$PRODUCTION_STATUS")"
PRODUCTION_REQUEST_DIGEST="$(ArtifactDigestJson "$PRODUCTION_REQUEST")"
PRODUCTION_LIVE_DIGEST="$(ArtifactDigestJson "$PRODUCTION_LIVE")"
FIREWALL_POLICY_DIGEST="$(ArtifactDigestJson "$FIREWALL_POLICY")"
DNS_READY_DIGEST="$(ArtifactDigestJson "$DNS_READY")"
DNS_DELEGATION_DIGEST="$(ArtifactDigestJson "$DNS_DELEGATION")"
RELEASE_ROLLOUT_DIGEST="$(ArtifactDigestJson "$RELEASE_ROLLOUT")"
RUNTIME_MATRIX_DIGEST="$(ArtifactDigestJson "$RUNTIME_MATRIX_ARTIFACT")"

PRODUCTION_STATUS_VALUE="$(JsonStatusOrMissing "$SECURITY_DIR/production-exposure-status.json")"
LIVE_STATUS_VALUE="$(ResultStatusOrMissing "$SECURITY_DIR/production-exposure-live.json")"
DNS_READY_STATUS_VALUE="$(ResultStatusOrMissing "$SECURITY_DIR/production-dns-readiness.json")"
DNS_DELEGATION_STATUS_VALUE="$(ResultStatusOrMissing "$SECURITY_DIR/production-dns-delegation.json")"
FIREWALL_POLICY_STATUS_VALUE="$([[ "$FIREWALL_POLICY" == "null" ]] && printf 'missing' || printf 'present')"
ATTACK_MATRIX_STATUS_VALUE="$(JsonStatusOrMissing "$SECURITY_DIR/attack-matrix.json")"
PERMISSION_MATRIX_STATUS_VALUE="$(JsonStatusOrMissing "$SECURITY_DIR/permission-matrix.json")"
SUPPLY_CHAIN_STATUS_VALUE="$(JsonStatusOrMissing "$SECURITY_DIR/supply-chain/summary.json")"
SBOM_STATUS_VALUE="$(JsonStatusOrMissing "$SECURITY_DIR/sbom/summary.json")"
BACKUP_RESTORE_STATUS_VALUE="$(BackupRestoreStatusOrMissing "$OPERATIONS_DIR/backup-restore-drill.json")"
POST_DEPLOY_SMOKE_STATUS_VALUE="$(PostDeploySmokeStatusOrMissing "$OPERATIONS_DIR/post-deploy-smoke.json")"
GATEWAY_TRANSITION_STATUS_VALUE="$(GatewayTransitionStatusOrMissing "$GATEWAY_TRANSITION_SOURCE")"
RELEASE_ROLLOUT_STATUS_VALUE="$(ReleaseRolloutStatusOrMissing "$RELEASE_ROLLOUT_SOURCE")"
SLO_STATUS_VALUE="$(JsonStatusOrMissing "$OPERATIONS_DIR/slo-alert-fixture.json")"
SLO_CRITICAL_COUNT="$(SloCriticalCountOrZero "$OPERATIONS_DIR/slo-alert-fixture.json")"
RETENTION_STATUS_VALUE="$(JsonStatusOrMissing "$OPERATIONS_DIR/retention-cleanup.json")"
IMAGE_DIGEST_VALUE="${FSUSBLOG_IMAGE_DIGEST:-unknown}"
IMAGE_DIGEST_STATUS="$([[ "$IMAGE_DIGEST_VALUE" == "unknown" || -z "$IMAGE_DIGEST_VALUE" ]] && printf 'missing' || printf 'present')"
RELEASE_MANIFEST_FILE="${FSUSBLOG_RELEASE_MANIFEST:-}"
RELEASE_IDENTITY_STATUS="missing"
RELEASE_IDENTITY_MANIFEST='{"status":"missing"}'
if [[ -n "$RELEASE_MANIFEST_FILE" && -f "$RELEASE_MANIFEST_FILE" ]]; then
    release_check_args=(
        --manifest "$RELEASE_MANIFEST_FILE"
        --release-id "${FSUSBLOG_RELEASE_ID:-}"
        --image-ref "${FSUSBLOG_IMAGE_REF:-}"
        --image-digest "${FSUSBLOG_IMAGE_DIGEST:-}"
        --commit-sha "${FSUSBLOG_COMMIT_SHA:-}"
    )
    if [[ -n "${FSUSBLOG_RELEASE_ID:-}" &&
        -n "${FSUSBLOG_IMAGE_REF:-}" &&
        -n "${FSUSBLOG_IMAGE_DIGEST:-}" &&
        -n "${FSUSBLOG_COMMIT_SHA:-}" &&
        "${FSUSBLOG_RELEASE_SLOT:-}" =~ ^[a-z][a-z0-9-]{0,31}$ ]] &&
        node "$ROOT_DIR/tools/release/check-release-manifest.mjs" "${release_check_args[@]}" >/dev/null; then
        RELEASE_IDENTITY_STATUS="ok"
        RELEASE_IDENTITY_MANIFEST="$(jq -c --arg releaseSlot "$FSUSBLOG_RELEASE_SLOT" '. + {releaseSlot: $releaseSlot}' "$RELEASE_MANIFEST_FILE")"
    else
        RELEASE_IDENTITY_STATUS="failed"
        RELEASE_IDENTITY_MANIFEST='{"status":"failed"}'
    fi
fi
EXTERNAL_BLOCKERS="$(BlockersJsonOrEmpty "$SECURITY_DIR/production-exposure-status.json")"
REQUEST_SUMMARY="$(RequestSummaryJson)"
COVERAGE_SUMMARY="$(CoverageSummaryJson)"
COVERAGE_STATUS_VALUE="$(jq -r '.status // "missing"' <<<"$COVERAGE_SUMMARY" 2>/dev/null || printf 'invalid')"
ZAP_STATUS_VALUE="$(ZapStatusOrMissing "$SECURITY_DIR/zap")"
FAULT_STATUS_VALUE="$(FaultInjectionStatusOrMissing "$FAULT_DIR/summary.json")"
SOAK_STATUS_VALUE="$(ShortSoakStatusOrMissing "$SOAK_DIR/short/summary.json")"
AUTHENTICATED_DAST_STATUS_VALUE="$(AuthenticatedDastStatusOrMissing "$SECURITY_DIR/authenticated-dast/summary.json")"
LOCAL_RUNTIME_EXPOSURE_STATUS_VALUE="$(LocalRuntimeExposureStatusOrMissing "$SECURITY_DIR/local-runtime-exposure.json")"
WASM_FUZZ_STATUS_VALUE="$(WasmFuzzStatusOrMissing "$FUZZ_DIR/wasm/summary.json")"
UX_VIEWPORT_STATUS_VALUE="$(JsonStatusOrMissing "$ROOT_DIR/.tmp/release-evidence/ux-viewport-summary.json")"
FRONTEND_RENDER_PRESSURE_STATUS_VALUE="$(JsonStatusOrMissing "$ROOT_DIR/.tmp/release-evidence/frontend-render-pressure-summary.json")"
FRONTEND_RENDER_STRUCTURE_STATUS_VALUE="$(JsonStatusOrMissing "$ROOT_DIR/.tmp/release-evidence/frontend-render-structure-summary.json")"
PUBLISH_ARTIFACTS_STATUS_VALUE="$(JsonStatusOrMissing "$ROOT_DIR/.tmp/release-evidence/publish-artifacts-summary.json")"
BACKEND_QPS_STATUS_VALUE="$(JsonStatusOrMissing "$ROOT_DIR/.tmp/release-evidence/backend-qps-summary.json")"
MEMORY_LEAK_STATUS_VALUE="$(JsonStatusOrMissing "$ROOT_DIR/.tmp/release-evidence/memory-leak-summary.json")"
OPEN_HANDLE_STATUS_VALUE="$(JsonStatusOrMissing "$ROOT_DIR/.tmp/release-evidence/open-handle-summary.json")"
AOT_CACHE_RESILIENCE_STATUS_VALUE="$(JsonStatusOrMissing "$ROOT_DIR/.tmp/release-evidence/aot-cache-resilience-summary.json")"
AEDS_FRAME_COST_STATUS_VALUE="$(JsonStatusOrMissing "$ROOT_DIR/.tmp/release-evidence/aeds-frame-cost-summary.json")"
AEDS_COMPRESSION_PROFILE_STATUS_VALUE="$(JsonStatusOrMissing "$ROOT_DIR/.tmp/release-evidence/aeds-compression-profile-summary.json")"
AEDS_DECODE_BUDGET_STATUS_VALUE="$(JsonStatusOrMissing "$ROOT_DIR/.tmp/release-evidence/aeds-decode-budget-summary.json")"
AEDS_WASM_BROWSER_STATUS_VALUE="$(JsonStatusOrMissing "$ROOT_DIR/.tmp/release-evidence/aeds-wasm-browser-summary.json")"
DOC_SYNC_STATUS_VALUE="$(JsonStatusOrMissing "$ROOT_DIR/.tmp/release-evidence/doc-sync-summary.json")"
PUBLIC_HYDRATION_DETECTOR_STATUS_VALUE="diagnostic-only"
PUBLIC_HYDRATION_CLOCK_MATRIX_STATUS_VALUE="$(JsonStatusOrMissing "$ROOT_DIR/.tmp/release-evidence/public-hydration-clock-matrix-summary.json")"
PUBLIC_HYDRATION_BROWSER_ENV_STATUS_VALUE="$(JsonStatusOrMissing "$ROOT_DIR/.tmp/release-evidence/public-hydration-browser-env-summary.json")"
PUBLIC_HYDRATION_PAYLOAD_FIXTURE_STATUS_VALUE="$(JsonStatusOrMissing "$ROOT_DIR/.tmp/release-evidence/public-hydration-payload-fixture-summary.json")"
PUBLIC_HYDRATION_DOM_DIFF_STATUS_VALUE="$(JsonStatusOrMissing "$ROOT_DIR/.tmp/release-evidence/public-hydration-dom-diff-summary.json")"
PUBLIC_HYDRATION_SIDECAR_STATUS_VALUE="$(JsonStatusOrMissing "$ROOT_DIR/.tmp/release-evidence/public-hydration-sidecar-summary.json")"
PUBLIC_HYDRATION_MATRIX_STATUS_VALUE="$(JsonStatusOrMissing "$ROOT_DIR/.tmp/release-evidence/public-hydration-matrix-summary.json")"

MANIFEST_STATUS="collected-ok"
if [[ "$PRODUCTION_STATUS_VALUE" != "ok" ||
    "$LIVE_STATUS_VALUE" != "ok" ||
    "$DNS_READY_STATUS_VALUE" != "ok" ||
    "$DNS_DELEGATION_STATUS_VALUE" != "ok" ||
    "$FIREWALL_POLICY_STATUS_VALUE" != "present" ||
    "$ATTACK_MATRIX_STATUS_VALUE" != "ok" ||
    "$PERMISSION_MATRIX_STATUS_VALUE" != "ok" ||
    "$ZAP_STATUS_VALUE" != "ok" ||
    "$SUPPLY_CHAIN_STATUS_VALUE" != "ok" ||
    "$SBOM_STATUS_VALUE" != "ok" ||
    "$COVERAGE_STATUS_VALUE" != "ok" ||
    "$BACKUP_RESTORE_STATUS_VALUE" != "ok" ||
    "$POST_DEPLOY_SMOKE_STATUS_VALUE" != "ok" ||
    "$GATEWAY_TRANSITION_STATUS_VALUE" != "ok" ||
    "$RELEASE_ROLLOUT_STATUS_VALUE" != "ok" ||
    "$SLO_STATUS_VALUE" != "ok" ||
    "$SLO_CRITICAL_COUNT" != "0" ||
    "$FAULT_STATUS_VALUE" != "ok" ||
    "$SOAK_STATUS_VALUE" != "ok" ||
    "$AUTHENTICATED_DAST_STATUS_VALUE" != "ok" ||
    "$WASM_FUZZ_STATUS_VALUE" != "ok" ||
    "$FRONTEND_RENDER_STRUCTURE_STATUS_VALUE" != "ok" ||
    "$THEME_CSS_SAFETY_STATUS_VALUE" != "ok" ||
    "$FONT_LICENSE_STATUS_VALUE" != "ok" ||
    "$AOT_CACHE_RESILIENCE_STATUS_VALUE" != "success" ||
    "$PUBLIC_HYDRATION_CLOCK_MATRIX_STATUS_VALUE" != "success" ||
    "$PUBLIC_HYDRATION_BROWSER_ENV_STATUS_VALUE" != "success" ||
    "$PUBLIC_HYDRATION_PAYLOAD_FIXTURE_STATUS_VALUE" != "success" ||
    "$PUBLIC_HYDRATION_DOM_DIFF_STATUS_VALUE" != "success" ||
    "$PUBLIC_HYDRATION_SIDECAR_STATUS_VALUE" != "success" ||
    "$PUBLIC_HYDRATION_MATRIX_STATUS_VALUE" != "success" ||
    "$BACKEND_QPS_STATUS_VALUE" != "ok" ||
    "$MEMORY_LEAK_STATUS_VALUE" != "ok" ||
    "$OPEN_HANDLE_STATUS_VALUE" != "ok" ||
    "$AEDS_DECODE_BUDGET_STATUS_VALUE" != "ok" ||
    "$DOC_SYNC_STATUS_VALUE" != "ok" ||
    "$RUNTIME_MATRIX_STATUS_VALUE" != "ok" ||
    "$RELEASE_IDENTITY_STATUS" != "ok" ||
    "$IMAGE_DIGEST_STATUS" != "present" ]]; then
    MANIFEST_STATUS="collected-blocked"
fi

cat >"$OUT_DIR/manifest.json" <<JSON
{
  "status": "$MANIFEST_STATUS",
  "releaseStamp": "$STAMP",
  "generatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "gitRevision": "$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)",
  "commitSha": "${FSUSBLOG_COMMIT_SHA:-$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || echo unknown)}",
  "workflowRun": {
    "id": "${GITHUB_RUN_ID:-unknown}",
    "attempt": "${GITHUB_RUN_ATTEMPT:-unknown}",
    "workflow": "${GITHUB_WORKFLOW:-unknown}"
  },
  "imageDigest": "$IMAGE_DIGEST_VALUE",
  "releaseIdentity": $RELEASE_IDENTITY_MANIFEST,
  "publishArtifacts": $(if [[ -f "$ROOT_DIR/.tmp/release-evidence/publish-artifacts-summary.json" ]]; then jq -c '.' "$ROOT_DIR/.tmp/release-evidence/publish-artifacts-summary.json"; else jq -n -c '{status: "missing", wwwrootBytes: 0, clientRuntimeBytes: 0, totalPublishBytes: 0, fileCount: 0, largestFiles: []}'; fi),
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
    "gatewayTransition": $GATEWAY_TRANSITION,
    "releaseRollout": $RELEASE_ROLLOUT,
    "releaseRolloutBundle": $RELEASE_ROLLOUT_BUNDLE,
    "sloAlerts": $SLO_ALERTS,
    "retentionCleanup": $RETENTION_CLEANUP,
    "coverage": $COVERAGE_ARTIFACT,
    "perf": $PERF_ARTIFACT,
    "runtimePublishMatrix": $RUNTIME_MATRIX_ARTIFACT,
    "testPlan": $TEST_PLAN_ARTIFACT,
    "jobSummaries": $JOB_SUMMARIES,
    "endpointDepthSummary": $ENDPOINT_DEPTH_SUMMARY,
    "dataScaleSummary": $DATA_SCALE_SUMMARY,
    "perfSummary": $PERF_SUMMARY_ARTIFACT,
    "performanceSaturationV2": $PERFORMANCE_SATURATION_V2,
    "securityDepthSummary": $SECURITY_DEPTH_SUMMARY,
    "fuzzSeeds": $FUZZ_SEEDS_SUMMARY,
    "playwrightBusinessStateSummary": $BUSINESS_STATE_SUMMARY,
    "aotCacheResilienceSummary": $AOT_CACHE_RESILIENCE_SUMMARY,
    "hydrationLongSmokeSummary": $HYDRATION_LONG_SMOKE_SUMMARY,
    "publicHydrationDetectorSummary": $PUBLIC_HYDRATION_DETECTOR_SUMMARY,
    "publicHydrationClockMatrixSummary": $PUBLIC_HYDRATION_CLOCK_MATRIX_SUMMARY,
    "publicHydrationBrowserEnvSummary": $PUBLIC_HYDRATION_BROWSER_ENV_SUMMARY,
    "publicHydrationPayloadFixtureSummary": $PUBLIC_HYDRATION_PAYLOAD_FIXTURE_SUMMARY,
    "publicHydrationDomDiffSummary": $PUBLIC_HYDRATION_DOM_DIFF_SUMMARY,
    "publicHydrationSidecarSummary": $PUBLIC_HYDRATION_SIDECAR_SUMMARY,
    "publicHydrationMatrixSummary": $PUBLIC_HYDRATION_MATRIX_SUMMARY,
    "ux": $UX_ARTIFACT,
    "uxViewportSummary": $UX_VIEWPORT_SUMMARY,
    "frontendRenderPressureSummary": $FRONTEND_RENDER_PRESSURE_SUMMARY,
    "frontendRenderStructureSummary": $FRONTEND_RENDER_STRUCTURE_SUMMARY,
    "themeCssSafetySummary": $THEME_CSS_SAFETY_SUMMARY,
    "fontLicenseSummary": $FONT_LICENSE_SUMMARY,
    "publishArtifactsSummary": $PUBLISH_ARTIFACTS_SUMMARY,
    "backendQpsSummary": $BACKEND_QPS_SUMMARY,
    "memoryLeakSummary": $MEMORY_LEAK_SUMMARY,
    "openHandleSummary": $OPEN_HANDLE_SUMMARY,
    "aedsFrameCostSummary": $AEDS_FRAME_COST_SUMMARY,
    "aedsCompressionProfileSummary": $AEDS_COMPRESSION_PROFILE_SUMMARY,
    "aedsDecodeBudgetSummary": $AEDS_DECODE_BUDGET_SUMMARY,
    "aedsWasmBrowserSummary": $AEDS_WASM_BROWSER_SUMMARY,
    "docSyncSummary": $DOC_SYNC_SUMMARY,
    "domBudgetSummary": $DOM_BUDGET_SUMMARY,
    "routeRenderPressureSummary": $ROUTE_RENDER_PRESSURE_SUMMARY,
    "markdownRenderBudgetSummary": $MARKDOWN_RENDER_BUDGET_SUMMARY,
    "aedsDecodeBudgetFrontendSummary": $AEDS_DECODE_BUDGET_FRONTEND_SUMMARY,
    "aedsWasmBrowserFrontendSummary": $AEDS_WASM_BROWSER_FRONTEND_SUMMARY,
    "domDepthStaticSummary": $DOM_DEPTH_STATIC_SUMMARY,
    "faultInjection": $FAULT_ARTIFACT,
    "soak": $SOAK_ARTIFACT,
    "fuzz": $FUZZ_ARTIFACT,
    "authenticatedDast": $AUTHENTICATED_DAST,
    "localRuntimeExposure": $LOCAL_RUNTIME_EXPOSURE,
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
    "dnsDelegation": $DNS_DELEGATION_DIGEST,
    "releaseRollout": $RELEASE_ROLLOUT_DIGEST,
    "runtimePublishMatrix": $RUNTIME_MATRIX_DIGEST
  },
  "evidenceSummary": {
    "image": {
      "digest": "$IMAGE_DIGEST_VALUE",
      "status": "$IMAGE_DIGEST_STATUS",
      "releaseIdentityStatus": "$RELEASE_IDENTITY_STATUS"
    },
    "coverage": $COVERAGE_SUMMARY,
    "operations": {
      "backupRestoreDrill": "$BACKUP_RESTORE_STATUS_VALUE",
      "postDeploySmoke": "$POST_DEPLOY_SMOKE_STATUS_VALUE",
      "gatewayTransition": "$GATEWAY_TRANSITION_STATUS_VALUE",
      "releaseRollout": "$RELEASE_ROLLOUT_STATUS_VALUE",
      "sloAlerts": "$SLO_STATUS_VALUE",
      "sloCriticalFiring": $SLO_CRITICAL_COUNT,
      "retentionCleanup": "$RETENTION_STATUS_VALUE",
      "runtimeTuning": $RUNTIME_TUNING_SUMMARY
    },
    "gates": {
      "visualGateSkip": $VISUAL_GATE_SKIP,
      "uxViewport": "$UX_VIEWPORT_STATUS_VALUE",
      "frontendRenderPressure": "$FRONTEND_RENDER_PRESSURE_STATUS_VALUE",
      "frontendRenderStructure": "$FRONTEND_RENDER_STRUCTURE_STATUS_VALUE",
      "publicHydrationDetector": "$PUBLIC_HYDRATION_DETECTOR_STATUS_VALUE",
      "publicHydrationClockMatrix": "$PUBLIC_HYDRATION_CLOCK_MATRIX_STATUS_VALUE",
      "publicHydrationBrowserEnv": "$PUBLIC_HYDRATION_BROWSER_ENV_STATUS_VALUE",
      "publicHydrationPayloadFixture": "$PUBLIC_HYDRATION_PAYLOAD_FIXTURE_STATUS_VALUE",
      "publicHydrationDomDiff": "$PUBLIC_HYDRATION_DOM_DIFF_STATUS_VALUE",
      "publicHydrationSidecar": "$PUBLIC_HYDRATION_SIDECAR_STATUS_VALUE",
      "publicHydrationMatrix": "$PUBLIC_HYDRATION_MATRIX_STATUS_VALUE",
      "publicAotCacheResilience": "$AOT_CACHE_RESILIENCE_STATUS_VALUE",
      "publishArtifacts": "$PUBLISH_ARTIFACTS_STATUS_VALUE",
      "backendQps": "$BACKEND_QPS_STATUS_VALUE",
      "aedsFrameCost": "$AEDS_FRAME_COST_STATUS_VALUE",
      "aedsCompressionProfile": "$AEDS_COMPRESSION_PROFILE_STATUS_VALUE",
      "aedsDecodeBudget": "$AEDS_DECODE_BUDGET_STATUS_VALUE",
      "aedsWasmBrowser": "$AEDS_WASM_BROWSER_STATUS_VALUE",
      "docSync": "$DOC_SYNC_STATUS_VALUE"
    },
    "security": {
      "attackMatrix": "$ATTACK_MATRIX_STATUS_VALUE",
      "permissionMatrix": "$PERMISSION_MATRIX_STATUS_VALUE",
      "supplyChain": "$SUPPLY_CHAIN_STATUS_VALUE",
      "sbom": "$SBOM_STATUS_VALUE",
      "dastZap": "$ZAP_STATUS_VALUE",
      "authenticatedDast": "$AUTHENTICATED_DAST_STATUS_VALUE",
      "localRuntimeExposure": "$LOCAL_RUNTIME_EXPOSURE_STATUS_VALUE",
      "wasmFuzz": "$WASM_FUZZ_STATUS_VALUE"
    },
    "resilienceDepth": {
      "faultInjection": "$FAULT_STATUS_VALUE",
      "soak": "$SOAK_STATUS_VALUE",
      "memoryLeak": "$MEMORY_LEAK_STATUS_VALUE",
      "openHandle": "$OPEN_HANDLE_STATUS_VALUE"
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
    { "kind": "local-runtime-exposure", "artifact": $LOCAL_RUNTIME_EXPOSURE },
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

seal_args=("$OUT_DIR")
if [[ "$REQUIRE_OK" == "1" ]]; then
    seal_args+=(--require-ok)
fi
node "$ROOT_DIR/tools/operations/seal-release-evidence-bundle.mjs" "${seal_args[@]}"

echo "[release-evidence] wrote $OUT_DIR/manifest.json namespace=$RELEASE_NAMESPACE requireOk=$REQUIRE_OK"
