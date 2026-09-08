import crypto from 'node:crypto'
import path from 'node:path'
import { validatePublicAotWarmEvidence } from '../frontend/public-aot-warm-evidence.mjs'

export const ROLLOUT_STAGES = Object.freeze([
  'manifest-validate',
  'capacity-preflight',
  'backup-restore-gate',
  'expand-migration',
  'asset-materialize',
  'candidate-start',
  'candidate-readiness',
    'candidate-smoke',
    'compatibility-smoke',
    'gateway-switch',
    'source-drain',
    'active-fence',
    'public-verify',
    'source-stop',
    'release-evidence'
]);

export const STAGE_SCHEMA = 'fsusblog.release-rollout-stage-evidence.v1'
export const FINAL_SCHEMA = 'fsusblog.release-rollout-evidence.v1'
export const REQUIRED_FINAL_ARTIFACTS = Object.freeze([
  'publicTraffic',
  'notificationStream',
  'assetCompatibility',
  'workerReconciliation',
  'resourceBudget',
  'faultInjection'
])
export const REQUIRED_AUXILIARY_EVIDENCE = Object.freeze([
  'releaseManifest',
  'backupRestoreGate',
  'migrationExpand',
  'candidateReadiness',
  'assetMaterialization',
  'retentionPrepared',
  'retainedAssets',
  'publicAotWarm',
  'candidateSmoke',
  'compatibilityMatrix',
  'gatewayTransition',
    'activeFenceAcquire',
    'activeFenceSourceRevoke',
    'activeFenceVerify',
    'challengeKindCutoverReceipt',
    'challengeKindCutoverAcceptance',
    'challengeKindCutoverGate',
    'perceptionCharacterV3Cutover',
    'publicTrafficCheckpoint',
    'sourceDrainSnapshot',
    'sourceDrainGate',
  'targetHealth',
  'retentionDrainComplete',
  'operatorNote'
])
const TRAFFIC_CATEGORIES = Object.freeze([
  'home', 'archive', 'article', 'binary', 'search', 'static',
  'login', 'refresh', 'protected-read', 'write', 'upload', 'admin-health'
])
const TRAFFIC_POLICY_STAGES = Object.freeze(['status:planned', ...ROLLOUT_STAGES, 'status:completed'])
const SHA256 = /^sha256:[0-9a-f]{64}$/u
const HMAC_SHA256 = /^hmac-sha256:[0-9a-f]{64}$/u

export function validateRecoveryResolution(records, errors) {
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record.status !== 'failed') continue
    const resolved = records.slice(index + 1).some(candidate => candidate.status === 'ok'
      && candidate.action === record.action
      && candidate.failedStage === record.failedStage)
    if (!resolved) errors.push(`rollout contains an unresolved failed recovery attempt: ${record.action ?? '<missing>'}`)
  }
}

export function validateAuxiliaryEvidence(name, value, state, errors, now) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${name}: auxiliary evidence must be a JSON object`)
    return
  }
  if (value.rolloutId !== undefined && value.rolloutId !== state.rolloutId) errors.push(`${name}: rolloutId mismatch`)
  if (value.releaseId !== undefined && name !== 'releaseManifest'
    && ![state.source.releaseId, state.target.releaseId].includes(value.releaseId)) errors.push(`${name}: releaseId is outside rollout identities`)
  if (value.target?.releaseId !== undefined && value.target.releaseId !== state.target.releaseId) errors.push(`${name}: target release mismatch`)
    if (value.source?.releaseId !== undefined && value.source.releaseId !== state.source.releaseId) {errors.push(`${name}: source release mismatch`)};
    if (Array.isArray(value.errors) && value.errors.length > 0) {errors.push(`${name}: errors must be empty`)};
    if (name === 'releaseManifest')
{
        if (value.schema !== 'fsusblog.release-manifest.v2'
      || value.releaseId !== state.target.releaseId
      || value.imageDigest !== state.target.imageDigest)
{
            errors.push(`${name}: immutable target identity mismatch`);
    }
    return
  }
  if (name === 'operatorNote') {
    if (value.schema !== 'fsusblog.release-rollout-operator-note.v1'
      || value.rolloutId !== state.rolloutId
      || typeof value.provided !== 'boolean'
      || typeof value.note !== 'string'
      || value.note.length > 4000) {
      errors.push(`${name}: structured operator note is invalid`)
    }
    return
  }
  if (name === 'publicAotWarm') {
    const publicAotErrors = validatePublicAotWarmEvidence(value, {
      expectedRelease: state.target.releaseId,
      expectedSlot: state.target.slot,
      expectedPublicOrigin: value.expectedPublicOrigin,
      requireScope: 'all',
      maxAgeSeconds: Number.MAX_SAFE_INTEGER,
      now
    })
        errors.push(...publicAotErrors.map((error) => `${name}: ${error}`));
        return;
    }
    const targetGeneration = Number(state.target.runtimeGeneration ?? state.target.generation);
    if (name === 'challengeKindCutoverReceipt')
{
        if (value.schemaVersion !== 'fsus.security-challenge-kind-cutover-receipt.v1'
      || value.accepted !== true || value.status !== 'applied' || value.dryRun !== false
      || value.releaseId !== state.target.releaseId || value.slot !== state.target.slot
      || value.generation !== targetGeneration)
{
            errors.push(`${name}: applied receipt is not bound to the target release fence`);
        }
        return;
    }
    if (name === 'challengeKindCutoverAcceptance')
{
        if (value.schemaVersion !== 'fsus.security-challenge-kind-cutover-acceptance.v1'
      || value.accepted !== true || value.releaseId !== state.target.releaseId
      || value.slot !== state.target.slot || value.generation !== targetGeneration)
{
            errors.push(`${name}: verifier acceptance is not bound to the target release fence`);
        }
        return;
    }
    if (name === 'challengeKindCutoverGate')
{
        if (value.schema !== 'fsusblog.release-challenge-kind-cutover-gate.v1'
      || value.status !== 'pass' || value.rolloutId !== state.rolloutId
      || value.releaseId !== state.target.releaseId || value.slot !== state.target.slot
      || value.generation !== targetGeneration
      || value.lifecycle?.destructiveCutoverStarted !== true
      || value.lifecycle?.activationCommitted !== false
      || value.lifecycle?.stage !== 'source-drain'
      || value.bindings?.backendFence !== true || value.bindings?.frontend !== true
      || value.bindings?.staticAssets !== true || value.bindings?.cutover !== true
      || value.bindings?.perceptionCharacterV3 !== true)
{
            errors.push(`${name}: cross-layer target binding gate is invalid`);
        }
        return;
    }
    if (name === 'perceptionCharacterV3Cutover')
{
        if (value.schemaVersion !== 'fsus.security.perception-character-v3-cutover-receipt.v1'
      || value.accepted !== true || value.status !== 'activated' || value.dryRun !== false
      || value.releaseId !== state.target.releaseId || value.slot !== state.target.slot
      || value.generation !== targetGeneration)
{
            errors.push(`${name}: V3 cutover is not bound to the target release fence`);
        }
        return;
    }
    if (value.status !== undefined && !['pass', 'ok', 'healthy', 'completed', 'dry-run'].includes(value.status))
{
        errors.push(`${name}: status is not successful`);
    }
}

/** Replay sealed rollout bytes with an explicit reader and verification time; never produce evidence. */
export function verifyReleaseRolloutEvidence(evidence, { evidencePath, readBytes, now }) {
  if (!Number.isFinite(now) || typeof readBytes !== 'function') {
    throw new Error('rollout verification requires explicit time and byte reader')
  }
  const snapshots = new Map()
  const bytesFor = (file) => {
    if (!snapshots.has(file)) snapshots.set(file, Buffer.from(readBytes(file)))
    return snapshots.get(file)
  }
  const fileMetadata = (file) => {
    const bytes = bytesFor(file)
    return { path: file, bytes: bytes.length, sha256: sha256Text(bytes) }
  }
  const readJson = (file) => JSON.parse(bytesFor(file).toString('utf8'))

  const errors = []
  if (evidence.schema !== FINAL_SCHEMA) errors.push(`schema must be ${FINAL_SCHEMA}`)
  if (evidence.status !== 'pass') errors.push('rollout evidence status must be pass')
  if (!Array.isArray(evidence.errors) || evidence.errors.length !== 0) errors.push('rollout evidence errors must be empty')
  if (!Array.isArray(evidence.stages) || evidence.stages.map(item => item.stage).join('\n') !== ROLLOUT_STAGES.join('\n')) {
    errors.push('rollout evidence stage order is incomplete')
  } else {
    for (const expectedStage of ROLLOUT_STAGES) {
      const stage = evidence.stages.find(item => item.stage === expectedStage)
      const metadata = stage?.evidence
      if (!metadata || !/^sha256:[0-9a-f]{64}$/u.test(String(metadata.sha256 ?? ''))) {
        errors.push(`rollout stage evidence is invalid: ${expectedStage}`)
        continue
      }
      try {
        const current = fileMetadata(metadata.path)
        if (current.sha256 !== metadata.sha256 || current.bytes !== metadata.bytes) {
          errors.push(`stage evidence changed after seal: ${expectedStage}`)
          continue
        }
        const parsed = readJson(metadata.path)
        if (parsed.schema !== STAGE_SCHEMA || parsed.rolloutId !== evidence.rolloutId || parsed.stage !== expectedStage || parsed.status !== 'ok') {
          errors.push(`stage evidence identity/status is invalid: ${expectedStage}`)
        }
        for (const stream of ['stdout', 'stderr']) {
          const output = parsed.output?.[stream]
          if (!output) continue
          const currentOutput = fileMetadata(output.path)
          if (currentOutput.sha256 !== output.sha256 || currentOutput.bytes !== output.bytes) {
            errors.push(`stage ${expectedStage} ${stream} changed after seal`)
          }
        }
      } catch (error) {
        errors.push(`${expectedStage}: ${message(error)}`)
      }
      if (!Array.isArray(stage.attemptEvidence) || stage.attemptEvidence.length !== stage.attempts) {
        errors.push(`rollout stage attempt evidence is incomplete: ${expectedStage}`)
      } else {
        for (const attempt of stage.attemptEvidence) {
          if (!attempt.evidence) {
            errors.push(`rollout stage attempt evidence is invalid: ${expectedStage} attempt ${attempt.attempt ?? '<missing>'}`)
            continue
          }
          try {
            const currentAttempt = fileMetadata(attempt.evidence.path)
            if (currentAttempt.sha256 !== attempt.evidence.sha256 || currentAttempt.bytes !== attempt.evidence.bytes) {
              errors.push(`stage attempt evidence changed after seal: ${expectedStage} attempt ${attempt.attempt}`)
              continue
            }
            const parsedAttempt = readJson(attempt.evidence.path)
            if (parsedAttempt.schema !== STAGE_SCHEMA
              || parsedAttempt.rolloutId !== evidence.rolloutId
              || parsedAttempt.stage !== expectedStage
              || parsedAttempt.status !== attempt.status) {
              errors.push(`stage attempt evidence identity/status is invalid: ${expectedStage} attempt ${attempt.attempt}`)
            }
            for (const stream of ['stdout', 'stderr']) {
              const output = parsedAttempt.output?.[stream]
              if (!output) continue
              const currentOutput = fileMetadata(output.path)
              if (currentOutput.sha256 !== output.sha256 || currentOutput.bytes !== output.bytes) {
                errors.push(`stage ${expectedStage} attempt ${attempt.attempt} ${stream} changed after seal`)
              }
            }
          } catch (error) {
            errors.push(`${expectedStage} attempt ${attempt.attempt ?? '<missing>'}: ${message(error)}`)
          }
        }
      }
    }
  }
  if (!Array.isArray(evidence.recoveries)) {
    errors.push('rollout evidence recoveries must be an array')
  } else {
    validateRecoveryResolution(evidence.recoveries, errors)
    for (const recovery of evidence.recoveries) {
      if (!['ok', 'failed'].includes(recovery.status) || !recovery.evidence) {
        errors.push(`rollout recovery evidence is invalid: ${recovery.action ?? '<missing>'}`)
        continue
      }
      try {
        const current = fileMetadata(recovery.evidence.path)
        if (current.sha256 !== recovery.evidence.sha256 || current.bytes !== recovery.evidence.bytes) {
          errors.push(`recovery evidence changed after seal: ${recovery.action}`)
        }
      } catch (error) {
        errors.push(`recovery ${recovery.action}: ${message(error)}`)
      }
    }
  }
  const artifactNames = Object.keys(evidence.artifacts ?? {})
  if (artifactNames.join('\n') !== REQUIRED_FINAL_ARTIFACTS.join('\n')) {
    errors.push('rollout evidence artifact set must be the exact allowlist')
  }
  for (const name of REQUIRED_FINAL_ARTIFACTS) {
    const artifact = evidence.artifacts?.[name]
    if (!artifact || artifact.status === 'fail' || !/^sha256:[0-9a-f]{64}$/u.test(String(artifact.sha256 ?? ''))) {
      errors.push(`rollout evidence artifact is invalid: ${name}`)
      continue
    }
    try {
      const current = fileMetadata(artifact.path)
      if (current.sha256 !== artifact.sha256 || current.bytes !== artifact.bytes) errors.push(`artifact changed after seal: ${name}`)
      const parsed = readJson(artifact.path)
      if (parsed.rolloutId !== evidence.rolloutId) errors.push(`${name}: rolloutId does not match sealed rollout`)
      if (parsed.target?.releaseId !== undefined && parsed.target.releaseId !== evidence.target?.releaseId) errors.push(`${name}: target release does not match sealed rollout`)
      if (parsed.target?.imageDigest !== undefined && parsed.target.imageDigest !== evidence.target?.imageDigest) errors.push(`${name}: target digest does not match sealed rollout`)
      if (parsed.sourceReleaseId !== undefined && parsed.sourceReleaseId !== evidence.source?.releaseId) errors.push(`${name}: source release does not match sealed rollout`)
      if (parsed.targetReleaseId !== undefined && parsed.targetReleaseId !== evidence.target?.releaseId) errors.push(`${name}: target release does not match sealed rollout`)
      validateSemanticArtifact(name, parsed, errors)
    } catch (error) {
      errors.push(`${name}: ${message(error)}`)
    }
  }
  const auxiliaryNames = Object.keys(evidence.auxiliary ?? {})
  if (auxiliaryNames.join('\n') !== REQUIRED_AUXILIARY_EVIDENCE.join('\n')) {
    errors.push('rollout evidence auxiliary set is incomplete or out of order')
  }
  for (const name of REQUIRED_AUXILIARY_EVIDENCE) {
    const metadata = evidence.auxiliary?.[name]
    if (!metadata || !/^sha256:[0-9a-f]{64}$/u.test(String(metadata.sha256 ?? ''))) {
      errors.push(`rollout auxiliary evidence is invalid: ${name}`)
      continue
    }
    try {
      const current = fileMetadata(metadata.path)
      if (current.sha256 !== metadata.sha256 || current.bytes !== metadata.bytes) errors.push(`auxiliary evidence changed after seal: ${name}`)
      validateAuxiliaryEvidence(name, readJson(metadata.path), evidence, errors, now)
    } catch (error) {
      errors.push(`${name}: ${message(error)}`)
    }
  }
  return {
    schema: 'fsusblog.release-rollout-evidence-verification.v1',
    status: errors.length === 0 ? 'pass' : 'fail',
    rolloutId: evidence.rolloutId ?? null,
    evidence: evidencePath,
    errors
  }
}

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
      'manifest-digest-mismatch', 'capacity-insufficient', 'expand-failure', 'candidate-readiness',
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

function validateStrongAssetCompatibilityEvidence(value, name, errors) {
  const browser = value.browser
  if (browser?.schema !== 'fsusblog.release-asset-browser-evidence.v1' || browser?.status !== 'pass') {
    errors.push(`${name}: controlled browser evidence is missing or failed`)
    return
  }
  if (typeof browser.browser?.name !== 'string' || browser.browser.name.length === 0
    || typeof browser.browser?.version !== 'string' || browser.browser.version.length === 0
    || typeof browser.browser?.executablePath !== 'string' || !path.isAbsolute(browser.browser.executablePath)
    || !SHA256.test(String(browser.browser?.executableSha256 ?? ''))) {
    errors.push(`${name}: browser binary/version evidence is invalid`)
  }
  if (browser.bindings?.rolloutId !== value.rolloutId
    || browser.bindings?.sourceReleaseId !== value.sourceReleaseId
    || browser.bindings?.targetReleaseId !== value.targetReleaseId
    || !SHA256.test(String(browser.bindings?.scenarioSha256 ?? ''))
    || !SHA256.test(String(browser.bindings?.manifestSha256 ?? ''))
    || !SHA256.test(String(browser.bindings?.gcEvidenceSha256 ?? ''))) {
    errors.push(`${name}: browser input binding is invalid`)
  }
  if (browser.beforeSwitch?.status !== 'pass'
    || browser.beforeSwitch?.serviceWorker?.controller?.state !== 'activated') {
    errors.push(`${name}: old page/service worker was not controlled before switch`)
  }
  const delayed = Array.isArray(browser.delayed?.resources) ? browser.delayed.resources : []
  for (const kind of ['javascript', 'stylesheet', 'wasm', 'font']) {
    if (!delayed.some(resource => resource?.kind === kind && resource?.hashMatches === true)) {
      errors.push(`${name}: delayed browser resource missing or failed: ${kind}`)
    }
  }
  if (browser.afterSwitch?.status !== 'pass'
    || browser.compatibility?.oldFrontendToNewBackend?.status !== 'pass'
    || browser.compatibility?.newFrontendToOldBackend?.status !== 'pass') {
    errors.push(`${name}: browser cross-switch compatibility is incomplete`)
  }
  const cacheReads = Array.isArray(browser.afterGc?.cacheReads) ? browser.afterGc.cacheReads : []
  if (browser.afterGc?.status !== 'pass' || cacheReads.length === 0
    || cacheReads.some(read => read?.cacheHit !== true || read?.hashMatches === false)) {
    errors.push(`${name}: GC-after old page/SW/cache evidence is incomplete`)
  }
  if (!Array.isArray(browser.pageErrors) || browser.pageErrors.length !== 0
    || !Array.isArray(browser.network?.failures)) {
    errors.push(`${name}: browser error/network ledger is invalid`)
  }
  const binding = value.browserBinding
  const { browserBinding: ignored, ...unsignedValue } = value
  if (binding?.schema !== 'fsusblog.release-asset-browser-binding.v1'
    || binding?.algorithm !== 'hmac-sha256'
    || !HMAC_SHA256.test(String(binding?.keyId ?? ''))
    || !HMAC_SHA256.test(String(binding?.signature ?? ''))
    || binding?.rolloutId !== value.rolloutId
    || binding?.sourceReleaseId !== value.sourceReleaseId
    || binding?.targetReleaseId !== value.targetReleaseId
    || binding?.browserName !== browser.browser?.name
    || binding?.browserVersion !== browser.browser?.version
    || binding?.browserExecutablePath !== browser.browser?.executablePath
    || binding?.browserExecutableSha256 !== browser.browser?.executableSha256
    || binding?.scenarioSha256 !== browser.bindings?.scenarioSha256
    || binding?.manifestSha256 !== browser.bindings?.manifestSha256
    || binding?.gcEvidenceSha256 !== browser.bindings?.gcEvidenceSha256
    || binding?.payloadSha256 !== sha256Text(canonicalJson(unsignedValue))) {
    errors.push(`${name}: browser HMAC binding structure or payload binding is invalid`)
  }
}

function validateStrongTrafficEvidence(value, name, errors) {
  if (value.probeMode !== 'public-rollout') errors.push(`${name}: probeMode must be public-rollout`)
  const policy = value.releaseIdentityPolicy
  if (policy?.required !== true || policy?.scenarioRequired !== true || policy?.mode !== 'public-rollout'
    || Number(policy?.violationCount) !== 0) {
    errors.push(`${name}: release identity policy result is invalid`)
  }
  const expectedCoverage = TRAFFIC_POLICY_STAGES.flatMap(stage => TRAFFIC_CATEGORIES.map(category => `${stage}/${category}`)).sort()
  const actualCoverage = policy?.coverage && typeof policy.coverage === 'object' && !Array.isArray(policy.coverage)
    ? Object.keys(policy.coverage).sort()
    : []
  if (actualCoverage.join('\n') !== expectedCoverage.join('\n')
    || actualCoverage.some(key => !Number.isSafeInteger(policy.coverage[key]) || policy.coverage[key] < 0)) {
    errors.push(`${name}: exact 17 x 12 release identity coverage ledger is missing`)
  }
  if (!Array.isArray(value.requiredCategories)
    || value.requiredCategories.join('\n') !== TRAFFIC_CATEGORIES.join('\n')) {
    errors.push(`${name}: required categories are incomplete`)
  }
  const sessions = value.sessionChains && typeof value.sessionChains === 'object' && !Array.isArray(value.sessionChains)
    ? Object.values(value.sessionChains)
    : []
  if (sessions.length === 0 || sessions.some(session => !(Number(session.completedCycles) > 0) || Number(session.failedCycles) !== 0)) {
    errors.push(`${name}: real session chain evidence is incomplete`)
  }
  const holds = value.gatewaySwitchHolds && typeof value.gatewaySwitchHolds === 'object' && !Array.isArray(value.gatewaySwitchHolds)
    ? Object.values(value.gatewaySwitchHolds)
    : []
  if (holds.length === 0 || holds.some(hold => hold.required !== true
    || !(Number(hold.attempts) > 0)
    || !(Number(hold.passCount) > 0)
    || Number(hold.failCount) !== 0
    || !Array.isArray(hold.observations)
    || !hold.observations.some(observation => observation?.pass === true
      && observation?.startedAt?.switchCommitted === false
      && observation?.completedAt?.switchCommitted === true
      && observation?.releaseRole === 'target'
      && SHA256.test(String(observation?.bindingSha256 ?? ''))))) {
    errors.push(`${name}: gateway-switch hold evidence is incomplete`)
  }
  const observation = value.observationBinding
  const digests = Array.isArray(observation?.observationSha256) ? observation.observationSha256 : []
  if (observation?.schema !== 'fsusblog.release-traffic-observation-chain.v1'
    || observation?.algorithm !== 'sha256-chain'
    || !(Number(observation?.observationCount) > 0)
    || observation.observationCount !== digests.length
    || digests.some(digest => !SHA256.test(String(digest)))) {
    errors.push(`${name}: observation binding ledger is invalid`)
  } else {
    let head = sha256Text('fsusblog.release-traffic-observation-chain.v1')
    for (const digest of digests) head = sha256Text(`${head}\0${digest}`)
    if (head !== observation.chainHeadSha256) errors.push(`${name}: observation hash chain is invalid`)
  }
  const responses = Array.isArray(value.responseObservations) ? value.responseObservations : []
  if (!responses.some(record => record?.category === 'binary'
    && Array.isArray(record?.lastObservation?.aeds?.checks)
    && record.lastObservation.aeds.checks.length >= 7
    && record.lastObservation.aeds.checks.every(check => check?.pass === true))) {
    errors.push(`${name}: successful AEDS v2 byte evidence is missing`)
  }
  const binding = value.finalBinding
  const { finalBinding: ignored, ...unsignedValue } = value
  if (binding?.schema !== 'fsusblog.release-traffic-final-binding.v1'
    || binding?.algorithm !== 'hmac-sha256'
    || !HMAC_SHA256.test(String(binding?.keyId ?? ''))
    || !HMAC_SHA256.test(String(binding?.signature ?? ''))
    || binding?.rolloutId !== value.rolloutId
    || binding?.scenarioSha256 !== observation?.scenarioSha256
    || binding?.initialRolloutStateSha256 !== observation?.initialRolloutStateSha256
    || !SHA256.test(String(binding?.finalRolloutStateSha256 ?? ''))
    || binding?.observationCount !== observation?.observationCount
    || binding?.observationHashChain !== observation?.chainHeadSha256
    || binding?.payloadSha256 !== sha256Text(canonicalJson(unsignedValue))) {
    errors.push(`${name}: HMAC final binding structure or payload binding is invalid`)
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

function sha256Text(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`
}

function canonicalJson(value) {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

function message(error) {
  return error instanceof Error ? error.message : String(error)
}
