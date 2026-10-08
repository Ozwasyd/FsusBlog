#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { validatePublicAotWarmEvidence } from '../frontend/public-aot-warm-evidence.mjs'

import { verifyReleaseRolloutEvidence } from './release-rollout-evidence-receipt-contract.mjs';
import { ROLLOUT_STAGES, readRolloutState } from './release-rollout-lib.mjs'

const STAGE_SCHEMA = 'fsusblog.release-rollout-stage-evidence.v1'
const FINAL_SCHEMA = 'fsusblog.release-rollout-evidence.v1'
const REQUIRED_FINAL_ARTIFACTS = Object.freeze([
  'publicTraffic',
  'notificationStream',
  'assetCompatibility',
  'workerReconciliation',
  'resourceBudget',
  'faultInjection'
])
const REQUIRED_AUXILIARY_EVIDENCE = Object.freeze([
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

try {
  const { command, options, artifacts, auxiliaries } = parseArgs(process.argv.slice(2))
  if (command === 'stage') {
    emitStageEvidence(options)
  } else if (command === 'preseal') {
    presealEvidence(options, artifacts, auxiliaries)
  } else if (command === 'finalize') {
    finalizeEvidence(options, artifacts, auxiliaries)
  } else if (command === 'verify') {
    const report = verifyFinalEvidence(requiredPath(options, 'evidence'))
    process.stdout.write(`${JSON.stringify(report)}\n`)
    if (report.status !== 'pass') process.exitCode = 1
  } else {
    throw new Error('usage: release-rollout-evidence.mjs <stage|preseal|finalize|verify> [options]')
  }
} catch (error) {
  process.stderr.write(`[release-rollout-evidence] fatal: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}

function presealEvidence(options, artifactInputs, auxiliaryInputs) {
  const stateFile = requiredPath(options, 'state')
  const state = readRolloutState(stateFile)
  if (state.status !== 'running' || state.currentStage !== 'release-evidence') {
    throw new Error('preseal is allowed only while the final release-evidence stage is running')
  }
  if (state.completedStages.join('\n') !== ROLLOUT_STAGES.slice(0, -1).join('\n')) {
    throw new Error('preseal requires every preceding rollout stage in exact order')
  }
  const errors = []
  const artifacts = collectArtifacts(artifactInputs, errors, state)
  const auxiliary = collectAuxiliaryEvidence(auxiliaryInputs, errors, state)
  const report = {
    schema: 'fsusblog.release-rollout-preseal.v1',
    status: errors.length === 0 ? 'pass' : 'fail',
    rolloutId: state.rolloutId,
    source: state.source,
    target: state.target,
    gatewayGeneration: state.gatewayGeneration,
    completedStages: state.completedStages,
    artifacts,
    auxiliary,
    errors,
    observedAtUtc: new Date().toISOString()
  }
  writeJsonExclusiveOrReplace(requiredPath(options, 'out'), report, options.replace === true)
  process.stdout.write(`${JSON.stringify(report)}\n`)
  if (errors.length > 0) process.exitCode = 1
}

function emitStageEvidence(options) {
  const stateFile = requiredPath(options, 'state')
  const state = readRolloutState(stateFile)
  const stage = required(options, 'stage')
  if (!ROLLOUT_STAGES.includes(stage)) throw new Error(`unknown rollout stage: ${stage}`)
  if (state.currentStage !== stage) throw new Error(`rollout state is not executing ${stage}`)
  const status = required(options, 'status')
  if (!['ok', 'failed'].includes(status)) throw new Error('--status must be ok or failed')
  const exitCode = nonNegativeInteger(options['exit-code'], 'exit-code')
  if ((status === 'ok') !== (exitCode === 0)) throw new Error('stage status and exit code disagree')
  const startedAtUtc = isoUtc(required(options, 'started-at'), 'started-at')
  const completedAtUtc = isoUtc(options['completed-at'] ?? new Date().toISOString(), 'completed-at')
  if (Date.parse(completedAtUtc) < Date.parse(startedAtUtc)) throw new Error('stage completion precedes start')
  const stdout = fileMetadata(requiredPath(options, 'stdout'))
  const stderr = fileMetadata(requiredPath(options, 'stderr'))
  const attempts = state.stages.filter(record => record.stage === stage).length
  const evidence = {
    schema: STAGE_SCHEMA,
    rolloutId: state.rolloutId,
    stage,
    attempt: attempts,
    status,
    exitCode,
    commandId: boundedLabel(required(options, 'command-id'), 'command-id'),
    source: state.source,
    target: state.target,
    startedAtUtc,
    completedAtUtc,
    durationMs: Date.parse(completedAtUtc) - Date.parse(startedAtUtc),
    output: { stdout, stderr }
  }
  writeJsonExclusiveOrReplace(requiredPath(options, 'out'), evidence, options.replace === true)
  process.stdout.write(`${JSON.stringify(evidence)}\n`)
}

function finalizeEvidence(options, artifactInputs, auxiliaryInputs) {
  const stateFile = requiredPath(options, 'state')
  const state = readRolloutState(stateFile)
  if (state.status !== 'running' || state.currentStage !== null) {
    throw new Error('rollout state must have all stages completed and no active stage before final evidence is sealed')
  }
  if (!state.switchCommitted || !Number.isSafeInteger(state.gatewayGeneration)) {
    throw new Error('completed rollout lacks a committed gateway generation')
  }
  if (state.completedStages.join('\n') !== ROLLOUT_STAGES.join('\n')) {
    throw new Error('completed rollout does not contain the exact ordered stage set')
  }

  const errors = []
  const stages = []
  for (const stage of ROLLOUT_STAGES) {
    const attempts = state.stages.filter(record => record.stage === stage)
    const successful = attempts.filter(record => record.status === 'ok')
    if (successful.length !== 1) errors.push(`${stage}: expected exactly one successful terminal attempt`)
    const attemptEvidence = attempts.map((attempt, index) => {
      if (!attempt.evidencePath) {
        errors.push(`${stage}: attempt ${index + 1} evidence path is missing`)
        return { attempt: index + 1, status: attempt.status, errorCode: attempt.errorCode, evidence: null }
      }
      try {
        const metadata = fileMetadata(attempt.evidencePath)
        const parsed = readJson(attempt.evidencePath)
        if (parsed.schema !== STAGE_SCHEMA || parsed.rolloutId !== state.rolloutId || parsed.stage !== stage || parsed.status !== attempt.status) {
          errors.push(`${stage}: attempt ${index + 1} evidence identity/status is invalid`)
        }
        return { attempt: index + 1, status: attempt.status, errorCode: attempt.errorCode, evidence: metadata }
      } catch (error) {
        errors.push(`${stage}: attempt ${index + 1}: ${message(error)}`)
        return { attempt: index + 1, status: attempt.status, errorCode: attempt.errorCode, evidence: null }
      }
    })
    const record = successful.at(-1)
    if (!record?.evidencePath) {
      errors.push(`${stage}: stage evidence path is missing`)
      continue
    }
    try {
      const metadata = fileMetadata(record.evidencePath)
      const parsed = readJson(record.evidencePath)
      if (parsed.schema !== STAGE_SCHEMA || parsed.rolloutId !== state.rolloutId || parsed.stage !== stage || parsed.status !== 'ok') {
        errors.push(`${stage}: stage evidence identity/status is invalid`)
      }
      stages.push({ stage, attempts: attempts.length, attemptEvidence, evidence: metadata })
    } catch (error) {
      errors.push(`${stage}: ${message(error)}`)
    }
  }

  const artifacts = collectArtifacts(artifactInputs, errors, state)
  const auxiliary = collectAuxiliaryEvidence(auxiliaryInputs, errors, state)

  validateRecoveryResolution(state.recoveries, errors)
  const recoveries = collectRecoveries(state.recoveries, errors)
  const evidence = {
    schema: FINAL_SCHEMA,
    status: errors.length === 0 ? 'pass' : 'fail',
    rolloutId: state.rolloutId,
    kind: state.kind,
    source: state.source,
    target: state.target,
    gatewayGeneration: state.gatewayGeneration,
    rollback: {
      allowed: state.rollbackAllowed,
      contractMigrationApplied: state.contractMigrationApplied,
      target: state.source
    },
    stages,
    recoveries,
    artifacts,
    auxiliary,
    errors,
    sealedAtUtc: new Date().toISOString()
  }
  const output = requiredPath(options, 'out')
  writeJsonExclusiveOrReplace(output, evidence, false)
  process.stdout.write(`${JSON.stringify(evidence)}\n`)
  if (errors.length > 0) process.exitCode = 1
}

function collectRecoveries(records, errors) {
  return records.map(record => {
    let evidence = null
    if (!record.evidencePath) {
      errors.push(`rollout recovery evidence is missing: ${record.action ?? '<missing>'}`)
    } else {
      try {
        evidence = fileMetadata(record.evidencePath)
      } catch (error) {
        errors.push(`recovery ${record.action}: ${message(error)}`)
      }
    }
    return { ...record, evidence }
  })
}

function validateRecoveryResolution(records, errors) {
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record.status !== 'failed') continue
    const resolved = records.slice(index + 1).some(candidate => candidate.status === 'ok'
      && candidate.action === record.action
      && candidate.failedStage === record.failedStage)
    if (!resolved) errors.push(`rollout contains an unresolved failed recovery attempt: ${record.action ?? '<missing>'}`)
  }
}

function collectArtifacts(artifactInputs, errors, state) {
  const artifactMap = new Map()
  for (const input of artifactInputs) {
    const separator = input.indexOf('=')
    if (separator <= 0) throw new Error(`invalid --artifact value: ${input}`)
    const name = boundedLabel(input.slice(0, separator), 'artifact name')
    const file = path.resolve(input.slice(separator + 1))
    if (artifactMap.has(name)) throw new Error(`duplicate artifact: ${name}`)
    artifactMap.set(name, file)
  }
  for (const name of artifactMap.keys()) {
    if (!REQUIRED_FINAL_ARTIFACTS.includes(name)) errors.push(`unexpected artifact is not allowlisted: ${name}`)
  }
  for (const name of REQUIRED_FINAL_ARTIFACTS) {
    if (!artifactMap.has(name)) errors.push(`required artifact is missing: ${name}`)
  }
  const artifacts = {}
  for (const [name, file] of artifactMap) {
    try {
      const parsed = readJson(file)
      if (parsed.rolloutId !== state.rolloutId) errors.push(`${name}: rolloutId does not match the durable rollout`)
      if (parsed.target?.releaseId !== undefined && parsed.target.releaseId !== state.target.releaseId) errors.push(`${name}: target release does not match`)
      if (parsed.target?.imageDigest !== undefined && parsed.target.imageDigest !== state.target.imageDigest) errors.push(`${name}: target digest does not match`)
      if (parsed.sourceReleaseId !== undefined && parsed.sourceReleaseId !== state.source.releaseId) errors.push(`${name}: source release does not match`)
      if (parsed.targetReleaseId !== undefined && parsed.targetReleaseId !== state.target.releaseId) errors.push(`${name}: target release does not match`)
      validateSemanticArtifact(name, parsed, errors)
      artifacts[name] = { ...fileMetadata(file), schema: parsed.schema ?? null, status: parsed.status ?? null }
    } catch (error) {
      errors.push(`${name}: ${message(error)}`)
    }
  }
  return artifacts
}

function collectAuxiliaryEvidence(inputs, errors, state) {
  const inputMap = new Map()
  for (const input of inputs) {
    const separator = input.indexOf('=')
    if (separator <= 0) throw new Error(`invalid --auxiliary value: ${input}`)
    const name = boundedLabel(input.slice(0, separator), 'auxiliary evidence name')
    const file = path.resolve(input.slice(separator + 1))
    if (inputMap.has(name)) throw new Error(`duplicate auxiliary evidence: ${name}`)
    inputMap.set(name, file)
  }
  for (const name of inputMap.keys()) {
    if (!REQUIRED_AUXILIARY_EVIDENCE.includes(name)) errors.push(`unexpected auxiliary evidence is not allowlisted: ${name}`)
  }
  for (const name of REQUIRED_AUXILIARY_EVIDENCE) {
    if (!inputMap.has(name)) errors.push(`required auxiliary evidence is missing: ${name}`)
  }
  const auxiliary = {}
  for (const name of REQUIRED_AUXILIARY_EVIDENCE) {
    const file = inputMap.get(name)
    if (!file) continue
    try {
      const parsed = readJson(file)
      validateAuxiliaryEvidence(name, parsed, state, errors)
      auxiliary[name] = { ...fileMetadata(file), schema: parsed.schema ?? null, status: parsed.status ?? null }
    } catch (error) {
      errors.push(`${name}: ${message(error)}`)
    }
  }
  return auxiliary
}

function validateAuxiliaryEvidence(name, value, state, errors) {
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
        if (value.schema !== 'fsusblog.release-manifest.v3'
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
      maxAgeSeconds: Number.MAX_SAFE_INTEGER
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

function verifyFinalEvidence(file)
{
    try
    {
        return verifyReleaseRolloutEvidence(JSON.parse(readEvidenceBytes(file).toString('utf8')), {
            evidencePath: path.resolve(file),
            now: Date.now(),
            readBytes: readEvidenceBytes
        });
    }
    catch (error)
    {
        return { schema: 'fsusblog.release-rollout-evidence-verification.v1', status: 'fail', errors: [message(error)] };
    }
}

function readEvidenceBytes(file)
{
    const resolved = path.resolve(file);
    const descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try
    {
        const before = fs.fstatSync(descriptor, { bigint: true });
        if (!before.isFile())
        {
            throw new Error(`evidence input must be a regular non-symlink file: ${resolved}`);
        }
        const bytes = fs.readFileSync(descriptor);
        const after = fs.fstatSync(descriptor, { bigint: true });
        const current = fs.lstatSync(resolved, { bigint: true });
        if (!current.isFile() || current.isSymbolicLink()
            || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(field => before[field] !== after[field]
                || current[field] !== after[field]))
        {
            throw new Error(`evidence input changed while reading: ${resolved}`);
        }
        return bytes;
    }
    finally
    {
        fs.closeSync(descriptor);
    }
}

function validateSemanticArtifact(name, value, errors) {
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

function parseArgs(argv) {
  const command = argv.shift()
  const options = {}
  const artifacts = []
  const auxiliaries = []
  while (argv.length > 0) {
    const name = argv.shift()
    if (!name?.startsWith('--')) throw new Error(`invalid argument: ${name ?? '<end>'}`)
    if (name === '--replace') {
      options.replace = true
      continue
    }
    const value = argv.shift()
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`)
    if (name === '--artifact') artifacts.push(value)
    else if (name === '--auxiliary') auxiliaries.push(value)
    else options[name.slice(2)] = value
  }
  return { command, options, artifacts, auxiliaries }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function fileMetadata(file) {
  const resolved = path.resolve(file)
  const stat = fs.lstatSync(resolved)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`evidence input must be a regular non-symlink file: ${resolved}`)
  const hash = crypto.createHash('sha256').update(fs.readFileSync(resolved)).digest('hex')
  return { path: resolved, bytes: stat.size, sha256: `sha256:${hash}` }
}

function writeJsonExclusiveOrReplace(file, value, replace) {
  const resolved = path.resolve(file)
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 })
  const flags = replace ? 'w' : 'wx'
  const descriptor = fs.openSync(resolved, flags, 0o600)
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

function required(options, name) {
  const value = options[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`--${name} is required`)
  return value
}

function requiredPath(options, name) {
  return path.resolve(required(options, name))
}

function boundedLabel(value, label) {
  const result = String(value ?? '')
  if (!/^[0-9A-Za-z][0-9A-Za-z._:-]{0,127}$/u.test(result)) throw new Error(`${label} is invalid`)
  return result
}

function nonNegativeInteger(value, label) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`)
  return parsed
}

function isoUtc(value, label) {
  const result = String(value ?? '')
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(result) || !Number.isFinite(Date.parse(result))) {
    throw new Error(`${label} must be ISO UTC`)
  }
  return result
}

function message(error) {
  return error instanceof Error ? error.message : String(error)
}
