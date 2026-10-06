import fs from 'node:fs';
import path from 'node:path';
import { isValidReleaseId } from '../release/release-id.mjs';
import { validateCurrentSchemaBinding } from '../release/release-manifest-value-contract.mjs';

export const ROLLOUT_SCHEMA = 'fsusblog.release-rollout-state.v2';
export const ROLLOUT_STAGES = Object.freeze([
  'manifest-validate',
  'capacity-preflight',
  'backup-restore-gate',
  'current-schema-admission',
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

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;

export function createRolloutState(input) {
  const createdAtUtc = timestamp(input.createdAtUtc ?? new Date().toISOString(), 'createdAtUtc')
  const source = releaseIdentity(input.source, 'source')
  const target = releaseIdentity(input.target, 'target')
  if (source.slot === target.slot) throw new Error('rollout source and target slots must differ')
  const state = {
    schema: ROLLOUT_SCHEMA,
    rolloutId: rolloutId(input.rolloutId),
    kind: enumValue(input.kind ?? 'deploy', ['deploy'], 'kind'),
    status: 'planned',
    manifestPath: absolutePath(input.manifestPath, 'manifestPath'),
    manifestSha256: input.manifestSha256,
    candidateSourceRevision: input.candidateSourceRevision,
    currentSchema: structuredClone(input.currentSchema),
    source,
    target,
    currentStage: null,
    completedStages: [],
    stages: [],
        switchCommitted: false,
        gatewayGeneration: null,
        destructiveCutoverStarted: false,
        activationCommitted: false,
        rollbackAllowed: false,
        candidateOnly: false,
        outcome: null,
    recovery: null,
    recoveries: [],
    finalEvidencePath: null,
    createdAtUtc,
    updatedAtUtc: createdAtUtc
  }
  validateRolloutState(state)
  return state
}

export function startRolloutStage(state, stageValue, at = new Date().toISOString()) {
  validateRolloutState(state)
  const stage = rolloutStage(stageValue)
  if (['completed', 'candidate_ready', 'rolled_back', 'aborted'].includes(state.status)) throw new Error(`rollout is terminal: ${state.status}`)
  if (state.status === 'recovery_required') throw new Error('rollout recovery must complete before a stage can be retried')
  if (state.currentStage !== null) throw new Error(`rollout stage ${state.currentStage} is already running`)
  if (state.completedStages.includes(stage)) throw new Error(`rollout stage ${stage} is already complete`)
  const expected = ROLLOUT_STAGES[state.completedStages.length]
  if (stage !== expected) throw new Error(`rollout stage order mismatch: expected ${expected}, got ${stage}`)
  const startedAtUtc = timestamp(at, 'stage.startedAtUtc')
  state.status = 'running'
  state.currentStage = stage
  state.stages.push({ stage, status: 'running', startedAtUtc, completedAtUtc: null, evidencePath: null, errorCode: null })
  state.updatedAtUtc = startedAtUtc
  validateRolloutState(state)
  return state
}

export function completeRolloutStage(state, stageValue, input = {})
{
    validateRolloutState(state);
    const stage = rolloutStage(stageValue);
    if (stage === 'source-drain' && state.destructiveCutoverStarted !== true)
{
        throw new Error('source-drain cannot complete before the destructive cutover boundary is durable');
    }
    if (stage === 'active-fence' && state.activationCommitted !== true)
{
        throw new Error('active-fence cannot complete before activation is durably committed');
    }
    if (state.currentStage !== stage) {throw new Error(`cannot complete ${stage}; current stage is ${state.currentStage ?? 'none'}`)};
    const completedAtUtc = timestamp(input.completedAtUtc ?? new Date().toISOString(), 'stage.completedAtUtc');
    const record = state.stages.at(-1);
  if (!record || record.stage !== stage || record.status !== 'running') throw new Error('running stage record is missing')
  record.status = 'ok'
  record.completedAtUtc = completedAtUtc
  record.evidencePath = input.evidencePath === undefined || input.evidencePath === null
    ? null
    : absolutePath(input.evidencePath, 'stage.evidencePath')
  state.completedStages.push(stage)
  state.currentStage = null
  state.status = 'running'
  state.recovery = null
  state.updatedAtUtc = completedAtUtc
  validateRolloutState(state)
  return state
}

export function failRolloutStage(state, stageValue, input = {}) {
  validateRolloutState(state)
  const stage = rolloutStage(stageValue)
  if (state.currentStage !== stage) throw new Error(`cannot fail ${stage}; current stage is ${state.currentStage ?? 'none'}`)
  const failedAtUtc = timestamp(input.failedAtUtc ?? new Date().toISOString(), 'stage.failedAtUtc')
  const errorCode = boundedCode(input.errorCode)
  const record = state.stages.at(-1)
  if (!record || record.stage !== stage || record.status !== 'running') throw new Error('running stage record is missing')
  record.status = 'failed'
  record.completedAtUtc = failedAtUtc
  record.evidencePath = input.evidencePath === undefined || input.evidencePath === null
    ? null
    : absolutePath(input.evidencePath, 'stage.evidencePath')
  record.errorCode = errorCode
  state.currentStage = null
  state.status = 'recovery_required'
  state.recovery = recoveryPlan(state, stage)
  state.updatedAtUtc = failedAtUtc
  validateRolloutState(state)
  return state
}

export function markGatewaySwitchCommitted(state, generation, at = new Date().toISOString()) {
  validateRolloutState(state)
  if (!state.completedStages.includes('gateway-switch')) throw new Error('gateway-switch stage must complete before commit marker')
  const parsed = Number(generation)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('gateway generation must be a positive integer')
  state.switchCommitted = true
  state.gatewayGeneration = parsed
  state.updatedAtUtc = timestamp(at, 'switchCommittedAtUtc')
  validateRolloutState(state)
  return state
}

export function markContractMigrationApplied() {
    throw new Error('Serve-time Contract migrations are retired; only the offline migration owner can mutate schema');
}

export function markDestructiveCutoverStarted(state, at = new Date().toISOString())
{
    validateRolloutState(state);
    if (!state.switchCommitted || state.currentStage !== 'source-drain')
{
        throw new Error('destructive cutover boundary requires the committed gateway and running source-drain stage');
    }
    state.destructiveCutoverStarted = true;
    state.updatedAtUtc = timestamp(at, 'destructiveCutoverStartedAtUtc');
    validateRolloutState(state);
    return state;
}

export function markActivationCommitted(state, at = new Date().toISOString())
{
    validateRolloutState(state);
    if (!state.destructiveCutoverStarted || state.currentStage !== 'active-fence'
      || !state.completedStages.includes('source-drain'))
{
        throw new Error('activation requires completed destructive cutover and running active-fence stage');
    }
    state.activationCommitted = true;
    state.updatedAtUtc = timestamp(at, 'activationCommittedAtUtc');
    validateRolloutState(state);
    return state;
}

export function markCandidateOnly(state, at = new Date().toISOString())
{
    validateRolloutState(state);
    if (!state.completedStages.includes('compatibility-smoke')) {throw new Error('candidate-only completion requires compatibility smoke')};
  if (state.switchCommitted) throw new Error('candidate-only rollout cannot have committed traffic')
  state.status = 'candidate_ready'
  state.candidateOnly = true
  state.outcome = 'candidate_ready'
  state.updatedAtUtc = timestamp(at, 'candidateReadyAtUtc')
  validateRolloutState(state)
  return state
}

export function completeRollout(state, input = {}) {
  validateRolloutState(state)
  if (state.completedStages.length !== ROLLOUT_STAGES.length) throw new Error('all rollout stages must complete')
  if (!state.switchCommitted || !Number.isSafeInteger(state.gatewayGeneration)) throw new Error('rollout completion requires committed gateway generation')
  state.status = 'completed'
  state.outcome = 'succeeded'
  state.finalEvidencePath = absolutePath(input.evidencePath, 'finalEvidencePath')
  state.recovery = null
  state.updatedAtUtc = timestamp(input.completedAtUtc ?? new Date().toISOString(), 'completedAtUtc')
  validateRolloutState(state)
  return state
}

export function planRolloutRecovery(state) {
  validateRolloutState(state)
  if (state.status !== 'recovery_required') return { action: 'none', automatic: true, reason: `status_${state.status}` }
  return { ...state.recovery }
}

export function completeRolloutRecovery(state, input = {}) {
  validateRolloutState(state)
  if (state.status !== 'recovery_required' || state.recovery === null) {
    throw new Error('rollout does not require recovery')
  }
  const action = recoveryAction(input.action)
  if (action !== state.recovery.action) {
    throw new Error(`recovery action mismatch: expected ${state.recovery.action}, got ${action}`)
  }
  const completedAtUtc = timestamp(input.completedAtUtc ?? new Date().toISOString(), 'recovery.completedAtUtc')
  const terminalStatus = input.terminalStatus === undefined || input.terminalStatus === null
    ? null
    : enumValue(input.terminalStatus, ['aborted'], 'recovery.terminalStatus')
  state.recoveries.push({
    action,
    failedStage: state.recovery.failedStage,
    status: 'ok',
    automatic: state.recovery.automatic,
    completedAtUtc,
    evidencePath: absolutePath(input.evidencePath, 'recovery.evidencePath'),
    errorCode: null
  })
  state.status = terminalStatus ?? 'running'
  state.outcome = terminalStatus
  state.recovery = null
  state.updatedAtUtc = completedAtUtc
  validateRolloutState(state)
  return state
}

export function failRolloutRecovery(state, input = {}) {
  validateRolloutState(state)
  if (state.status !== 'recovery_required' || state.recovery === null) {
    throw new Error('rollout does not require recovery')
  }
  const action = recoveryAction(input.action)
  if (action !== state.recovery.action) {
    throw new Error(`recovery action mismatch: expected ${state.recovery.action}, got ${action}`)
  }
  const failedAtUtc = timestamp(input.failedAtUtc ?? new Date().toISOString(), 'recovery.failedAtUtc')
  state.recoveries.push({
    action,
    failedStage: state.recovery.failedStage,
    status: 'failed',
    automatic: state.recovery.automatic,
    completedAtUtc: failedAtUtc,
    evidencePath: input.evidencePath === undefined || input.evidencePath === null
      ? null
      : absolutePath(input.evidencePath, 'recovery.evidencePath'),
    errorCode: boundedCode(input.errorCode)
  })
  state.updatedAtUtc = failedAtUtc
  validateRolloutState(state)
  return state
}

export function readRolloutState(file) {
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`unable to read rollout state: ${error instanceof Error ? error.message : String(error)}`)
  }
  validateRolloutState(parsed)
  return parsed
}

export function writeRolloutStateAtomic(file, state) {
  validateRolloutState(state)
  const resolved = path.resolve(file)
  const directory = path.dirname(resolved)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = path.join(directory, `.${path.basename(resolved)}.tmp-${process.pid}-${Date.now().toString(36)}`)
  let descriptor
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporary, resolved)
    const directoryDescriptor = fs.openSync(directory, 'r')
    try {
      fs.fsyncSync(directoryDescriptor)
    } finally {
      fs.closeSync(directoryDescriptor)
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    fs.rmSync(temporary, { force: true })
  }
}

export function validateRolloutState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('rollout state must be an object')
  if (state.schema !== ROLLOUT_SCHEMA) throw new Error(`rollout schema must be ${ROLLOUT_SCHEMA}`)
  rolloutId(state.rolloutId)
  enumValue(state.kind, ['deploy'], 'kind')
  enumValue(state.status, ['planned', 'running', 'recovery_required', 'candidate_ready', 'completed', 'aborted'], 'status')
  absolutePath(state.manifestPath, 'manifestPath')
  if (typeof state.manifestSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(state.manifestSha256)) throw new Error('manifestSha256 must bind the complete manifest bytes')
  if (typeof state.candidateSourceRevision !== 'string' || !/^[0-9a-f]{40}$/u.test(state.candidateSourceRevision) || /^0+$/u.test(state.candidateSourceRevision)) throw new Error('candidateSourceRevision must be a nonzero Git SHA')
  const bindingErrors = []
  validateCurrentSchemaBinding(state.currentSchema, bindingErrors)
  if (bindingErrors.length > 0) throw new Error(bindingErrors.join('\n'))
  releaseIdentity(state.source, 'source')
  releaseIdentity(state.target, 'target')
  if (state.source.slot === state.target.slot) throw new Error('source and target slots must differ')
  if (state.currentStage !== null) rolloutStage(state.currentStage)
  if (!Array.isArray(state.completedStages)) throw new Error('completedStages must be an array')
  if (new Set(state.completedStages).size !== state.completedStages.length) throw new Error('completedStages contains duplicates')
  state.completedStages.forEach((stage, index) => {
    if (stage !== ROLLOUT_STAGES[index]) throw new Error('completedStages is not an ordered prefix')
  })
  if (!Array.isArray(state.stages)) throw new Error('stages must be an array')
  for (const record of state.stages) validateStageRecord(record)
  if (typeof state.switchCommitted !== 'boolean') throw new Error('switchCommitted must be boolean')
    if (state.gatewayGeneration !== null && (!Number.isSafeInteger(state.gatewayGeneration) || state.gatewayGeneration < 1)) {throw new Error('gatewayGeneration is invalid')};
    if (state.switchCommitted !== (state.gatewayGeneration !== null)) {throw new Error('switchCommitted and gatewayGeneration disagree')};
    if (Object.hasOwn(state, 'contractMigrationApplied') || state.rollbackAllowed !== false) {throw new Error('serve-time migration and image-only rollback are retired')};
    if (typeof state.destructiveCutoverStarted !== 'boolean') {throw new Error('destructiveCutoverStarted must be boolean')};
    if (state.destructiveCutoverStarted && !state.switchCommitted) {throw new Error('destructive cutover requires a committed gateway switch')};
    if (typeof state.activationCommitted !== 'boolean') {throw new Error('activationCommitted must be boolean')};
    if (state.activationCommitted && !state.destructiveCutoverStarted) {throw new Error('activation cannot precede destructive cutover')};
    if (typeof state.candidateOnly !== 'boolean') {throw new Error('candidateOnly must be boolean')};
    if (state.status === 'candidate_ready' && !state.candidateOnly) {throw new Error('candidate_ready status requires candidateOnly')};
  if (state.outcome !== null) enumValue(state.outcome, ['succeeded', 'candidate_ready', 'aborted'], 'outcome')
  if (state.status === 'completed' && state.outcome !== 'succeeded') throw new Error('completed rollout outcome must be succeeded')
  if (state.status === 'candidate_ready' && state.outcome !== 'candidate_ready') throw new Error('candidate rollout outcome must be candidate_ready')
  if (state.status === 'aborted' && state.outcome !== state.status) throw new Error('terminal recovery outcome must match status')
  if (state.status === 'recovery_required') validateRecovery(state.recovery)
  if (state.status !== 'recovery_required' && state.recovery !== null) throw new Error('recovery plan is only valid for recovery_required')
  if (!Array.isArray(state.recoveries)) throw new Error('recoveries must be an array')
  for (const record of state.recoveries) validateRecoveryRecord(record)
  if (state.finalEvidencePath !== null) absolutePath(state.finalEvidencePath, 'finalEvidencePath')
  timestamp(state.createdAtUtc, 'createdAtUtc')
  timestamp(state.updatedAtUtc, 'updatedAtUtc')
  return state
}

function recoveryPlan(state, failedStage) {
  const index = ROLLOUT_STAGES.indexOf(failedStage)
  const switchIndex = ROLLOUT_STAGES.indexOf('gateway-switch')
  const drainIndex = ROLLOUT_STAGES.indexOf('source-drain')
  if (!state.switchCommitted && index < switchIndex) {
    return { action: 'preserve-source-stop-candidate', automatic: true, reason: 'failure_before_gateway_switch', failedStage }
  }
    if (!state.switchCommitted)
{
        return { action: 'gateway-recover', automatic: true, reason: 'gateway_ownership_uncommitted', failedStage };
    }
    if (failedStage === 'source-drain' && !state.destructiveCutoverStarted)
{
        return { action: 'resume-release-activation-same-cutover', automatic: true, reason: 'post_switch_old_source_rollback_forbidden', failedStage };
    }
    if (state.destructiveCutoverStarted && index >= drainIndex && index <= ROLLOUT_STAGES.indexOf('public-verify'))
{
        return {
            action: 'resume-release-activation-same-cutover',
            automatic: true,
            reason: 'destructive_cutover_started_old_source_rollback_forbidden',
            failedStage
        };
    }
    if (failedStage === 'source-stop')
{
        return { action: 'retain-source-report-cleanup-blocker', automatic: false, reason: 'source_stop_failed_after_commit', failedStage };
  }
  return { action: 'resume-release-evidence', automatic: true, reason: 'traffic_and_drain_complete', failedStage }
}

function validateStageRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('stage record is invalid')
  rolloutStage(record.stage)
  enumValue(record.status, ['running', 'ok', 'failed'], 'stage.status')
  timestamp(record.startedAtUtc, 'stage.startedAtUtc')
  if (record.status === 'running') {
    if (record.completedAtUtc !== null || record.errorCode !== null) throw new Error('running stage cannot be terminal')
  } else {
    timestamp(record.completedAtUtc, 'stage.completedAtUtc')
  }
  if (record.evidencePath !== null) absolutePath(record.evidencePath, 'stage.evidencePath')
  if (record.errorCode !== null) boundedCode(record.errorCode)
}

function validateRecovery(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('recovery plan is required')
  recoveryAction(value.action)
  if (typeof value.automatic !== 'boolean') throw new Error('recovery.automatic must be boolean')
  rolloutStage(value.failedStage)
  boundedCode(value.reason)
}

function validateRecoveryRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('recovery record is invalid')
  recoveryAction(value.action)
  rolloutStage(value.failedStage)
  enumValue(value.status, ['ok', 'failed'], 'recovery.status')
  if (typeof value.automatic !== 'boolean') throw new Error('recovery.automatic must be boolean')
  timestamp(value.completedAtUtc, 'recovery.completedAtUtc')
  if (value.evidencePath !== null) absolutePath(value.evidencePath, 'recovery.evidencePath')
  if (value.status === 'ok') {
    if (value.evidencePath === null || value.errorCode !== null) throw new Error('successful recovery requires evidence and no error')
  } else {
    boundedCode(value.errorCode)
  }
}

function recoveryAction(value) {
  return enumValue(value, [
        'preserve-source-stop-candidate',
        'gateway-recover',
        'resume-release-activation-same-cutover',
        'retain-source-report-cleanup-blocker',
        'resume-release-evidence'
  ], 'recovery.action')
}

function releaseIdentity(value, label)
{
    if (!value || typeof value !== 'object' || Array.isArray(value)) {throw new Error(`${label} identity is required`)};
    if (!['blue', 'green'].includes(value.slot)) {throw new Error(`${label}.slot must be blue or green`)};
    if (!isValidReleaseId(value.releaseId)) {throw new Error(`${label}.releaseId is invalid`)};
    if (!DIGEST.test(String(value.imageDigest ?? ''))) {throw new Error(`${label}.imageDigest is invalid`)};
    const generation = Number(value.runtimeGeneration);
    if (!Number.isSafeInteger(generation) || generation < 1) {throw new Error(`${label}.runtimeGeneration is invalid`)};
  return { slot: value.slot, releaseId: value.releaseId, imageDigest: value.imageDigest, runtimeGeneration: generation }
}

function rolloutId(value) {
  const id = String(value ?? '')
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{7,127}$/u.test(id)) throw new Error('rolloutId is invalid')
  return id
}

function rolloutStage(value) {
  return enumValue(value, ROLLOUT_STAGES, 'stage')
}

function enumValue(value, allowed, label) {
  if (!allowed.includes(value)) throw new Error(`${label} is invalid`)
  return value
}

function timestamp(value, label) {
  const result = String(value ?? '')
  if (!ISO_UTC.test(result) || !Number.isFinite(Date.parse(result))) throw new Error(`${label} must be ISO UTC`)
  return result
}

function absolutePath(value, label) {
  const result = String(value ?? '')
  if (!path.isAbsolute(result) || result.includes('\0')) throw new Error(`${label} must be an absolute path`)
  return result
}

function boundedCode(value) {
  const result = String(value ?? '').trim()
  if (!/^[0-9A-Za-z][0-9A-Za-z._:-]{0,127}$/u.test(result)) throw new Error('error/reason code is invalid')
  return result
}
