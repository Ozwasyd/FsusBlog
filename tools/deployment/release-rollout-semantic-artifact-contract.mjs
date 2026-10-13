import { validateStrongAssetCompatibilityEvidence } from './release-rollout-asset-compatibility-contract.mjs'
import { validateStrongTrafficEvidence } from './release-rollout-traffic-evidence-contract.mjs'

export function validateSemanticArtifact(name, value, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${name}: artifact must be a JSON object`)
    return
  }
  if (!['pass', 'ok', 'completed'].includes(value.status)) errors.push(`${name}: status is not successful`)
  if (name === 'publicTraffic') {
    requireZero(value, [
      'unexpectedResponseCount', 'deploymentFailureCount', 'connectionErrorCount',
      'gatewayErrorCount', 'unhandled5xxCount', 'inFlightAbortedCount', 'inFlightRequestCount'
    ], name, errors)
    if (!(Number(value.totalRequests) > 0)) errors.push(`${name}: totalRequests must be positive`)
    if (!(Number(value.releaseDistribution?.source ?? 0) > 0)) errors.push(`${name}: source release was not observed`)
    if (!(Number(value.releaseDistribution?.target ?? 0) > 0)) errors.push(`${name}: target release was not observed`)
    validateStrongTrafficEvidence(value, name, errors)
  } else if (name === 'notificationStream') {
    requireZero(value, ['missingEventCount', 'duplicateAppliedEventCount', 'duplicateBusinessEventCount'], name, errors)
    if (value.contractVersion !== 2
      || value.serviceRestartObserved !== true
      || value.cursorReplayVerified !== true
      || value.replayMissFullResyncVerified !== true
      || value.businessEventsExactlyOnce !== true
      || value.slowClientDidNotBlockDrain !== true
      || !notificationResyncEvidenceComplete(value)) {
      errors.push(`${name}: restart/replay/full-resync evidence is incomplete`)
    }
  } else if (name === 'assetCompatibility') {
    requireZero(value, ['notFoundCount', 'hashMismatchCount', 'connectionErrorCount'], name, errors)
    for (const scenario of ['delayedOldAssets', 'oldFrontendToNewBackend', 'newFrontendToOldBackend', 'oldServiceWorkerCache', 'retentionWindowAfterGc']) {
      if (value.scenarios?.[scenario] !== 'pass') errors.push(`${name}: scenario failed or missing: ${scenario}`)
    }
    validateStrongAssetCompatibilityEvidence(value, name, errors)
  } else if (name === 'workerReconciliation') {
    if (value.schema !== 'fsusblog.release-worker-reconciliation-evidence.v2' || value.mode !== 'normal') {
      errors.push(`${name}: final rollout requires normal-mode v2 worker reconciliation evidence`)
    }
    requireZero(value, ['duplicateEffectCount', 'staleGenerationCommitCount', 'lostAuditCount', 'lostVisitProjectionCount'], name, errors)
    if (value.buffersDrained !== true && value.durableReplayVerified !== true) errors.push(`${name}: neither drain nor durable replay was proven`)
    if (value.gracefulDrainVerified !== true) errors.push(`${name}: graceful source drain was not proven`)
    if (value.forcedSourceRecoveryRequired !== false || value.forcedSourceRecoveryVerified !== false) {
      errors.push(`${name}: destructive qualification cannot be embedded in the normal rollout`)
    }
    if (!value.checks || Object.values(value.checks).some(check => check !== true)) errors.push(`${name}: one or more normal worker checks did not pass`)
  } else if (name === 'resourceBudget') {
    if (value.withinBudget !== true) errors.push(`${name}: rollout exceeded resource budget`)
    if (!(Number(value.minimumSupported?.cpuCores) > 0) || !(Number(value.minimumSupported?.memoryMiB) > 0)) {
      errors.push(`${name}: minimum supported hardware is missing`)
    }
    if (!value.checks || Object.values(value.checks).some(check => check !== true)) errors.push(`${name}: one or more resource checks did not pass`)
  } else if (name === 'faultInjection') {
    const requiredCases = [
      'manifest-digest-mismatch', 'capacity-insufficient', 'current-admission-failure', 'candidate-readiness',
      'asset-hash-mismatch', 'gateway-reload-failure', 'active-fence-failure', 'public-probe-failure',
      'drain-timeout', 'source-stop-failure', 'host-interruption', 'redis-disconnect', 'postgres-disconnect'
    ]
    const cases = Array.isArray(value.cases) ? value.cases : []
    for (const requiredCase of requiredCases) {
      const item = cases.find(candidate => candidate.case === requiredCase)
      if (!item || item.status !== 'pass' || item.automated !== true) errors.push(`${name}: automated case missing or failed: ${requiredCase}`)
    }
  }
}

function notificationResyncEvidenceComplete(value) {
  if (!/^sha256:[0-9a-f]{64}$/u.test(String(value.inputBindings?.resyncScenario?.sha256 ?? ''))) return false
  const observations = Object.values(value.resync ?? {}).flatMap(items => Array.isArray(items) ? items : [])
  for (const phase of ['replay-miss', 'final']) {
    const phaseItems = observations.filter(item => item?.phase === phase && item?.status === 'pass')
    if (phaseItems.length < 2 || phaseItems.some(item => !Number.isSafeInteger(item.watermark)
      || !/^sha256:[0-9a-f]{64}$/u.test(String(item.contentSha256 ?? '')))) return false
  }
  return true
}

function requireZero(value, fields, name, errors) {
  for (const field of fields) {
    if (Number(value[field]) !== 0) errors.push(`${name}: ${field} must be zero`)
  }
}
