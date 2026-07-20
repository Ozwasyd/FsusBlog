import fs from 'node:fs'
import path from 'node:path'
import { isValidReleaseId } from '../release/release-id.mjs'

export const SLOT_STATE_SCHEMA = 'fsusblog.deployment-slots.v1'
export const LEGACY_SLOT_STATE_RETIREMENT =
  'Remove the legacy slot-state reader after every pre-canonical N-1 rollback target has expired.'
export const RELEASE_SLOTS = Object.freeze(['blue', 'green'])
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u
const IMAGE_REF = /^[a-z0-9]+(?:[._/-][a-z0-9]+)*(?::[0-9]+(?:\/[a-z0-9]+(?:[._/-][a-z0-9]+)*)?)?@sha256:[0-9a-f]{64}$/u
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u

export function requireSlot(value) {
  const slot = String(value ?? '')
  if (!RELEASE_SLOTS.includes(slot)) throw new Error('slot must be blue or green')
  return slot
}

export function resolveSlotConfig(slotValue, environment = process.env) {
  const slot = requireSlot(slotValue)
  const bluePort = parsePort(environment.FSUSBLOG_BLUE_PORT ?? '8081', 'FSUSBLOG_BLUE_PORT')
  const greenPort = parsePort(environment.FSUSBLOG_GREEN_PORT ?? '8082', 'FSUSBLOG_GREEN_PORT')
  if (bluePort === greenPort) throw new Error('blue and green ports must be different')
  return Object.freeze({
    slot,
    host: '127.0.0.1',
    port: slot === 'blue' ? bluePort : greenPort,
    projectName: `fsusblog-${slot}`,
    containerName: `fsus-app-${slot}`,
    aotCacheVolume: `fsusblog-aot-cache-${slot}`,
    logsVolume: `fsusblog-logs-${slot}`,
    dataVolume: `fsusblog-data-${slot}`,
    sharedUploadsVolume: environment.FSUSBLOG_SHARED_UPLOADS_VOLUME ?? 'fsusblog-uploads',
    sharedDataProtectionVolume: environment.FSUSBLOG_SHARED_DATA_PROTECTION_VOLUME ?? 'fsusblog-data-protection'
  })
}

export function createEmptySlotState(now = new Date().toISOString()) {
  return {
    schema: SLOT_STATE_SCHEMA,
    activeSlot: null,
    activeReleaseId: null,
    activeImageDigest: null,
    previousSlot: null,
    previousReleaseId: null,
    previousImageDigest: null,
    switchedAtUtc: null,
    switchGeneration: 0,
    runtimeGeneration: 0,
    status: 'stable',
    pendingTransition: null,
    slots: { blue: null, green: null },
    lastTransition: null,
    lastTrafficTransition: null,
    updatedAt: normalizeTimestamp(now, 'updatedAt')
  }
}

export function readSlotState(file, options = {}) {
  if (!fs.existsSync(file)) {
    if (options.allowMissing === false) throw new Error(`slot state does not exist: ${file}`)
    return createEmptySlotState(options.now)
  }
  let state
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`unable to read slot state: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (requiresLegacyUpgrade(state)) {
    throw new Error('legacy slot state requires the explicit readLegacySlotState compatibility entrypoint')
  }
  validateSlotState(state)
  return state
}

export function readLegacySlotState(file) {
  let state
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`unable to read legacy slot state: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!requiresLegacyUpgrade(state)) throw new Error('slot state is not a supported legacy shape')
  upgradeLegacyGatewayState(state)
  upgradeRuntimeGenerationState(state)
  validateSlotState(state)
  return Object.freeze({
    legacy: true,
    rollbackOnly: true,
    retirementCondition: LEGACY_SLOT_STATE_RETIREMENT,
    state
  })
}

function requiresLegacyUpgrade(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state) || state.schema !== SLOT_STATE_SCHEMA) return false
  const gatewayFields = [
    'activeReleaseId', 'activeImageDigest', 'previousSlot', 'previousReleaseId',
    'previousImageDigest', 'switchedAtUtc', 'switchGeneration', 'status',
    'pendingTransition', 'lastTrafficTransition'
  ]
  return !Object.hasOwn(state, 'runtimeGeneration') || gatewayFields.some(field => !Object.hasOwn(state, field))
}

function upgradeRuntimeGenerationState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state) || state.schema !== SLOT_STATE_SCHEMA) return
  if (Object.hasOwn(state, 'runtimeGeneration')) return
  const recorded = RELEASE_SLOTS
    .map(slot => state.slots?.[slot]?.deploymentGeneration)
    .filter(value => Number.isSafeInteger(value) && value > 0)
  const inferredFloor = state.activeSlot === null
    ? state.switchGeneration
    : state.switchGeneration + 1
  state.runtimeGeneration = Math.max(inferredFloor, 0, ...recorded)
}

function upgradeLegacyGatewayState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state) || state.schema !== SLOT_STATE_SCHEMA) return
  const gatewayFields = [
    'activeReleaseId',
    'activeImageDigest',
    'previousSlot',
    'previousReleaseId',
    'previousImageDigest',
    'switchedAtUtc',
    'switchGeneration',
    'status',
    'pendingTransition',
    'lastTrafficTransition'
  ]
  const presentCount = gatewayFields.filter(field => Object.hasOwn(state, field)).length
  if (presentCount === gatewayFields.length) return
  if (presentCount !== 0) throw new Error('slot state has a partial gateway-state extension and cannot be inferred safely')

  const activeSlot = state.activeSlot === null ? null : requireSlot(state.activeSlot)
  const activeRecord = activeSlot === null ? null : state.slots?.[activeSlot]
  if (activeSlot !== null && (!activeRecord?.releaseId || !activeRecord?.imageDigest)) {
    throw new Error('legacy active slot has no complete immutable release identity')
  }
  const trafficTransition = ['bootstrap', 'switch', 'rollback'].includes(state.lastTransition?.kind)
    ? state.lastTransition
    : null
  state.activeReleaseId = activeRecord?.releaseId ?? null
  state.activeImageDigest = activeRecord?.imageDigest ?? null
  state.previousSlot = null
  state.previousReleaseId = null
  state.previousImageDigest = null
  state.switchedAtUtc = activeSlot === null ? null : (trafficTransition?.at ?? state.updatedAt)
  state.switchGeneration = activeSlot === null ? 0 : 1
  state.status = 'stable'
  state.pendingTransition = null
  state.lastTrafficTransition = trafficTransition
}

export function validateSlotState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('slot state must be an object')
  if (state.schema !== SLOT_STATE_SCHEMA) throw new Error(`slot state schema must be ${SLOT_STATE_SCHEMA}`)
  if (state.activeSlot !== null) requireSlot(state.activeSlot)
  if (!['stable', 'switching', 'rollback_required'].includes(state.status)) throw new Error('slot state status is invalid')
  if (!Number.isSafeInteger(state.switchGeneration) || state.switchGeneration < 0) throw new Error('switchGeneration must be a non-negative integer')
  if (!Number.isSafeInteger(state.runtimeGeneration) || state.runtimeGeneration < 0) throw new Error('runtimeGeneration must be a non-negative integer')
  if (!state.slots || typeof state.slots !== 'object' || Array.isArray(state.slots)) throw new Error('slot state slots object is required')
  if (Object.keys(state.slots).sort().join(',') !== 'blue,green') throw new Error('slot state must contain exactly blue and green')
  for (const slot of RELEASE_SLOTS) validateSlotRecord(state.slots[slot], slot)
  validateActiveIdentity(state)
  validatePreviousIdentity(state)
  if (state.switchedAtUtc !== null) normalizeTimestamp(state.switchedAtUtc, 'switchedAtUtc')
  if (state.pendingTransition !== null) validatePendingTransition(state.pendingTransition)
  if (state.status === 'stable' && state.pendingTransition !== null) throw new Error('stable slot state cannot retain a pending transition')
  if (state.status === 'switching' && state.pendingTransition === null) throw new Error('switching slot state requires a pending transition')
  if (state.lastTransition !== null) validateTransition(state.lastTransition)
  if (state.lastTrafficTransition !== null) {
    validateTransition(state.lastTrafficTransition)
    if (!['bootstrap', 'switch', 'rollback'].includes(state.lastTrafficTransition.kind)) throw new Error('lastTrafficTransition kind is invalid')
  }
  normalizeTimestamp(state.updatedAt, 'updatedAt')
  return state
}

export function recordSlotStart(state, input) {
  validateSlotState(state)
  const slot = requireSlot(input.slot)
  const config = resolveSlotConfig(slot, input.environment)
  const releaseId = validateReleaseId(input.releaseId)
  const imageDigest = validateImageDigest(input.imageDigest)
  const imageRef = validateImageRef(input.imageRef, imageDigest)
  let deploymentGeneration
  if (input.deploymentGeneration === undefined || input.deploymentGeneration === null) {
    deploymentGeneration = state.runtimeGeneration + 1
    state.runtimeGeneration = deploymentGeneration
  } else {
    deploymentGeneration = Number(input.deploymentGeneration)
    if (!Number.isSafeInteger(deploymentGeneration) || deploymentGeneration < 1) throw new Error('deploymentGeneration must be a positive integer')
    if (deploymentGeneration !== state.runtimeGeneration) throw new Error('deploymentGeneration must equal the latest reserved runtime generation')
  }
  if (state.activeSlot === slot && (state.slots[slot]?.releaseId !== releaseId || state.slots[slot]?.imageDigest !== imageDigest)) {
    throw new Error(`cannot replace active slot ${slot}`)
  }
  const now = normalizeTimestamp(input.startedAt ?? new Date().toISOString(), 'startedAt')
  state.slots[slot] = {
    releaseId,
    imageRef,
    imageDigest,
    deploymentGeneration,
    projectName: config.projectName,
    containerName: config.containerName,
    host: config.host,
    port: config.port,
    status: 'running',
    lastSuccessfulStartAt: now,
    lastObservedAt: now
  }
  state.lastTransition = transition('start', 'ok', null, slot, releaseId, now, null)
  state.updatedAt = now
  validateSlotState(state)
  return state
}

export function reserveRuntimeGeneration(state, input = {}) {
  validateSlotState(state)
  if (input.slot !== undefined) requireSlot(input.slot)
  const now = normalizeTimestamp(input.reservedAt ?? new Date().toISOString(), 'reservedAt')
  if (state.runtimeGeneration >= Number.MAX_SAFE_INTEGER) throw new Error('runtimeGeneration is exhausted')
  state.runtimeGeneration += 1
  state.updatedAt = now
  validateSlotState(state)
  return state.runtimeGeneration
}

export function recordSlotStop(state, input) {
  validateSlotState(state)
  const slot = requireSlot(input.slot)
  if (state.activeSlot === slot) throw new Error(`refusing to stop active slot ${slot}`)
  const now = normalizeTimestamp(input.stoppedAt ?? new Date().toISOString(), 'stoppedAt')
  if (state.slots[slot]) {
    state.slots[slot] = { ...state.slots[slot], status: 'stopped', lastObservedAt: now }
  }
  state.lastTransition = transition('stop', 'ok', slot, null, state.slots[slot]?.releaseId ?? null, now, null)
  state.updatedAt = now
  validateSlotState(state)
  return state
}

export function recordSlotFailure(state, input) {
  validateSlotState(state)
  const slot = requireSlot(input.slot)
  const now = normalizeTimestamp(input.failedAt ?? new Date().toISOString(), 'failedAt')
  const operation = String(input.operation ?? 'start')
  if (!['start', 'stop', 'inspect', 'preflight', 'switch', 'rollback'].includes(operation)) throw new Error('invalid failed operation')
  const message = String(input.message ?? '').trim().slice(0, 512)
  if (!message) throw new Error('failure message is required')
  state.lastTransition = transition(operation, 'failed', state.activeSlot, slot, input.releaseId ?? null, now, message)
  if (operation === 'switch' || operation === 'rollback') state.lastTrafficTransition = state.lastTransition
  state.updatedAt = now
  validateSlotState(state)
  return state
}

export function setActiveSlot(state, input) {
  validateSlotState(state)
  const slot = requireSlot(input.slot)
  const record = state.slots[slot]
  if (!record || record.status !== 'running') throw new Error(`slot ${slot} is not recorded as running`)
  const kind = String(input.kind ?? 'switch')
  if (!['bootstrap', 'switch', 'rollback'].includes(kind)) throw new Error('active transition kind is invalid')
  const now = normalizeTimestamp(input.changedAt ?? new Date().toISOString(), 'changedAt')
  const previous = state.activeSlot
  const previousRecord = previous === null ? null : state.slots[previous]
  state.previousSlot = previous
  state.previousReleaseId = previousRecord?.releaseId ?? null
  state.previousImageDigest = previousRecord?.imageDigest ?? null
  state.activeSlot = slot
  state.activeReleaseId = record.releaseId
  state.activeImageDigest = record.imageDigest
  state.switchedAtUtc = now
  state.switchGeneration += 1
  state.status = 'stable'
  state.pendingTransition = null
  state.lastTransition = transition(kind, 'ok', previous, slot, record.releaseId, now, null)
  state.lastTrafficTransition = state.lastTransition
  state.updatedAt = now
  validateSlotState(state)
  return state
}

export function beginGatewayTransition(state, input) {
  validateSlotState(state)
  if (state.status !== 'stable') throw new Error(`gateway state is ${state.status}; recovery is required before another transition`)
  if (state.activeSlot === null || state.activeReleaseId === null || state.activeImageDigest === null) throw new Error('active gateway identity is not initialized')
  const targetSlot = requireSlot(input.slot)
  if (targetSlot === state.activeSlot) throw new Error('target slot is already active')
  const target = state.slots[targetSlot]
  if (!target || target.status !== 'running') throw new Error(`target slot ${targetSlot} is not recorded as running`)
  const releaseId = validateReleaseId(input.releaseId)
  const imageDigest = validateImageDigest(input.imageDigest)
  if (target.releaseId !== releaseId || target.imageDigest !== imageDigest) throw new Error('target release identity does not match persisted slot')
  const kind = String(input.kind ?? 'switch')
  if (!['switch', 'rollback'].includes(kind)) throw new Error('gateway transition kind is invalid')
  if (kind === 'rollback' && (state.previousSlot !== targetSlot || state.previousReleaseId !== releaseId || state.previousImageDigest !== imageDigest)) {
    throw new Error('rollback target does not match the recorded previous release')
  }
  const startedAt = normalizeTimestamp(input.startedAt ?? new Date().toISOString(), 'startedAt')
  state.status = 'switching'
  state.pendingTransition = {
    kind,
    fromSlot: state.activeSlot,
    fromReleaseId: state.activeReleaseId,
    fromImageDigest: state.activeImageDigest,
    toSlot: targetSlot,
    toReleaseId: releaseId,
    toImageDigest: imageDigest,
    generation: state.switchGeneration + 1,
    startedAt
  }
  state.updatedAt = startedAt
  validateSlotState(state)
  return state
}

export function commitGatewayTransition(state, input = {}) {
  validateSlotState(state)
  if (!['switching', 'rollback_required'].includes(state.status) || state.pendingTransition === null) {
    throw new Error('no recoverable gateway transition can be committed')
  }
  const pending = state.pendingTransition
  const target = state.slots[pending.toSlot]
  if (!target || target.status !== 'running' || target.releaseId !== pending.toReleaseId || target.imageDigest !== pending.toImageDigest) {
    throw new Error('pending target release is no longer a running persisted slot')
  }
  const committedAt = normalizeTimestamp(input.committedAt ?? new Date().toISOString(), 'committedAt')
  state.previousSlot = pending.fromSlot
  state.previousReleaseId = pending.fromReleaseId
  state.previousImageDigest = pending.fromImageDigest
  state.activeSlot = pending.toSlot
  state.activeReleaseId = pending.toReleaseId
  state.activeImageDigest = pending.toImageDigest
  state.switchedAtUtc = committedAt
  state.switchGeneration = pending.generation
  state.status = 'stable'
  state.pendingTransition = null
  state.lastTransition = transition(pending.kind, 'ok', pending.fromSlot, pending.toSlot, pending.toReleaseId, committedAt, null)
  state.lastTrafficTransition = state.lastTransition
  state.updatedAt = committedAt
  validateSlotState(state)
  return state
}

export function abortGatewayTransition(state, input) {
  validateSlotState(state)
  if (state.pendingTransition === null) throw new Error('no pending gateway transition can be aborted')
  const pending = state.pendingTransition
  const abortedAt = normalizeTimestamp(input.abortedAt ?? new Date().toISOString(), 'abortedAt')
  const message = validateFailureMessage(input.message)
  state.status = 'stable'
  state.pendingTransition = null
  state.lastTransition = transition(pending.kind, 'failed', pending.fromSlot, pending.toSlot, pending.toReleaseId, abortedAt, message)
  state.lastTrafficTransition = state.lastTransition
  state.updatedAt = abortedAt
  validateSlotState(state)
  return state
}

export function markGatewayRollbackRequired(state, input) {
  validateSlotState(state)
  if (state.pendingTransition === null) throw new Error('no pending gateway transition can require rollback')
  const pending = state.pendingTransition
  const failedAt = normalizeTimestamp(input.failedAt ?? new Date().toISOString(), 'failedAt')
  const message = validateFailureMessage(input.message)
  state.status = 'rollback_required'
  state.lastTransition = transition(pending.kind, 'failed', pending.fromSlot, pending.toSlot, pending.toReleaseId, failedAt, message)
  state.lastTrafficTransition = state.lastTransition
  state.updatedAt = failedAt
  validateSlotState(state)
  return state
}

export function writeSlotStateAtomic(file, state) {
  validateSlotState(state)
  const directory = path.dirname(file)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = path.join(directory, `.${path.basename(file)}.tmp-${process.pid}-${cryptoRandomSuffix()}`)
  let descriptor
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporary, file)
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

function validateSlotRecord(record, slot) {
  if (record === null) return
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error(`slot ${slot} record is invalid`)
  const config = resolveSlotConfig(slot, {
    FSUSBLOG_BLUE_PORT: slot === 'blue' ? String(record.port) : '8081',
    FSUSBLOG_GREEN_PORT: slot === 'green' ? String(record.port) : '8082'
  })
  validateReleaseId(record.releaseId)
  validateImageDigest(record.imageDigest)
  validateImageRef(record.imageRef, record.imageDigest)
  if (record.projectName !== `fsusblog-${slot}` || record.containerName !== `fsus-app-${slot}`) throw new Error(`slot ${slot} identity is inconsistent`)
  if (record.host !== '127.0.0.1' || record.port !== config.port) throw new Error(`slot ${slot} loopback port is invalid`)
  if (!['running', 'stopped', 'unknown'].includes(record.status)) throw new Error(`slot ${slot} status is invalid`)
  if (record.deploymentGeneration !== undefined && record.deploymentGeneration !== null
    && (!Number.isSafeInteger(record.deploymentGeneration) || record.deploymentGeneration < 1)) {
    throw new Error(`slot ${slot} deploymentGeneration is invalid`)
  }
  normalizeTimestamp(record.lastSuccessfulStartAt, `${slot}.lastSuccessfulStartAt`)
  normalizeTimestamp(record.lastObservedAt, `${slot}.lastObservedAt`)
}

function validateTransition(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('lastTransition is invalid')
  if (!['start', 'stop', 'inspect', 'preflight', 'bootstrap', 'switch', 'rollback'].includes(value.kind)) throw new Error('lastTransition.kind is invalid')
  if (!['ok', 'failed'].includes(value.status)) throw new Error('lastTransition.status is invalid')
  if (value.fromSlot !== null) requireSlot(value.fromSlot)
  if (value.toSlot !== null) requireSlot(value.toSlot)
  if (value.releaseId !== null) validateReleaseId(value.releaseId)
  normalizeTimestamp(value.at, 'lastTransition.at')
  if (value.error !== null && (typeof value.error !== 'string' || value.error.length === 0 || value.error.length > 512)) throw new Error('lastTransition.error is invalid')
}

function validateActiveIdentity(state) {
  if (state.activeSlot === null) {
    if (state.activeReleaseId !== null || state.activeImageDigest !== null) throw new Error('active release identity requires activeSlot')
    return
  }
  const record = state.slots[state.activeSlot]
  if (!record) throw new Error('activeSlot must have a persisted slot record')
  validateReleaseId(state.activeReleaseId)
  validateImageDigest(state.activeImageDigest)
  if (record.releaseId !== state.activeReleaseId || record.imageDigest !== state.activeImageDigest) throw new Error('active release identity does not match slot record')
}

function validatePreviousIdentity(state) {
  const values = [state.previousSlot, state.previousReleaseId, state.previousImageDigest]
  if (values.every(value => value === null)) return
  if (values.some(value => value === null)) throw new Error('previous release identity must be complete')
  requireSlot(state.previousSlot)
  validateReleaseId(state.previousReleaseId)
  validateImageDigest(state.previousImageDigest)
}

function validatePendingTransition(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('pendingTransition is invalid')
  if (!['switch', 'rollback'].includes(value.kind)) throw new Error('pendingTransition.kind is invalid')
  requireSlot(value.fromSlot)
  requireSlot(value.toSlot)
  if (value.fromSlot === value.toSlot) throw new Error('pendingTransition slots must differ')
  validateReleaseId(value.fromReleaseId)
  validateReleaseId(value.toReleaseId)
  validateImageDigest(value.fromImageDigest)
  validateImageDigest(value.toImageDigest)
  if (!Number.isSafeInteger(value.generation) || value.generation < 1) throw new Error('pendingTransition.generation is invalid')
  normalizeTimestamp(value.startedAt, 'pendingTransition.startedAt')
}

function transition(kind, status, fromSlot, toSlot, releaseId, at, error) {
  return { kind, status, fromSlot, toSlot, releaseId, at, error }
}

function validateFailureMessage(value) {
  const message = String(value ?? '').trim().slice(0, 512)
  if (!message) throw new Error('failure message is required')
  return message
}

function validateReleaseId(value) {
  const releaseId = String(value ?? '')
  if (!isValidReleaseId(releaseId)) throw new Error('releaseId is invalid or mutable')
  return releaseId
}

function validateImageDigest(value) {
  const digest = String(value ?? '')
  if (!IMAGE_DIGEST.test(digest)) throw new Error('imageDigest must be sha256:<64 lowercase hex>')
  return digest
}

function validateImageRef(value, digest) {
  const imageRef = String(value ?? '')
  if (!IMAGE_REF.test(imageRef) || !imageRef.endsWith(`@${digest}`)) throw new Error('imageRef must be an immutable repository@digest matching imageDigest')
  return imageRef
}

function parsePort(value, label) {
  if (!/^[0-9]+$/u.test(String(value))) throw new Error(`${label} must be a port`)
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error(`${label} must be between 1 and 65535`)
  return port
}

function normalizeTimestamp(value, label) {
  const timestamp = String(value ?? '')
  if (!ISO_UTC.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) throw new Error(`${label} must be an ISO UTC timestamp`)
  return timestamp
}

function cryptoRandomSuffix() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}
