#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  readRolloutState,
  validateRolloutState
} from './release-rollout-lib.mjs'

export const WORKER_OBSERVER_SERVICE_PLAN_SCHEMA = 'fsusblog.release-worker-observer-service-plan.v1'
export const WORKER_OBSERVER_RESPONSE_SCHEMA = 'fsusblog.release-worker-observer-service-response.v1'
export const NORMAL_WORKER_OBSERVER_SCHEMA = 'fsusblog.release-worker-normal-observer.v1'
export const NORMAL_WORKER_COMMAND_SCHEMA = 'fsusblog.release-worker-normal-observer-command.v1'
export const WORKER_OBSERVER_ACKNOWLEDGEMENT = 'OBSERVE_ISOLATED_TEST_WORKERS_ONLY'
export const NORMAL_WORKER_KINDS = Object.freeze([
  'scheduled-publish',
  'article-mutation-outbox',
  'audit-writer',
  'visit-view-projection',
  'public-hot-aot',
  'upload-cleanup',
  'active-singleton-control',
  'multi-consumer-safe-control'
])
export const WORKER_KINDS = Object.freeze([...NORMAL_WORKER_KINDS, 'forced-source-recovery'])

const ACTION_ROUTES = Object.freeze([
  '/actions/audit-writer',
  '/actions/public-hot-aot',
  '/actions/upload-cleanup',
  '/actions/upload-cleanup/wake-target',
  '/actions/active-singleton-control',
  '/actions/multi-consumer-safe-control',
  '/actions/forced-source-recovery/hold-after-claim',
  '/actions/forced-source-recovery/release-target'
])
const NORMAL_START_PATH = '/api/ops/release/workers/normal/start'
const NORMAL_STATUS_PATH = '/api/ops/release/workers/normal/status'
const NORMAL_FINALIZE_PATH = '/api/ops/release/workers/normal/finalize'
const SAFE_ID = /^[0-9A-Za-z][0-9A-Za-z._:-]{7,127}$/u
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u
const SAFE_RESULT_ALIAS = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u
const SAFE_CONTAINER = /^[0-9A-Za-z][0-9A-Za-z_.-]{1,127}$/u
const SAFE_ENV_NAME = /^[A-Z][A-Z0-9_]{2,127}$/u
const SAFE_HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{1,63}$/u
const SAFE_RELATIVE_PATH = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,500}$/u
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u
const DURABLE_REPLAY_SOURCES = new Set([
  'postgres-outbox',
  'postgres-row-lock',
  'redis-stream',
  'durable-upload-session'
])
const REQUIRED_COLUMNS = Object.freeze([
  'logicalEventId',
  'rolloutId',
  'kind',
  'attemptKey',
  'status',
  'releaseId',
  'generation',
  'effectKey',
  'workerIdentity',
  'durableReplaySource'
])
const OPTIONAL_COLUMNS = new Set([
  'articleId',
  'observedAtUtc',
  'expectedEffectCount',
  'auditCount',
  'projectionCount',
  'ownerCount',
  'consumerCount',
  'sourceClaimObserved',
  'sourceFinalCommitObserved',
  'recoveredByTarget'
])
const FORBIDDEN_AUTHORITY_KEYS = new Set([
  'finalEffectCount',
  'finalEffectKey',
  'finalReleaseId',
  'finalGeneration',
  'staleGenerationCommitCount',
  'actualAuditCount',
  'actualProjectionCount',
  'maximumConcurrentOwnerCount',
  'recoveredByTarget'
])
const PRIVATE_ENV_KEYS = new Set([
  'FSUSBLOG_WORKER_OBSERVER_PGHOST',
  'FSUSBLOG_WORKER_OBSERVER_PGPORT',
  'FSUSBLOG_WORKER_OBSERVER_PGDATABASE',
  'FSUSBLOG_WORKER_OBSERVER_PGUSER',
  'FSUSBLOG_WORKER_OBSERVER_PGPASSWORD',
  'FSUSBLOG_WORKER_OBSERVER_REDIS_HOST',
  'FSUSBLOG_WORKER_OBSERVER_REDIS_PORT',
  'FSUSBLOG_WORKER_OBSERVER_REDIS_DATABASE',
  'FSUSBLOG_WORKER_OBSERVER_REDIS_PASSWORD'
])
const REQUIRED_PRIVATE_ENV_KEYS = Object.freeze([
  'FSUSBLOG_WORKER_OBSERVER_PGHOST',
  'FSUSBLOG_WORKER_OBSERVER_PGPORT',
  'FSUSBLOG_WORKER_OBSERVER_PGDATABASE',
  'FSUSBLOG_WORKER_OBSERVER_PGUSER',
  'FSUSBLOG_WORKER_OBSERVER_PGPASSWORD',
  'FSUSBLOG_WORKER_OBSERVER_REDIS_HOST',
  'FSUSBLOG_WORKER_OBSERVER_REDIS_PORT',
  'FSUSBLOG_WORKER_OBSERVER_REDIS_DATABASE'
])
const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = path.resolve(MODULE_DIRECTORY, '../..')

export class WorkerObserverServiceError extends Error {
  constructor(errors, statusCode = 500) {
    const normalized = unique((Array.isArray(errors) ? errors : [errors]).map(message).filter(Boolean))
    super(normalized.join('; ') || 'worker observer service failed closed')
    this.name = 'WorkerObserverServiceError'
    this.errors = normalized
    this.statusCode = statusCode
  }
}

export function assertWorkerObserverEnvironment(environment = process.env) {
  const errors = []
  if (environment.ASPNETCORE_ENVIRONMENT !== 'Test') errors.push('ASPNETCORE_ENVIRONMENT must be exactly Test')
  if (environment.FSUSBLOG_ROLLOUT_REHEARSAL !== '1') errors.push('FSUSBLOG_ROLLOUT_REHEARSAL must be exactly 1')
  if (environment.FSUSBLOG_WORKER_OBSERVER_ENABLED !== '1') errors.push('FSUSBLOG_WORKER_OBSERVER_ENABLED must be exactly 1')
  if (errors.length > 0) throw new WorkerObserverServiceError(errors, 403)
  return true
}

export function normalizeWorkerObserverServicePlan(value) {
  const errors = []
  if (!isObject(value)) throw new WorkerObserverServiceError(['plan must be a JSON object'], 400)
  if (value.schema !== WORKER_OBSERVER_SERVICE_PLAN_SCHEMA) {
    errors.push(`plan.schema must be ${WORKER_OBSERVER_SERVICE_PLAN_SCHEMA}`)
  }
  if (value.nonProductionOnly !== true) errors.push('plan.nonProductionOnly must be true')
  if (value.acknowledgement !== WORKER_OBSERVER_ACKNOWLEDGEMENT) {
    errors.push(`plan.acknowledgement must be ${WORKER_OBSERVER_ACKNOWLEDGEMENT}`)
  }
  const serialized = JSON.stringify(value)
  if (/REPLACE_|<[^>]+>|\{\{[^}]+\}\}/u.test(serialized)) errors.push('plan contains unresolved template placeholders')
  collectForbiddenAuthorityKeys(value, 'plan', errors)

  let listen = null
  try {
    const host = requiredLoopbackHost(value.listen?.host, 'plan.listen.host')
    const port = boundedInteger(value.listen?.port, 1, 65_535, 'plan.listen.port')
    listen = { host, port }
  } catch (error) {
    errors.push(message(error))
  }

  let topology = null
  try {
    topology = normalizeTopology(value.topology)
  } catch (error) {
    errors.push(...errorList(error))
  }

  let observation = null
  try {
    observation = normalizeObservation(value.observation)
  } catch (error) {
    errors.push(...errorList(error))
  }

  const workers = []
  const routes = new Map()
  if (!Array.isArray(value.workers) || value.workers.length !== WORKER_KINDS.length) {
    errors.push(`plan.workers must contain exactly ${WORKER_KINDS.length} worker definitions`)
  } else {
    for (let index = 0; index < value.workers.length; index += 1) {
      const expectedKind = WORKER_KINDS[index]
      try {
        const worker = normalizeWorker(value.workers[index], expectedKind)
        workers.push(worker)
        for (const route of worker.actions) {
          if (routes.has(route.path)) errors.push(`duplicate action route ${route.path}`)
          routes.set(route.path, { kind: worker.kind, ...route })
        }
      } catch (error) {
        errors.push(...errorList(error))
      }
    }
  }
  const actualRoutes = [...routes.keys()].sort()
  const expectedRoutes = [...ACTION_ROUTES].sort()
  if (actualRoutes.join('\n') !== expectedRoutes.join('\n')) {
    errors.push(`plan action routes must be exactly: ${ACTION_ROUTES.join(', ')}`)
  }
  if (errors.length > 0) throw new WorkerObserverServiceError(errors, 400)
  return {
    schema: WORKER_OBSERVER_SERVICE_PLAN_SCHEMA,
    nonProductionOnly: true,
    acknowledgement: WORKER_OBSERVER_ACKNOWLEDGEMENT,
    listen,
    topology,
    observation,
    workers,
    routes
  }
}

function normalizeTopology(value) {
  const errors = []
  if (!isObject(value)) throw new WorkerObserverServiceError(['plan.topology must be an object'], 400)
  let source = null
  let target = null
  try { source = normalizeSlotTopology(value.source, 'plan.topology.source') } catch (error) { errors.push(...errorList(error)) }
  try { target = normalizeSlotTopology(value.target, 'plan.topology.target') } catch (error) { errors.push(...errorList(error)) }
  if (source?.origin === target?.origin) errors.push('source and target origins must differ')
  if (source?.container.name === target?.container.name) errors.push('source and target containers must differ')
  let adminStatusPath = null
  try { adminStatusPath = safeRelativePath(value.adminStatusPath, 'plan.topology.adminStatusPath') } catch (error) { errors.push(message(error)) }
  let redisFenceKeyTemplate = null
  try {
    redisFenceKeyTemplate = requiredString(value.redisFenceKeyTemplate, 'plan.topology.redisFenceKeyTemplate')
    if (!redisFenceKeyTemplate.includes('{rolloutId}') || !redisFenceKeyTemplate.includes('{slot}')) {
      errors.push('plan.topology.redisFenceKeyTemplate must contain {rolloutId} and {slot}')
    }
    if (!/^[0-9A-Za-z:._{}-]{8,300}$/u.test(redisFenceKeyTemplate)) {
      errors.push('plan.topology.redisFenceKeyTemplate contains unsafe characters')
    }
  } catch (error) {
    errors.push(message(error))
  }
  if (errors.length > 0) throw new WorkerObserverServiceError(errors, 400)
  return { source, target, adminStatusPath, redisFenceKeyTemplate }
}

function normalizeSlotTopology(value, label) {
  if (!isObject(value)) throw new WorkerObserverServiceError([`${label} must be an object`], 400)
  const origin = normalizeLoopbackOrigin(value.origin, `${label}.origin`)
  if (!isObject(value.container)) throw new WorkerObserverServiceError([`${label}.container must be an object`], 400)
  const name = requiredString(value.container.name, `${label}.container.name`)
  if (!SAFE_CONTAINER.test(name)) throw new WorkerObserverServiceError([`${label}.container.name is unsafe`], 400)
  if (!isObject(value.container.identityLabels)) {
    throw new WorkerObserverServiceError([`${label}.container.identityLabels must be an object`], 400)
  }
  const identityLabels = {}
  for (const field of ['releaseId', 'slot', 'generation']) {
    const key = requiredString(value.container.identityLabels[field], `${label}.container.identityLabels.${field}`)
    if (!/^[0-9A-Za-z][0-9A-Za-z_.-]{2,127}$/u.test(key)) {
      throw new WorkerObserverServiceError([`${label}.container.identityLabels.${field} is invalid`], 400)
    }
    identityLabels[field] = key
  }
  if (new Set(Object.values(identityLabels)).size !== 3) {
    throw new WorkerObserverServiceError([`${label}.container.identityLabels must be distinct`], 400)
  }
  return { origin, container: { name, identityLabels } }
}

function normalizeObservation(value) {
  const errors = []
  if (!isObject(value)) throw new WorkerObserverServiceError(['plan.observation must be an object'], 400)
  const schemaName = String(value.schemaName ?? '')
  const table = String(value.table ?? '')
  if (!SAFE_IDENTIFIER.test(schemaName)) errors.push('plan.observation.schemaName is invalid')
  if (!SAFE_IDENTIFIER.test(table)) errors.push('plan.observation.table is invalid')
  let maxRecords = null
  try { maxRecords = boundedInteger(value.maxRecords ?? 256, 9, 2_000, 'plan.observation.maxRecords') } catch (error) { errors.push(message(error)) }
  const columns = {}
  if (!isObject(value.columns)) {
    errors.push('plan.observation.columns must be an object')
  } else {
    const allowed = new Set([...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS])
    for (const key of Object.keys(value.columns)) {
      if (!allowed.has(key)) errors.push(`plan.observation.columns.${key} is not supported`)
    }
    for (const field of REQUIRED_COLUMNS) {
      const column = String(value.columns[field] ?? '')
      if (!SAFE_IDENTIFIER.test(column)) errors.push(`plan.observation.columns.${field} is required and must be a safe identifier`)
      else columns[field] = column
    }
    for (const field of OPTIONAL_COLUMNS) {
      if (value.columns[field] === undefined) continue
      const column = String(value.columns[field])
      if (!SAFE_IDENTIFIER.test(column)) errors.push(`plan.observation.columns.${field} must be a safe identifier`)
      else columns[field] = column
    }
    if (new Set(Object.values(columns)).size !== Object.values(columns).length) {
      errors.push('plan.observation.columns must map to distinct database columns')
    }
  }
  if (errors.length > 0) throw new WorkerObserverServiceError(errors, 400)
  return { schemaName, table, maxRecords, columns }
}

function normalizeWorker(value, expectedKind) {
  const errors = []
  if (!isObject(value)) throw new WorkerObserverServiceError([`worker ${expectedKind} must be an object`], 400)
  if (value.kind !== expectedKind) errors.push(`worker kind at this position must be ${expectedKind}`)
  const pendingStatuses = normalizeStatuses(value.pendingStatuses, `${expectedKind}.pendingStatuses`, errors)
  const committedStatuses = normalizeStatuses(value.committedStatuses, `${expectedKind}.committedStatuses`, errors)
  const failedStatuses = normalizeStatuses(value.failedStatuses, `${expectedKind}.failedStatuses`, errors)
  const allStatuses = [...pendingStatuses, ...committedStatuses, ...failedStatuses]
  if (new Set(allStatuses).size !== allStatuses.length) errors.push(`${expectedKind} status sets must not overlap`)
  let normalStart = null
  if (NORMAL_WORKER_KINDS.includes(expectedKind)) {
    try { normalStart = normalizeAction(value.normalStart, `${expectedKind}.normalStart`) } catch (error) { errors.push(...errorList(error)) }
  } else if (value.normalStart !== undefined && value.normalStart !== null) {
    errors.push('forced-source-recovery must not define normalStart')
  }
  const actions = []
  if (!Array.isArray(value.actions)) {
    errors.push(`${expectedKind}.actions must be an array`)
  } else {
    for (let index = 0; index < value.actions.length; index += 1) {
      const entry = value.actions[index]
      if (!isObject(entry)) {
        errors.push(`${expectedKind}.actions[${index}] must be an object`)
        continue
      }
      try {
        const routePath = safeRelativePath(entry.path, `${expectedKind}.actions[${index}].path`)
        if (!routePath.startsWith('/actions/')) throw new Error(`${expectedKind}.actions[${index}].path must start with /actions/`)
        actions.push({ path: routePath, executor: normalizeAction(entry.executor, `${expectedKind}.actions[${index}].executor`) })
      } catch (error) {
        errors.push(...errorList(error))
      }
    }
  }
  if (errors.length > 0) throw new WorkerObserverServiceError(errors, 400)
  return { kind: expectedKind, pendingStatuses, committedStatuses, failedStatuses, normalStart, actions }
}

function normalizeStatuses(value, label, errors) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    errors.push(`${label} must be a non-empty array`)
    return []
  }
  const result = value.map(item => String(item))
  if (result.some(item => !/^[a-z][a-z0-9_-]{1,31}$/u.test(item)) || new Set(result).size !== result.length) {
    errors.push(`${label} contains an invalid or duplicate status`)
  }
  return result
}

function normalizeAction(value, label) {
  if (!isObject(value)) throw new WorkerObserverServiceError([`${label} must be an object`], 400)
  const type = String(value.type ?? '')
  if (type === 'admin-http') {
    const slot = String(value.slot ?? '')
    if (!['source', 'target'].includes(slot)) throw new WorkerObserverServiceError([`${label}.slot must be source or target`], 400)
    const actionPath = safeRelativePath(value.path, `${label}.path`)
    const method = String(value.method ?? 'POST').toUpperCase()
    if (method !== 'POST') throw new WorkerObserverServiceError([`${label}.method must be POST`], 400)
    const expectedStatuses = normalizeExpectedStatuses(value.expectedStatuses, `${label}.expectedStatuses`)
    const staticBody = value.staticBody === undefined ? {} : value.staticBody
    if (!isObject(staticBody) || JSON.stringify(staticBody).length > 8_192) {
      throw new WorkerObserverServiceError([`${label}.staticBody must be a small object`], 400)
    }
    const authorityErrors = []
    collectForbiddenAuthorityKeys(staticBody, `${label}.staticBody`, authorityErrors)
    if (authorityErrors.length > 0) throw new WorkerObserverServiceError(authorityErrors, 400)
    return { type, slot, path: actionPath, method, expectedStatuses, staticBody }
  }
  if (type === 'redis-xadd') {
    const streamKeyTemplate = requiredString(value.streamKeyTemplate, `${label}.streamKeyTemplate`)
    if (!streamKeyTemplate.includes('{rolloutId}') || !/^[0-9A-Za-z:._{}-]{8,300}$/u.test(streamKeyTemplate)) {
      throw new WorkerObserverServiceError([`${label}.streamKeyTemplate is invalid`], 400)
    }
    const eventType = requiredString(value.eventType, `${label}.eventType`)
    if (!/^[a-z][a-z0-9._-]{2,63}$/u.test(eventType)) throw new WorkerObserverServiceError([`${label}.eventType is invalid`], 400)
    return { type, streamKeyTemplate, eventType }
  }
  throw new WorkerObserverServiceError([`${label}.type must be admin-http or redis-xadd`], 400)
}

function normalizeExpectedStatuses(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
    throw new WorkerObserverServiceError([`${label} must be a non-empty array`], 400)
  }
  const result = value.map(status => Number(status))
  if (result.some(status => !Number.isSafeInteger(status) || status < 200 || status > 299)) {
    throw new WorkerObserverServiceError([`${label} must contain only 2xx status codes`], 400)
  }
  return unique(result)
}

export function deriveWorkerObservation(input) {
  const errors = []
  const waiting = []
  const phase = String(input.phase ?? '')
  if (!['pending', 'final'].includes(phase)) throw new WorkerObserverServiceError(['observation phase must be pending or final'], 400)
  if (!WORKER_KINDS.includes(input.kind)) throw new WorkerObserverServiceError(['worker kind is invalid'], 400)
  validateRolloutState(input.rollout)
  const worker = input.worker
  if (!worker || worker.kind !== input.kind) throw new WorkerObserverServiceError(['matching normalized worker definition is required'], 400)
  const rows = Array.isArray(input.rows) ? input.rows.map((row, index) => normalizeRecord(row, index, errors)) : []
  const validRows = rows.filter(Boolean)
  const requestedLogicalEventId = input.logicalEventId === undefined || input.logicalEventId === null
    ? null
    : String(input.logicalEventId)
  const logicalIds = unique(validRows.map(row => row.logicalEventId))
  if (requestedLogicalEventId && !SAFE_ID.test(requestedLogicalEventId)) errors.push('logicalEventId is invalid')
  if (logicalIds.length > 1) errors.push('observation returned more than one logical event')
  const logicalEventId = requestedLogicalEventId ?? logicalIds[0] ?? null
  if (logicalEventId && logicalIds.some(value => value !== logicalEventId)) errors.push('observation rows do not match requested logicalEventId')
  for (const row of validRows) {
    if (row.rolloutId !== input.rollout.rolloutId) errors.push(`attempt ${row.attemptKey} has a foreign rolloutId`)
    if (row.kind !== input.kind) errors.push(`attempt ${row.attemptKey} has a foreign worker kind`)
  }
  const scopedRows = validRows.filter(row => row.rolloutId === input.rollout.rolloutId
    && row.kind === input.kind
    && (!logicalEventId || row.logicalEventId === logicalEventId))
  if (scopedRows.length === 0) waiting.push('no real worker attempt records observed')
  const observedAtUtc = timestampOrNow(input.now)
  const binding = rolloutBinding(input.rollout)
  const common = {
    schema: WORKER_OBSERVER_RESPONSE_SCHEMA,
    phase,
    logicalEventId,
    kind: input.kind,
    rolloutId: input.rollout.rolloutId,
    source: binding.source,
    target: binding.target,
    observedAtUtc,
    observationSource: 'postgres'
  }

  if (phase === 'pending') {
    const pendingRows = scopedRows.filter(row => worker.pendingStatuses.includes(row.status))
    const sourceRows = pendingRows.filter(row => matchesIdentity(row, binding.source))
    const foreignPendingRows = pendingRows.filter(row => !matchesIdentity(row, binding.source))
    const pendingCountAtDrain = unique(pendingRows.map(row => row.attemptKey)).length
    if (pendingCountAtDrain < 1) waiting.push('no durable pending attempt observed')
    if (sourceRows.length < 1 && pendingRows.length > 0) errors.push('pending attempts are not attributed to the rollout source release/generation')
    if (foreignPendingRows.length > 0) errors.push('pending set includes a non-source release/generation')
    const replaySources = unique(sourceRows.map(row => row.durableReplaySource).filter(Boolean))
    if (replaySources.length !== 1 || !DURABLE_REPLAY_SOURCES.has(replaySources[0])) {
      if (sourceRows.length > 0) errors.push('pending attempts do not expose one valid durable replay source')
    }
    const sourceOwnerCount = maximumActual(sourceRows, 'ownerCount')
    const consumerCount = maximumActual(pendingRows, 'consumerCount')
    const sourceClaimObserved = sourceRows.some(row => row.sourceClaimObserved === true)
    const sourceFinalCommitObserved = sourceRows.some(row => row.sourceFinalCommitObserved === true
      || worker.committedStatuses.includes(row.status))
    if (input.kind === 'active-singleton-control' && sourceOwnerCount !== 1) {
      errors.push('active singleton pending evidence must report exactly one source owner')
    }
    if (input.kind === 'multi-consumer-safe-control' && !(consumerCount >= 2)) {
      errors.push('multi-consumer pending evidence must report at least two consumers')
    }
    if (input.kind === 'forced-source-recovery') {
      if (!sourceClaimObserved) waiting.push('source claim has not been observed')
      if (sourceFinalCommitObserved) errors.push('source final commit was observed before forced recovery')
    }
    const values = {
      logicalEventId,
      pendingCountAtDrain,
      durableReplaySource: replaySources.length === 1 ? replaySources[0] : null,
      sourceReleaseId: binding.source.releaseId,
      sourceGeneration: binding.source.generation
    }
    const result = {
      ...common,
      ...values,
      ...(input.kind === 'active-singleton-control' ? { sourceOwnerCount } : {}),
      ...(input.kind === 'multi-consumer-safe-control' ? { consumerCount } : {}),
      ...(input.kind === 'forced-source-recovery' ? { sourceClaimObserved, sourceFinalCommitObserved } : {}),
      ready: errors.length === 0 && waiting.length === 0,
      fatal: errors.length > 0,
      waiting: unique(waiting),
      errors: unique(errors),
      observationBindings: makeBindings(values, observedAtUtc, 'postgres-worker-attempt-view')
    }
    return result
  }

  const committedRows = scopedRows.filter(row => worker.committedStatuses.includes(row.status))
  const failedRows = scopedRows.filter(row => worker.failedStatuses.includes(row.status))
  const attemptCount = unique(scopedRows.map(row => row.attemptKey)).length
  const effectKeys = unique(committedRows.map(row => row.effectKey).filter(value => typeof value === 'string' && value.length > 0))
  const finalEffectCount = effectKeys.length
  const finalEffectKey = finalEffectCount === 1 ? effectKeys[0] : null
  const staleRows = committedRows.filter(row => !matchesIdentity(row, binding.target))
  const targetRows = committedRows.filter(row => matchesIdentity(row, binding.target))
  const committedIdentities = unique(committedRows.map(row => `${row.releaseId}\u0000${row.generation}`))
  const finalReleaseId = committedIdentities.length === 1 ? committedRows[0]?.releaseId ?? null : null
  const finalGeneration = committedIdentities.length === 1 ? committedRows[0]?.generation ?? null : null
  const staleGenerationCommitCount = unique(staleRows.map(row => row.attemptKey)).length
  if (attemptCount < 1) waiting.push('no real worker attempt observed')
  if (committedRows.length < 1) waiting.push('no committed worker effect observed')
  if (finalEffectCount === 0 && committedRows.length > 0) errors.push('committed attempts have no durable effect key')
  if (finalEffectCount > 1) errors.push('more than one durable final effect was observed')
  if (staleGenerationCommitCount > 0) errors.push('a stale release/generation committed an effect')
  if (committedRows.length > 0 && targetRows.length !== committedRows.length) errors.push('final commits are not exclusively attributed to target')
  if (committedIdentities.length > 1) errors.push('final commits contain multiple release/generation identities')
  if (failedRows.length > 0) errors.push('worker attempt view contains terminal failed attempts')

  const sourceAttemptCount = unique(scopedRows.filter(row => matchesIdentity(row, binding.source)).map(row => row.attemptKey)).length
  const targetAttemptCount = unique(scopedRows.filter(row => matchesIdentity(row, binding.target)).map(row => row.attemptKey)).length
  const workerIdentities = unique(scopedRows.map(row => row.workerIdentity).filter(Boolean)).sort()
  const workerIdentity = workerIdentities.length > 0 ? workerIdentities.join(',') : null
  const maximumConcurrentOwnerCount = maximumActual(scopedRows, 'ownerCount')
  const recoveredByTarget = targetRows.some(row => row.recoveredByTarget === true)
  const persistedExpectedEffectCount = maximumActual(scopedRows, 'expectedEffectCount')
  const receiptCount = Number.isSafeInteger(input.actionReceiptCount) && input.actionReceiptCount >= 0
    ? input.actionReceiptCount
    : 0
  if (persistedExpectedEffectCount !== null && receiptCount > 0 && persistedExpectedEffectCount !== receiptCount) {
    errors.push('persisted expected effect count disagrees with accepted action receipts')
  }
  const expectedEffectCount = persistedExpectedEffectCount ?? (receiptCount > 0 ? receiptCount : null)
  const actualAuditCount = maximumActual(scopedRows, 'auditCount')
  const actualProjectionCount = maximumActual(scopedRows, 'projectionCount')
  if (input.kind === 'audit-writer') {
    if (!(expectedEffectCount >= 1)) waiting.push('no persisted or accepted audit trigger count exists')
    if (actualAuditCount === null) waiting.push('audit effect count has not been observed')
    if (expectedEffectCount !== null && actualAuditCount !== null && actualAuditCount !== expectedEffectCount) {
      errors.push('audit effect count does not reconcile with real trigger evidence')
    }
  }
  if (input.kind === 'visit-view-projection') {
    if (!(expectedEffectCount >= 1)) waiting.push('no persisted projection expectation exists')
    if (actualProjectionCount === null) waiting.push('projection effect count has not been observed')
    if (expectedEffectCount !== null && actualProjectionCount !== null && actualProjectionCount !== expectedEffectCount) {
      errors.push('projection effect count does not reconcile with real trigger evidence')
    }
  }
  if (input.kind === 'active-singleton-control' && !(maximumConcurrentOwnerCount !== null && maximumConcurrentOwnerCount <= 1)) {
    errors.push('active singleton evidence does not prove maximum concurrent ownership <= 1')
  }
  if (input.kind === 'forced-source-recovery' && !recoveredByTarget) waiting.push('target recovery has not been observed')

  const values = {
    attemptCount,
    finalEffectCount,
    finalEffectKey,
    finalReleaseId,
    finalGeneration,
    staleGenerationCommitCount
  }
  const result = {
    ...common,
    ...values,
    sourceAttemptCount,
    targetAttemptCount,
    workerIdentity,
    ...(input.kind === 'audit-writer'
      ? { expectedAuditCount: expectedEffectCount, actualAuditCount }
      : {}),
    ...(input.kind === 'visit-view-projection'
      ? { expectedProjectionCount: expectedEffectCount, actualProjectionCount }
      : {}),
    ...(input.kind === 'active-singleton-control' ? { maximumConcurrentOwnerCount } : {}),
    ...(input.kind === 'forced-source-recovery' ? { recoveredByTarget } : {}),
    ready: errors.length === 0 && waiting.length === 0 && finalEffectCount === 1
      && finalReleaseId === binding.target.releaseId && finalGeneration === binding.target.generation,
    fatal: errors.length > 0,
    waiting: unique(waiting),
    errors: unique(errors),
    observationBindings: makeBindings(values, observedAtUtc, 'postgres-worker-attempt-view')
  }
  if (input.kind === 'audit-writer') {
    Object.assign(result.observationBindings, makeBindings({
      expectedAuditCount: result.expectedAuditCount,
      actualAuditCount: result.actualAuditCount
    }, observedAtUtc, 'postgres-worker-effect-view'))
  }
  if (input.kind === 'visit-view-projection') {
    Object.assign(result.observationBindings, makeBindings({
      expectedProjectionCount: result.expectedProjectionCount,
      actualProjectionCount: result.actualProjectionCount
    }, observedAtUtc, 'postgres-worker-effect-view'))
  }
  return result
}

function normalizeRecord(value, index, errors) {
  if (!isObject(value)) {
    errors.push(`attempt record[${index}] must be an object`)
    return null
  }
  const row = {
    logicalEventId: String(value.logicalEventId ?? ''),
    rolloutId: String(value.rolloutId ?? ''),
    kind: String(value.kind ?? ''),
    attemptKey: String(value.attemptKey ?? ''),
    status: String(value.status ?? ''),
    releaseId: String(value.releaseId ?? ''),
    generation: Number(value.generation),
    effectKey: value.effectKey === null || value.effectKey === undefined ? null : String(value.effectKey),
    workerIdentity: value.workerIdentity === null || value.workerIdentity === undefined ? null : String(value.workerIdentity),
    durableReplaySource: value.durableReplaySource === null || value.durableReplaySource === undefined
      ? null
      : String(value.durableReplaySource)
  }
  for (const field of ['logicalEventId', 'rolloutId', 'attemptKey']) {
    if (!SAFE_ID.test(row[field])) errors.push(`attempt record[${index}].${field} is invalid`)
  }
  if (!WORKER_KINDS.includes(row.kind)) errors.push(`attempt record[${index}].kind is invalid`)
  if (!/^[a-z][a-z0-9_-]{1,31}$/u.test(row.status)) errors.push(`attempt record[${index}].status is invalid`)
  if (!SAFE_ID.test(row.releaseId)) errors.push(`attempt record[${index}].releaseId is invalid`)
  if (!Number.isSafeInteger(row.generation) || row.generation < 1) errors.push(`attempt record[${index}].generation is invalid`)
  if (row.effectKey !== null && !SAFE_ID.test(row.effectKey)) errors.push(`attempt record[${index}].effectKey is invalid`)
  if (row.workerIdentity !== null && !SAFE_ID.test(row.workerIdentity)) errors.push(`attempt record[${index}].workerIdentity is invalid`)
  if (row.durableReplaySource !== null && !DURABLE_REPLAY_SOURCES.has(row.durableReplaySource)) {
    errors.push(`attempt record[${index}].durableReplaySource is invalid`)
  }
  for (const field of ['articleId', 'expectedEffectCount', 'auditCount', 'projectionCount', 'ownerCount', 'consumerCount']) {
    if (value[field] === undefined || value[field] === null) row[field] = null
    else {
      row[field] = Number(value[field])
      if (!Number.isSafeInteger(row[field]) || row[field] < 0) errors.push(`attempt record[${index}].${field} is invalid`)
    }
  }
  for (const field of ['sourceClaimObserved', 'sourceFinalCommitObserved', 'recoveredByTarget']) {
    if (value[field] === undefined || value[field] === null) row[field] = null
    else {
      row[field] = value[field]
      if (typeof row[field] !== 'boolean') errors.push(`attempt record[${index}].${field} is invalid`)
    }
  }
  row.observedAtUtc = value.observedAtUtc === undefined || value.observedAtUtc === null ? null : String(value.observedAtUtc)
  if (row.observedAtUtc !== null && (!ISO_UTC.test(row.observedAtUtc) || !Number.isFinite(Date.parse(row.observedAtUtc)))) {
    errors.push(`attempt record[${index}].observedAtUtc is invalid`)
  }
  return row
}

export function createWorkerObserverApplication(config, dependencies = {}) {
  const plan = config.plan?.routes instanceof Map
    ? config.plan
    : normalizeWorkerObserverServicePlan(config.plan)
  const adminHeader = config.adminHeader
  if (!isObject(adminHeader) || !SAFE_HEADER_NAME.test(String(adminHeader.name ?? ''))
    || typeof adminHeader.value !== 'string' || adminHeader.value.length < 1) {
    throw new WorkerObserverServiceError(['a parsed private admin header is required'], 500)
  }
  const deps = {
    now: () => new Date(),
    readRollout: () => readRolloutState(config.rolloutStatePath),
    recordProvider: dependencies.recordProvider,
    infrastructureReader: dependencies.infrastructureReader,
    actionExecutor: dependencies.actionExecutor,
    journals: dependencies.journals ?? createFileJournalStore(config.stateDir),
    ...dependencies
  }
  for (const name of ['recordProvider', 'infrastructureReader', 'actionExecutor']) {
    if (!deps[name] || typeof deps[name] !== 'object') {
      throw new WorkerObserverServiceError([`${name} dependency is required`], 500)
    }
  }
  if (typeof deps.recordProvider.query !== 'function') throw new WorkerObserverServiceError(['recordProvider.query is required'], 500)
  if (typeof deps.infrastructureReader.verify !== 'function') throw new WorkerObserverServiceError(['infrastructureReader.verify is required'], 500)
  if (typeof deps.actionExecutor.execute !== 'function') throw new WorkerObserverServiceError(['actionExecutor.execute is required'], 500)
  const runLocks = new Map()

  async function dispatch(request) {
    let rollout = null
    let requestedRolloutId = null
    try {
      assertLoopbackRemote(request.remoteAddress)
      assertIncomingAuthorization(request.headers, adminHeader)
      const url = new URL(String(request.url ?? '/'), `http://${plan.listen.host}:${plan.listen.port}`)
      const method = String(request.method ?? 'GET').toUpperCase()
      const body = request.body === undefined || request.body === null ? {} : request.body
      if (!isObject(body)) throw new WorkerObserverServiceError(['request body must be a JSON object'], 400)
      if (JSON.stringify(body).length > 65_536) throw new WorkerObserverServiceError(['request body exceeds 64 KiB'], 413)
      requestedRolloutId = String(body.rolloutId ?? url.searchParams.get('rolloutId') ?? '') || null
      rollout = deps.readRollout()
      validateRolloutState(rollout)
      if (requestedRolloutId !== null && requestedRolloutId !== rollout.rolloutId) {
        throw new WorkerObserverServiceError(['request rolloutId does not match the current rollout state'], 409)
      }

      if (method === 'POST' && plan.routes.has(url.pathname)) {
        return await handleAction(url.pathname, body, rollout)
      }
      const observationMatch = /^\/observations\/([a-z0-9-]+)\/(pending|final)$/u.exec(url.pathname)
      if (method === 'GET' && observationMatch) {
        return await handleObservation(observationMatch[1], observationMatch[2], url, rollout)
      }
      if (method === 'POST' && url.pathname === NORMAL_START_PATH) {
        return await withRunLock(String(body.runId ?? ''), () => handleNormalStart(body, rollout))
      }
      if (method === 'GET' && url.pathname === NORMAL_STATUS_PATH) {
        const runId = String(url.searchParams.get('runId') ?? '')
        return await withRunLock(runId, () => handleNormalStatus(runId, rollout))
      }
      if (method === 'POST' && url.pathname === NORMAL_FINALIZE_PATH) {
        return await withRunLock(String(body.runId ?? ''), () => handleNormalFinalize(body, rollout))
      }
      return response(404, serviceEnvelope(rollout, {
        status: 'fail',
        errors: ['route not found']
      }))
    } catch (error) {
      const normalized = normalizeError(error)
      return response(normalized.statusCode, serviceEnvelope(rollout, {
        status: 'fail',
        rolloutId: rollout?.rolloutId ?? requestedRolloutId,
        errors: normalized.errors
      }))
    }
  }

  async function handleAction(routePath, body, rollout) {
    assertActionRequest(body, rollout)
    const route = plan.routes.get(routePath)
    const forbidden = []
    collectForbiddenAuthorityKeys(body, 'request', forbidden)
    if (forbidden.length > 0) throw new WorkerObserverServiceError(forbidden, 400)
    const infrastructure = await deps.infrastructureReader.verify({
      phase: 'action',
      kind: route.kind,
      slot: route.executor.slot ?? null,
      rollout
    })
    assertInfrastructureResult(infrastructure)
    const receipt = await deps.actionExecutor.execute(route.executor, {
      kind: route.kind,
      routePath,
      body,
      rollout,
      observedAtUtc: timestampOrNow(deps.now)
    })
    assertActionReceipt(receipt, body, rollout)
    const storedReceipt = {
      routePath,
      kind: route.kind,
      logicalEventId: body.logicalEventId,
      rolloutId: rollout.rolloutId,
      receiptId: receipt.receiptId,
      observedAtUtc: receipt.observedAtUtc ?? timestampOrNow(deps.now),
      backend: receipt.backend
    }
    deps.journals.appendEventReceipt(route.kind, body.logicalEventId, storedReceipt)
    return response(202, serviceEnvelope(rollout, {
      status: 'accepted',
      kind: route.kind,
      logicalEventId: body.logicalEventId,
      actionReceiptId: storedReceipt.receiptId,
      acceptedAtUtc: storedReceipt.observedAtUtc,
      errors: []
    }))
  }

  async function handleObservation(kind, phase, url, rollout) {
    if (!WORKER_KINDS.includes(kind)) throw new WorkerObserverServiceError(['unknown worker observation kind'], 404)
    const worker = plan.workers.find(item => item.kind === kind)
    const logicalEventId = url.searchParams.get('logicalEventId')
    const articleIdValue = url.searchParams.get('articleId')
    let articleId = null
    if (articleIdValue !== null) {
      articleId = Number(articleIdValue)
      if (!Number.isSafeInteger(articleId) || articleId < 1) throw new WorkerObserverServiceError(['articleId must be a positive integer'], 400)
    }
    if (!logicalEventId && !(kind === 'scheduled-publish' && phase === 'pending' && articleId !== null)) {
      throw new WorkerObserverServiceError(['logicalEventId is required for this observation'], 400)
    }
    if (logicalEventId && !SAFE_ID.test(logicalEventId)) throw new WorkerObserverServiceError(['logicalEventId is invalid'], 400)
    const result = await observeOne({ kind, phase, logicalEventId, articleId, worker, rollout })
    return response(200, result)
  }

  async function observeOne(input) {
    const rows = await deps.recordProvider.query({
      kind: input.kind,
      rolloutId: input.rollout.rolloutId,
      logicalEventId: input.logicalEventId,
      articleId: input.articleId
    })
    const discoveredLogicalEventId = input.logicalEventId
      ?? unique((Array.isArray(rows) ? rows : []).map(row => String(row?.logicalEventId ?? '')).filter(Boolean))[0]
      ?? null
    const eventJournal = discoveredLogicalEventId
      ? deps.journals.getEvent(input.kind, discoveredLogicalEventId)
      : null
    const observation = deriveWorkerObservation({
      phase: input.phase,
      kind: input.kind,
      worker: input.worker,
      rollout: input.rollout,
      rows,
      logicalEventId: discoveredLogicalEventId,
      actionReceiptCount: Array.isArray(eventJournal?.receipts) ? eventJournal.receipts.length : 0,
      now: deps.now
    })
    let infrastructure
    try {
      infrastructure = await deps.infrastructureReader.verify({
        phase: input.phase,
        kind: input.kind,
        rollout: input.rollout
      })
      assertInfrastructureResult(infrastructure)
    } catch (error) {
      const infrastructureErrors = errorList(error).map(value => `infrastructure: ${value}`)
      observation.ready = false
      observation.fatal = true
      observation.errors = unique([...observation.errors, ...infrastructureErrors])
      infrastructure = { ok: false, errors: infrastructureErrors }
    }
    observation.infrastructure = sanitizeInfrastructureEvidence(infrastructure)
    return observation
  }

  async function handleNormalStart(body, rollout) {
    assertNormalCommand(body, rollout, 'start-normal-worker-observation')
    const runId = String(body.runId ?? '')
    const existing = deps.journals.getRun(runId)
    if (existing) {
      assertRunBinding(existing, rollout)
      return evaluateNormalRun(existing, rollout)
    }
    const infrastructure = await deps.infrastructureReader.verify({ phase: 'pending', kind: 'normal-run', rollout })
    assertInfrastructureResult(infrastructure)
    const run = {
      schema: 'fsusblog.release-worker-observer-run.v1',
      runId,
      rolloutId: rollout.rolloutId,
      source: rolloutBinding(rollout).source,
      target: rolloutBinding(rollout).target,
      phase: 'arming',
      destructive: false,
      createdAtUtc: timestampOrNow(deps.now),
      updatedAtUtc: timestampOrNow(deps.now),
      drain: null,
      events: NORMAL_WORKER_KINDS.map(kind => ({
        kind,
        logicalEventId: normalLogicalEventId(runId, kind),
        receipts: []
      })),
      errors: []
    }
    deps.journals.putRun(run)
    try {
      const receipts = await Promise.all(run.events.map(async event => {
        const worker = plan.workers.find(item => item.kind === event.kind)
        const actionBody = {
          schema: NORMAL_WORKER_COMMAND_SCHEMA,
          action: 'start-normal-worker-event',
          runId,
          rolloutId: rollout.rolloutId,
          logicalEventId: event.logicalEventId,
          kind: event.kind,
          destructive: false,
          source: rolloutBinding(rollout).source,
          target: rolloutBinding(rollout).target
        }
        const receipt = await deps.actionExecutor.execute(worker.normalStart, {
          kind: event.kind,
          routePath: NORMAL_START_PATH,
          body: actionBody,
          rollout,
          observedAtUtc: timestampOrNow(deps.now)
        })
        assertActionReceipt(receipt, actionBody, rollout)
        return { event, receipt }
      }))
      for (const entry of receipts) {
        const storedReceipt = {
          routePath: NORMAL_START_PATH,
          kind: entry.event.kind,
          logicalEventId: entry.event.logicalEventId,
          rolloutId: rollout.rolloutId,
          receiptId: entry.receipt.receiptId,
          observedAtUtc: entry.receipt.observedAtUtc ?? timestampOrNow(deps.now),
          backend: entry.receipt.backend
        }
        entry.event.receipts.push(storedReceipt)
        deps.journals.appendEventReceipt(entry.event.kind, entry.event.logicalEventId, storedReceipt)
      }
      run.updatedAtUtc = timestampOrNow(deps.now)
      deps.journals.putRun(run)
      return evaluateNormalRun(run, rollout)
    } catch (error) {
      run.phase = 'fail'
      run.errors = errorList(error)
      run.updatedAtUtc = timestampOrNow(deps.now)
      deps.journals.putRun(run)
      return response(500, normalEnvelope(run, rollout, 'fail', [], run.errors, deps.now))
    }
  }

  async function handleNormalStatus(runId, rollout) {
    if (!SAFE_ID.test(runId)) throw new WorkerObserverServiceError(['runId is invalid'], 400)
    const run = deps.journals.getRun(runId)
    if (!run) throw new WorkerObserverServiceError(['normal observer run was not found'], 404)
    assertRunBinding(run, rollout)
    return evaluateNormalRun(run, rollout)
  }

  async function handleNormalFinalize(body, rollout) {
    assertNormalCommand(body, rollout, 'finalize-after-graceful-drain')
    const run = deps.journals.getRun(String(body.runId ?? ''))
    if (!run) throw new WorkerObserverServiceError(['normal observer run was not found'], 404)
    assertRunBinding(run, rollout)
    if (!['armed', 'finalizing', 'pass'].includes(run.phase)) {
      throw new WorkerObserverServiceError([`normal observer cannot finalize from phase ${run.phase}`], 409)
    }
    const drain = verifyDrainEvidence(body.sourceDrain)
    if (run.drain && run.drain.sha256 !== drain.sha256) {
      throw new WorkerObserverServiceError(['source drain evidence changed after finalize'], 409)
    }
    run.drain = drain
    if (run.phase !== 'pass') run.phase = 'finalizing'
    run.updatedAtUtc = timestampOrNow(deps.now)
    deps.journals.putRun(run)
    return evaluateNormalRun(run, rollout)
  }

  async function evaluateNormalRun(run, rollout) {
    if (run.phase === 'fail') return response(500, normalEnvelope(run, rollout, 'fail', [], run.errors, deps.now))
    if (run.phase === 'pass') {
      const events = await observeNormalEvents(run, rollout, 'final')
      if (events.some(event => !event.ready)) {
        run.phase = events.some(event => event.fatal) ? 'fail' : 'finalizing'
      }
      if (run.phase === 'pass') return response(200, normalEnvelope(run, rollout, 'pass', events, [], deps.now))
    }
    const phase = run.phase === 'finalizing' ? 'final' : 'pending'
    const events = await observeNormalEvents(run, rollout, phase)
    const fatalErrors = events.flatMap(event => event.fatal ? event.errors.map(error => `${event.kind}: ${error}`) : [])
    if (fatalErrors.length > 0) {
      run.phase = 'fail'
      run.errors = unique(fatalErrors)
    } else if (events.every(event => event.ready)) {
      run.phase = phase === 'pending' ? 'armed' : 'pass'
    } else if (phase === 'pending') {
      run.phase = 'arming'
    }
    run.updatedAtUtc = timestampOrNow(deps.now)
    deps.journals.putRun(run)
    const status = run.phase === 'arming' ? 'accepted'
      : run.phase === 'armed' ? 'armed'
        : run.phase === 'finalizing' ? 'running'
          : run.phase
    const statusCode = status === 'fail' ? 500 : 200
    return response(statusCode, normalEnvelope(run, rollout, status, events, run.errors, deps.now))
  }

  async function observeNormalEvents(run, rollout, phase) {
    return Promise.all(run.events.map(event => observeOne({
      kind: event.kind,
      phase,
      logicalEventId: event.logicalEventId,
      articleId: null,
      worker: plan.workers.find(item => item.kind === event.kind),
      rollout
    })))
  }

  async function withRunLock(runId, operation) {
    if (!SAFE_ID.test(runId)) throw new WorkerObserverServiceError(['runId is invalid'], 400)
    const previous = runLocks.get(runId) ?? Promise.resolve()
    let release
    const current = new Promise(resolve => { release = resolve })
    const queued = previous.then(() => current)
    runLocks.set(runId, queued)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (runLocks.get(runId) === queued) runLocks.delete(runId)
    }
  }

  return { dispatch }
}

function assertActionRequest(body, rollout) {
  const logicalEventId = String(body.logicalEventId ?? '')
  if (!SAFE_ID.test(logicalEventId)) throw new WorkerObserverServiceError(['logicalEventId is required and invalid'], 400)
  if (body.rolloutId !== rollout.rolloutId) throw new WorkerObserverServiceError(['rolloutId does not match current rollout'], 409)
  assertOptionalIdentityBinding(body, rollout)
}

function assertNormalCommand(body, rollout, expectedAction) {
  const errors = []
  if (body.schema !== NORMAL_WORKER_COMMAND_SCHEMA) errors.push(`command schema must be ${NORMAL_WORKER_COMMAND_SCHEMA}`)
  if (!SAFE_ID.test(String(body.runId ?? ''))) errors.push('runId is invalid')
  if (body.rolloutId !== rollout.rolloutId) errors.push('rolloutId does not match current rollout')
  if (body.action !== expectedAction) errors.push(`action must be ${expectedAction}`)
  if (body.destructive !== false) errors.push('normal observation command must be explicitly non-destructive')
  if (expectedAction === 'start-normal-worker-observation'
    && (!Array.isArray(body.requiredKinds) || body.requiredKinds.join('\n') !== NORMAL_WORKER_KINDS.join('\n'))) {
    errors.push('requiredKinds must be the exact ordered normal worker set')
  }
  try { assertOptionalIdentityBinding(body, rollout, true) } catch (error) { errors.push(...errorList(error)) }
  if (errors.length > 0) throw new WorkerObserverServiceError(errors, 400)
}

function assertOptionalIdentityBinding(body, rollout, required = false) {
  const expected = rolloutBinding(rollout)
  for (const side of ['source', 'target']) {
    if (body[side] === undefined && !required) continue
    if (!identityMatches(body[side], expected[side])) {
      throw new WorkerObserverServiceError([`${side} identity does not match the current rollout`], 409)
    }
  }
}

function assertRunBinding(run, rollout) {
  const binding = rolloutBinding(rollout)
  if (run.rolloutId !== rollout.rolloutId
    || !identityMatches(run.source, binding.source)
    || !identityMatches(run.target, binding.target)) {
    throw new WorkerObserverServiceError(['persisted run identity no longer matches rollout state'], 409)
  }
}

function assertActionReceipt(receipt, body, rollout) {
  const errors = []
  if (!isObject(receipt) || receipt.accepted !== true) errors.push('real action executor did not return an accepted receipt')
  if (!SAFE_ID.test(String(receipt?.receiptId ?? ''))) errors.push('real action receipt id is invalid')
  if (receipt?.logicalEventId !== body.logicalEventId) errors.push('real action receipt logicalEventId mismatch')
  if (receipt?.rolloutId !== rollout.rolloutId) errors.push('real action receipt rolloutId mismatch')
  if (errors.length > 0) throw new WorkerObserverServiceError(errors, 502)
}

function assertInfrastructureResult(value) {
  if (!isObject(value) || value.ok !== true) {
    throw new WorkerObserverServiceError([
      'real topology readback did not pass',
      ...(Array.isArray(value?.errors) ? value.errors : [])
    ], 503)
  }
}

function sanitizeInfrastructureEvidence(value) {
  if (!isObject(value)) return { ok: false, checks: [] }
  return {
    ok: value.ok === true,
    checks: Array.isArray(value.checks) ? value.checks.map(check => ({
      type: String(check.type ?? ''),
      slot: check.slot === undefined ? null : String(check.slot),
      ok: check.ok === true,
      observedAtUtc: String(check.observedAtUtc ?? '')
    })) : []
  }
}

function normalEnvelope(run, rollout, status, events, errors, now) {
  return {
    schema: NORMAL_WORKER_OBSERVER_SCHEMA,
    status,
    runId: run.runId,
    rolloutId: rollout.rolloutId,
    destructive: false,
    source: rolloutBinding(rollout).source,
    target: rolloutBinding(rollout).target,
    observedAtUtc: timestampOrNow(now),
    events,
    errors: unique(errors ?? [])
  }
}

function serviceEnvelope(rollout, value) {
  const binding = rollout ? rolloutBinding(rollout) : { source: null, target: null }
  return {
    schema: WORKER_OBSERVER_RESPONSE_SCHEMA,
    status: value.status,
    rolloutId: value.rolloutId ?? rollout?.rolloutId ?? null,
    source: binding.source,
    target: binding.target,
    observedAtUtc: new Date().toISOString(),
    ...value
  }
}

function response(statusCode, body) {
  return { statusCode, headers: { 'content-type': 'application/json; charset=utf-8' }, body }
}

function normalLogicalEventId(runId, kind) {
  const digest = crypto.createHash('sha256').update(`${runId}\u0000${kind}`).digest('hex').slice(0, 24)
  return `normal-${kind}-${digest}`
}

function verifyDrainEvidence(value) {
  if (!isObject(value)) throw new WorkerObserverServiceError(['sourceDrain metadata is required'], 400)
  const file = path.resolve(requiredString(value.path, 'sourceDrain.path'))
  const metadata = privateRegularFileMetadata(file, 'source drain evidence', false)
  const expectedBytes = Number(value.bytes)
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes !== metadata.bytes) {
    throw new WorkerObserverServiceError(['sourceDrain bytes do not match the real file'], 409)
  }
  if (String(value.sha256 ?? '') !== metadata.sha256) {
    throw new WorkerObserverServiceError(['sourceDrain sha256 does not match the real file'], 409)
  }
  let evidence
  try { evidence = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (error) {
    throw new WorkerObserverServiceError([`source drain evidence is not valid JSON: ${message(error)}`], 400)
  }
  const errors = []
  if (evidence.schema !== 'fsusblog.release-rollout-gate.v1' || evidence.gate !== 'source-drain') errors.push('source drain gate identity is invalid')
  if (evidence.status !== 'pass') errors.push('source drain gate did not pass')
  if (!Array.isArray(evidence.observations?.blockers) || evidence.observations.blockers.length !== 0) errors.push('source drain gate contains blockers')
  if (Array.isArray(evidence.errors) && evidence.errors.length > 0) errors.push(...evidence.errors.map(item => `source drain: ${String(item)}`))
  if (errors.length > 0) throw new WorkerObserverServiceError(errors, 409)
  return { path: file, bytes: metadata.bytes, sha256: metadata.sha256 }
}

export function createPostgresRecordProvider(plan, privateEnvironment, dependencies = {}) {
  const runExternal = dependencies.runExternal ?? spawnSync
  const observation = plan.observation
  return {
    query(selector) {
      if (!WORKER_KINDS.includes(selector.kind)) throw new WorkerObserverServiceError(['PostgreSQL selector kind is invalid'], 400)
      if (!SAFE_ID.test(String(selector.rolloutId ?? ''))) throw new WorkerObserverServiceError(['PostgreSQL selector rolloutId is invalid'], 400)
      if (selector.logicalEventId !== null && selector.logicalEventId !== undefined
        && !SAFE_ID.test(String(selector.logicalEventId))) {
        throw new WorkerObserverServiceError(['PostgreSQL selector logicalEventId is invalid'], 400)
      }
      if (selector.articleId !== null && selector.articleId !== undefined
        && (!Number.isSafeInteger(selector.articleId) || selector.articleId < 1)) {
        throw new WorkerObserverServiceError(['PostgreSQL selector articleId is invalid'], 400)
      }
      const sql = buildObservationQuery(observation, selector)
      const result = runExternal('psql', [
        '--no-psqlrc',
        '--set', 'ON_ERROR_STOP=1',
        '--quiet',
        '--tuples-only',
        '--no-align'
      ], {
        input: sql,
        encoding: 'utf8',
        shell: false,
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024,
        env: postgresProcessEnvironment(privateEnvironment)
      })
      assertExternalResult(result, 'psql observation query')
      const output = String(result.stdout ?? '').trim()
      let rows
      try { rows = JSON.parse(output) } catch (error) {
        throw new WorkerObserverServiceError([`psql observation view returned invalid JSON: ${message(error)}`], 502)
      }
      if (!Array.isArray(rows)) throw new WorkerObserverServiceError(['psql observation view must return a JSON array'], 502)
      if (rows.length > observation.maxRecords) throw new WorkerObserverServiceError(['psql observation view exceeded maxRecords'], 502)
      return rows
    }
  }
}

export function buildObservationQuery(observation, selector) {
  const columns = observation.columns
  const selections = Object.entries(columns).map(([canonical, column]) =>
    `${quoteIdentifier(column)} AS ${quoteResultAlias(canonical)}`)
  const predicates = [
    `${quoteIdentifier(columns.rolloutId)} = ${quoteSqlLiteral(selector.rolloutId)}`,
    `${quoteIdentifier(columns.kind)} = ${quoteSqlLiteral(selector.kind)}`
  ]
  if (selector.logicalEventId !== null && selector.logicalEventId !== undefined) {
    predicates.push(`${quoteIdentifier(columns.logicalEventId)} = ${quoteSqlLiteral(selector.logicalEventId)}`)
  }
  if (selector.articleId !== null && selector.articleId !== undefined) {
    if (!columns.articleId) throw new WorkerObserverServiceError(['observation.columns.articleId is required for scheduled article discovery'], 500)
    predicates.push(`${quoteIdentifier(columns.articleId)} = ${Number(selector.articleId)}`)
  }
  const orderColumn = columns.observedAtUtc ?? columns.attemptKey
  return [
    "SELECT COALESCE(json_agg(row_to_json(observed)), '[]'::json)::text",
    'FROM (',
    `  SELECT ${selections.join(', ')}`,
    `  FROM ${quoteIdentifier(observation.schemaName)}.${quoteIdentifier(observation.table)}`,
    `  WHERE ${predicates.join(' AND ')}`,
    `  ORDER BY ${quoteIdentifier(orderColumn)} ASC, ${quoteIdentifier(columns.attemptKey)} ASC`,
    `  LIMIT ${observation.maxRecords}`,
    ') AS observed;',
    ''
  ].join('\n')
}

export function createRedisClient(privateEnvironment, dependencies = {}) {
  const runExternal = dependencies.runExternal ?? spawnSync
  const baseArguments = [
    '--raw',
    '--host', privateEnvironment.FSUSBLOG_WORKER_OBSERVER_REDIS_HOST,
    '--port', privateEnvironment.FSUSBLOG_WORKER_OBSERVER_REDIS_PORT,
    '--db', privateEnvironment.FSUSBLOG_WORKER_OBSERVER_REDIS_DATABASE
  ]
  const commandEnvironment = {
    ...minimalProcessEnvironment(),
    ...(privateEnvironment.FSUSBLOG_WORKER_OBSERVER_REDIS_PASSWORD
      ? { REDISCLI_AUTH: privateEnvironment.FSUSBLOG_WORKER_OBSERVER_REDIS_PASSWORD }
      : {})
  }
  function execute(argumentsList, label) {
    const result = runExternal('redis-cli', [...baseArguments, ...argumentsList], {
      encoding: 'utf8',
      shell: false,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      env: commandEnvironment
    })
    assertExternalResult(result, label)
    return String(result.stdout ?? '').trim()
  }
  return {
    getJson(key) {
      assertRedisKey(key)
      const output = execute(['GET', key], 'redis fence GET')
      if (!output) throw new WorkerObserverServiceError([`Redis key ${key} is missing`], 503)
      try {
        const value = JSON.parse(output)
        if (!isObject(value)) throw new Error('value is not an object')
        return value
      } catch (error) {
        throw new WorkerObserverServiceError([`Redis key ${key} is not valid JSON: ${message(error)}`], 502)
      }
    },
    xadd(key, fields) {
      assertRedisKey(key)
      const argumentsList = ['XADD', key, '*']
      for (const [name, value] of Object.entries(fields)) {
        if (!/^[a-z][a-zA-Z0-9._-]{1,63}$/u.test(name)) throw new WorkerObserverServiceError(['Redis stream field name is invalid'], 500)
        argumentsList.push(name, String(value))
      }
      const streamId = execute(argumentsList, 'redis worker action XADD')
      if (!/^\d+-\d+$/u.test(streamId)) throw new WorkerObserverServiceError(['Redis XADD did not return a stream id'], 502)
      return streamId
    }
  }
}

export function createAdminClient(plan, adminHeader, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch
  const now = dependencies.now ?? (() => new Date())
  if (typeof fetchImpl !== 'function') throw new WorkerObserverServiceError(['fetch is unavailable'], 500)
  async function request(slotName, requestPath, method = 'GET', body = null) {
    if (!['source', 'target'].includes(slotName)) throw new WorkerObserverServiceError(['admin client slot is invalid'], 500)
    const slot = plan.topology[slotName]
    const url = new URL(safeRelativePath(requestPath, 'admin request path'), `${slot.origin}/`)
    if (url.origin !== slot.origin) throw new WorkerObserverServiceError(['admin request escaped configured origin'], 500)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    try {
      const headers = {
        accept: 'application/json',
        [adminHeader.name]: adminHeader.value
      }
      const requestOptions = { method, headers, redirect: 'error', signal: controller.signal }
      if (body !== null) {
        headers['content-type'] = 'application/json'
        requestOptions.body = JSON.stringify(body)
      }
      const response = await fetchImpl(url, requestOptions)
      const text = await response.text()
      if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new WorkerObserverServiceError(['admin response exceeds 2 MiB'], 502)
      let value = {}
      if (text.trim()) {
        try { value = JSON.parse(text) } catch {
          throw new WorkerObserverServiceError([`admin endpoint returned non-JSON HTTP ${response.status}`], 502)
        }
      }
      return {
        status: response.status,
        ok: response.ok,
        body: value,
        rawBody: text,
        headers: response.headers,
        observedAtUtc: timestampOrNow(now)
      }
    } finally {
      clearTimeout(timer)
    }
  }
  return {
    request,
    async readStatus(slotName, rollout) {
      const response = await request(slotName, plan.topology.adminStatusPath)
      if (response.status !== 200) throw new WorkerObserverServiceError([`${slotName} admin status returned HTTP ${response.status}`], 503)
      const observed = extractObservedIdentity(response.body, response.headers)
      assertObservedIdentity(observed, rolloutBinding(rollout)[slotName], `${slotName} admin status`)
      return { ...observed, observedAtUtc: response.observedAtUtc }
    }
  }
}

export function createDockerClient(plan, dependencies = {}) {
  const runExternal = dependencies.runExternal ?? spawnSync
  return {
    inspect(slotName, rollout) {
      const configured = plan.topology[slotName]
      const result = runExternal('docker', ['inspect', configured.container.name], {
        encoding: 'utf8',
        shell: false,
        timeout: 15_000,
        maxBuffer: 2 * 1024 * 1024,
        env: minimalProcessEnvironment()
      })
      assertExternalResult(result, `${slotName} docker inspect`)
      let values
      try { values = JSON.parse(String(result.stdout ?? '')) } catch (error) {
        throw new WorkerObserverServiceError([`${slotName} docker inspect returned invalid JSON: ${message(error)}`], 502)
      }
      if (!Array.isArray(values) || values.length !== 1 || !isObject(values[0])) {
        throw new WorkerObserverServiceError([`${slotName} docker inspect must return exactly one container`], 502)
      }
      const container = values[0]
      const labels = container.Config?.Labels
      if (!isObject(labels)) throw new WorkerObserverServiceError([`${slotName} container identity labels are missing`], 503)
      const keys = configured.container.identityLabels
      const observed = {
        releaseId: String(labels[keys.releaseId] ?? ''),
        slot: String(labels[keys.slot] ?? ''),
        generation: Number(labels[keys.generation]),
        running: container.State?.Running === true
      }
      assertObservedIdentity(observed, rolloutBinding(rollout)[slotName], `${slotName} container labels`)
      return observed
    }
  }
}

export function createInfrastructureReader(plan, clients, dependencies = {}) {
  const now = dependencies.now ?? (() => new Date())
  return {
    async verify(input) {
      const errors = []
      const checks = []
      const phase = input.phase
      const slotNames = phase === 'action' && input.slot
        ? [input.slot]
        : phase === 'final'
          ? ['source', 'target']
          : ['source', 'target']
      const containerResults = await Promise.all(slotNames.map(async slotName => captureCheck(
        'docker-container',
        slotName,
        () => clients.docker.inspect(slotName, input.rollout),
        now)))
      checks.push(...containerResults.map(item => item.check))
      errors.push(...containerResults.flatMap(item => item.errors))
      for (const result of containerResults) {
        if (!result.value) continue
        const mustRun = phase === 'pending' || phase === 'action' || result.check.slot === 'target'
        const mustStop = phase === 'final' && input.kind === 'forced-source-recovery' && result.check.slot === 'source'
        if (mustRun && result.value.running !== true) errors.push(`${result.check.slot} container is not running`)
        if (mustStop && result.value.running !== false) errors.push('source container is still running during forced recovery final observation')
      }

      const adminSlots = phase === 'final' ? ['target'] : slotNames
      const adminResults = await Promise.all(adminSlots.map(slotName => captureCheck(
        'protected-admin-status',
        slotName,
        () => clients.admin.readStatus(slotName, input.rollout),
        now)))
      checks.push(...adminResults.map(item => item.check))
      errors.push(...adminResults.flatMap(item => item.errors))

      const fenceSlots = phase === 'final' ? ['target'] : slotNames
      for (const slotName of fenceSlots) {
        const result = await captureCheck('redis-generation-fence', slotName, () => {
          const key = renderTemplate(plan.topology.redisFenceKeyTemplate, {
            rolloutId: input.rollout.rolloutId,
            slot: input.rollout[slotName].slot
          })
          const observed = clients.redis.getJson(key)
          assertObservedIdentity(observed, rolloutBinding(input.rollout)[slotName], `${slotName} Redis fence`)
          return observed
        }, now)
        checks.push(result.check)
        errors.push(...result.errors)
      }
      return { ok: errors.length === 0, checks, errors: unique(errors) }
    }
  }
}

export function createActionExecutor(plan, clients, dependencies = {}) {
  const now = dependencies.now ?? (() => new Date())
  return {
    async execute(action, context) {
      const binding = rolloutBinding(context.rollout)
      if (action.type === 'admin-http') {
        await clients.admin.readStatus(action.slot, context.rollout)
        const requestBody = {
          ...action.staticBody,
          ...context.body,
          rolloutId: context.rollout.rolloutId,
          source: binding.source,
          target: binding.target,
          kind: context.kind
        }
        const response = await clients.admin.request(action.slot, action.path, action.method, requestBody)
        if (!action.expectedStatuses.includes(response.status)) {
          throw new WorkerObserverServiceError([`admin action ${action.path} returned HTTP ${response.status}`], 502)
        }
        if (!isObject(response.body)
          || response.body.logicalEventId !== context.body.logicalEventId
          || response.body.rolloutId !== context.rollout.rolloutId) {
          throw new WorkerObserverServiceError([`admin action ${action.path} did not echo the bound logicalEventId/rolloutId`], 502)
        }
        const responseReceipt = String(response.body.actionReceiptId ?? response.body.receiptId ?? '')
        const receiptId = SAFE_ID.test(responseReceipt)
          ? responseReceipt
          : `admin-receipt-${sha256(`${action.slot}\u0000${action.path}\u0000${response.status}\u0000${response.rawBody}`).slice(0, 32)}`
        return {
          accepted: true,
          receiptId,
          logicalEventId: context.body.logicalEventId,
          rolloutId: context.rollout.rolloutId,
          observedAtUtc: response.observedAtUtc,
          backend: 'protected-admin-http'
        }
      }
      if (action.type === 'redis-xadd') {
        const key = renderTemplate(action.streamKeyTemplate, { rolloutId: context.rollout.rolloutId })
        const streamId = clients.redis.xadd(key, {
          eventType: action.eventType,
          kind: context.kind,
          logicalEventId: context.body.logicalEventId,
          rolloutId: context.rollout.rolloutId,
          sourceReleaseId: binding.source.releaseId,
          sourceGeneration: binding.source.generation,
          targetReleaseId: binding.target.releaseId,
          targetGeneration: binding.target.generation
        })
        return {
          accepted: true,
          receiptId: `redis-receipt-${streamId.replace('-', ':')}`,
          logicalEventId: context.body.logicalEventId,
          rolloutId: context.rollout.rolloutId,
          observedAtUtc: timestampOrNow(now),
          backend: 'redis-stream'
        }
      }
      throw new WorkerObserverServiceError(['unknown action executor type'], 500)
    }
  }
}

export function createFileJournalStore(stateDirectory) {
  if (!stateDirectory) throw new WorkerObserverServiceError(['state directory is required'], 500)
  const directory = path.resolve(stateDirectory)
  return {
    getRun(runId) {
      return readOptionalJournal(journalPath(directory, 'run', runId))
    },
    putRun(run) {
      if (!isObject(run) || !SAFE_ID.test(String(run.runId ?? ''))) throw new WorkerObserverServiceError(['run journal is invalid'], 500)
      atomicWritePrivateJson(journalPath(directory, 'run', run.runId), run)
    },
    getEvent(kind, logicalEventId) {
      return readOptionalJournal(journalPath(directory, `event-${kind}`, logicalEventId))
    },
    appendEventReceipt(kind, logicalEventId, receipt) {
      if (!WORKER_KINDS.includes(kind) || !SAFE_ID.test(logicalEventId)) throw new WorkerObserverServiceError(['event journal identity is invalid'], 500)
      const file = journalPath(directory, `event-${kind}`, logicalEventId)
      const journal = readOptionalJournal(file) ?? {
        schema: 'fsusblog.release-worker-action-journal.v1',
        kind,
        logicalEventId,
        receipts: []
      }
      if (journal.kind !== kind || journal.logicalEventId !== logicalEventId || !Array.isArray(journal.receipts)) {
        throw new WorkerObserverServiceError(['event journal binding is invalid'], 500)
      }
      if (!journal.receipts.some(item => item.receiptId === receipt.receiptId)) journal.receipts.push(receipt)
      atomicWritePrivateJson(file, journal)
      return journal
    }
  }
}

async function captureCheck(type, slot, operation, now) {
  try {
    const value = await operation()
    return {
      value,
      check: { type, slot, ok: true, observedAtUtc: timestampOrNow(now) },
      errors: []
    }
  } catch (error) {
    return {
      value: null,
      check: { type, slot, ok: false, observedAtUtc: timestampOrNow(now) },
      errors: errorList(error).map(value => `${type}/${slot}: ${value}`)
    }
  }
}

function extractObservedIdentity(body, headers) {
  const candidates = [body, body?.data, body?.release, body?.runtime, body?.identity].filter(isObject)
  const fromBody = candidates.find(value => value.releaseId !== undefined
    && value.slot !== undefined
    && (value.generation !== undefined || value.runtimeGeneration !== undefined))
  const headerRelease = getFetchHeader(headers, 'x-fsus-release-id')
  const headerSlot = getFetchHeader(headers, 'x-fsus-release-slot')
  const headerGeneration = getFetchHeader(headers, 'x-fsus-runtime-generation')
    ?? getFetchHeader(headers, 'x-fsus-release-generation')
    ?? getFetchHeader(headers, 'x-fsus-generation')
  const observed = {
    releaseId: headerRelease ?? String(fromBody?.releaseId ?? ''),
    slot: headerSlot ?? String(fromBody?.slot ?? ''),
    generation: Number(headerGeneration ?? fromBody?.runtimeGeneration ?? fromBody?.generation)
  }
  if (fromBody) {
    if (headerRelease && headerRelease !== String(fromBody.releaseId)) throw new WorkerObserverServiceError(['admin release header/body mismatch'], 502)
    if (headerSlot && headerSlot !== String(fromBody.slot)) throw new WorkerObserverServiceError(['admin slot header/body mismatch'], 502)
    const bodyGeneration = Number(fromBody.runtimeGeneration ?? fromBody.generation)
    if (headerGeneration && Number(headerGeneration) !== bodyGeneration) throw new WorkerObserverServiceError(['admin generation header/body mismatch'], 502)
  }
  return observed
}

function assertObservedIdentity(observed, expected, label) {
  if (!isObject(observed)
    || observed.releaseId !== expected.releaseId
    || observed.slot !== expected.slot
    || Number(observed.generation) !== expected.generation) {
    throw new WorkerObserverServiceError([`${label} release/slot/generation does not match rollout state`], 409)
  }
}

export function readPrivateEnvironmentFile(file) {
  privateRegularFileMetadata(file, 'worker observer private environment', true)
  const result = {}
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/u)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line || /^\s*#/u.test(line)) continue
    const separator = line.indexOf('=')
    if (separator < 1) throw new WorkerObserverServiceError([`private environment line ${index + 1} is invalid`], 400)
    const name = line.slice(0, separator)
    const value = line.slice(separator + 1)
    if (!SAFE_ENV_NAME.test(name) || !PRIVATE_ENV_KEYS.has(name)) {
      throw new WorkerObserverServiceError([`private environment line ${index + 1} contains an unsupported key`], 400)
    }
    if (Object.hasOwn(result, name)) throw new WorkerObserverServiceError([`private environment key ${name} is duplicate`], 400)
    if (!value || /[\0\r\n]/u.test(value)) throw new WorkerObserverServiceError([`private environment key ${name} is empty or invalid`], 400)
    result[name] = value
  }
  const errors = REQUIRED_PRIVATE_ENV_KEYS.filter(name => !result[name]).map(name => `private environment is missing ${name}`)
  try { requiredLoopbackHost(result.FSUSBLOG_WORKER_OBSERVER_PGHOST, 'PostgreSQL host') } catch (error) { errors.push(message(error)) }
  try { boundedInteger(result.FSUSBLOG_WORKER_OBSERVER_PGPORT, 1, 65_535, 'PostgreSQL port') } catch (error) { errors.push(message(error)) }
  try { requiredLoopbackHost(result.FSUSBLOG_WORKER_OBSERVER_REDIS_HOST, 'Redis host') } catch (error) { errors.push(message(error)) }
  try { boundedInteger(result.FSUSBLOG_WORKER_OBSERVER_REDIS_PORT, 1, 65_535, 'Redis port') } catch (error) { errors.push(message(error)) }
  try { boundedInteger(result.FSUSBLOG_WORKER_OBSERVER_REDIS_DATABASE, 0, 255, 'Redis database') } catch (error) { errors.push(message(error)) }
  if (!/^[0-9A-Za-z_.-]{1,63}$/u.test(String(result.FSUSBLOG_WORKER_OBSERVER_PGDATABASE ?? ''))) errors.push('PostgreSQL database name is invalid')
  if (!/^[0-9A-Za-z_.-]{1,63}$/u.test(String(result.FSUSBLOG_WORKER_OBSERVER_PGUSER ?? ''))) errors.push('PostgreSQL user is invalid')
  if (errors.length > 0) throw new WorkerObserverServiceError(errors, 400)
  return result
}

export function readPrivateAdminHeader(file) {
  privateRegularFileMetadata(file, 'worker observer admin header', true)
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean)
  if (lines.length !== 1) throw new WorkerObserverServiceError(['admin header file must contain exactly one non-empty line'], 400)
  const separator = lines[0].indexOf(':')
  if (separator < 1) throw new WorkerObserverServiceError(['admin header file line is invalid'], 400)
  const name = lines[0].slice(0, separator).trim()
  const value = lines[0].slice(separator + 1).trim()
  if (!/^(Authorization|Cookie)$/u.test(name) || !value || /[\0\r\n]/u.test(value)) {
    throw new WorkerObserverServiceError(['admin header must be exactly one Authorization or Cookie header'], 400)
  }
  return { name, value }
}

export function prepareWorkerObserverStateDirectory(requestedDirectory, environment = process.env) {
  const configuredRoot = path.resolve(environment.FSUSBLOG_WORKER_OBSERVER_ROOT
    ?? path.join(REPOSITORY_ROOT, '.tmp/release-worker-observer-service'))
  fs.mkdirSync(configuredRoot, { recursive: true, mode: 0o700 })
  assertNoSymlinkComponents(configuredRoot, 'worker observer root')
  assertPrivateDirectory(configuredRoot, 'worker observer root')
  const directory = path.resolve(requiredString(requestedDirectory, 'state-dir'))
  if (directory !== configuredRoot && !directory.startsWith(`${configuredRoot}${path.sep}`)) {
    throw new WorkerObserverServiceError(['state-dir must be within FSUSBLOG_WORKER_OBSERVER_ROOT'], 400)
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  assertNoSymlinkComponents(directory, 'worker observer state-dir')
  assertPrivateDirectory(directory, 'worker observer state-dir')
  return directory
}

export async function startWorkerObserverService(input, dependencies = {}) {
  const environment = dependencies.environment ?? process.env
  assertWorkerObserverEnvironment(environment)
  const planFile = canonicalRegularFile(input.plan, 'worker observer plan')
  const planValue = JSON.parse(fs.readFileSync(planFile, 'utf8'))
  let plan = normalizeWorkerObserverServicePlan(planValue)
  const listenHost = input.host === undefined ? plan.listen.host : requiredLoopbackHost(input.host, 'host')
  const listenPort = input.port === undefined ? plan.listen.port : boundedInteger(input.port, 1, 65_535, 'port')
  plan = { ...plan, listen: { host: listenHost, port: listenPort } }
  const privateEnvironment = readPrivateEnvironmentFile(canonicalRegularFile(input.envFile, 'private environment'))
  const adminHeader = readPrivateAdminHeader(canonicalRegularFile(input.adminHeaderFile, 'admin header'))
  const stateDir = prepareWorkerObserverStateDirectory(input.stateDir, environment)
  const rolloutStatePath = path.resolve(requiredString(input.rolloutState, 'rollout-state'))
  const redis = createRedisClient(privateEnvironment, dependencies)
  const admin = createAdminClient(plan, adminHeader, dependencies)
  const docker = createDockerClient(plan, dependencies)
  const recordProvider = createPostgresRecordProvider(plan, privateEnvironment, dependencies)
  const infrastructureReader = createInfrastructureReader(plan, { redis, admin, docker }, dependencies)
  const actionExecutor = createActionExecutor(plan, { redis, admin }, dependencies)
  const application = createWorkerObserverApplication({
    plan,
    rolloutStatePath,
    adminHeader,
    stateDir
  }, {
    ...dependencies,
    recordProvider,
    infrastructureReader,
    actionExecutor,
    journals: dependencies.journals ?? createFileJournalStore(stateDir)
  })
  const server = http.createServer(async (request, responseValue) => {
    try {
      const body = await readHttpRequestBody(request)
      const result = await application.dispatch({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body,
        remoteAddress: request.socket.remoteAddress
      })
      writeHttpResponse(responseValue, result)
    } catch (error) {
      const normalized = normalizeError(error)
      writeHttpResponse(responseValue, response(normalized.statusCode, {
        schema: WORKER_OBSERVER_RESPONSE_SCHEMA,
        status: 'fail',
        rolloutId: null,
        source: null,
        target: null,
        observedAtUtc: new Date().toISOString(),
        errors: normalized.errors
      }))
    }
  })
  server.requestTimeout = 30_000
  server.headersTimeout = 15_000
  server.keepAliveTimeout = 5_000
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(listenPort, listenHost, () => {
      server.off('error', reject)
      resolve()
    })
  })
  return { server, application, plan, address: server.address() }
}

async function readHttpRequestBody(request) {
  if (['GET', 'HEAD'].includes(String(request.method ?? '').toUpperCase())) return {}
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > 65_536) throw new WorkerObserverServiceError(['request body exceeds 64 KiB'], 413)
    chunks.push(chunk)
  }
  if (bytes === 0) return {}
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!isObject(value)) throw new Error('body must be an object')
    return value
  } catch (error) {
    throw new WorkerObserverServiceError([`request body is invalid JSON: ${message(error)}`], 400)
  }
}

function writeHttpResponse(target, result) {
  const payload = `${JSON.stringify(result.body)}\n`
  target.writeHead(result.statusCode, {
    ...result.headers,
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
    'x-content-type-options': 'nosniff'
  })
  target.end(payload)
}

function parseArguments(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) throw new WorkerObserverServiceError([`unexpected argument ${token}`], 400)
    const name = token.slice(2)
    if (!['plan', 'rollout-state', 'env-file', 'admin-header-file', 'state-dir', 'host', 'port'].includes(name)) {
      throw new WorkerObserverServiceError([`unknown option --${name}`], 400)
    }
    if (Object.hasOwn(parsed, name)) throw new WorkerObserverServiceError([`duplicate option --${name}`], 400)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new WorkerObserverServiceError([`--${name} requires a value`], 400)
    parsed[name] = value
    index += 1
  }
  for (const name of ['plan', 'rollout-state', 'env-file', 'admin-header-file', 'state-dir']) {
    if (!parsed[name]) throw new WorkerObserverServiceError([`--${name} is required`], 400)
  }
  return {
    plan: parsed.plan,
    rolloutState: parsed['rollout-state'],
    envFile: parsed['env-file'],
    adminHeaderFile: parsed['admin-header-file'],
    stateDir: parsed['state-dir'],
    host: parsed.host,
    port: parsed.port === undefined ? undefined : Number(parsed.port)
  }
}

function collectForbiddenAuthorityKeys(value, label, errors, insideColumnMap = false) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectForbiddenAuthorityKeys(item, `${label}[${index}]`, errors, insideColumnMap))
    return
  }
  if (!isObject(value)) return
  for (const [key, item] of Object.entries(value)) {
    const isColumnMap = insideColumnMap || (key === 'columns' && label === 'plan.observation')
    if (!isColumnMap && FORBIDDEN_AUTHORITY_KEYS.has(key)) errors.push(`${label}.${key} is a forbidden authoritative result field`)
    collectForbiddenAuthorityKeys(item, `${label}.${key}`, errors, isColumnMap)
  }
}

function rolloutBinding(rollout) {
  return {
    source: releaseBinding(rollout.source),
    target: releaseBinding(rollout.target)
  }
}

function releaseBinding(value) {
  return {
    releaseId: value.releaseId,
    imageDigest: value.imageDigest,
    slot: value.slot,
    generation: Number(value.runtimeGeneration ?? value.generation)
  }
}

function identityMatches(actual, expected) {
  return isObject(actual)
    && actual.releaseId === expected.releaseId
    && actual.imageDigest === expected.imageDigest
    && actual.slot === expected.slot
    && Number(actual.generation ?? actual.runtimeGeneration) === expected.generation
}

function matchesIdentity(row, expected) {
  return row.releaseId === expected.releaseId && Number(row.generation) === expected.generation
}

function makeBindings(values, observedAtUtc, probe) {
  return Object.fromEntries(Object.entries(values).map(([field, value]) => [field, {
    probe,
    pointer: `/body/${field}`,
    observedAtUtc,
    valueSha256: sha256(JSON.stringify(value))
  }]))
}

function maximumActual(rows, field) {
  const values = rows.map(row => row[field]).filter(value => Number.isSafeInteger(value) && value >= 0)
  return values.length === 0 ? null : Math.max(...values)
}

function timestampOrNow(now) {
  const candidate = typeof now === 'function' ? now() : now
  const value = candidate instanceof Date ? candidate.toISOString() : String(candidate ?? new Date().toISOString())
  if (!ISO_UTC.test(value) || !Number.isFinite(Date.parse(value))) throw new WorkerObserverServiceError(['clock returned an invalid ISO UTC timestamp'], 500)
  return value
}

function normalizeLoopbackOrigin(value, label) {
  let url
  try { url = new URL(String(value ?? '')) } catch { throw new WorkerObserverServiceError([`${label} is not a URL`], 400) }
  if (!['http:', 'https:'].includes(url.protocol)
    || !isLoopbackHost(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new WorkerObserverServiceError([`${label} must be an exact loopback HTTP(S) origin`], 400)
  }
  return url.origin
}

function requiredLoopbackHost(value, label) {
  const host = String(value ?? '')
  if (!isLoopbackHost(host)) throw new WorkerObserverServiceError([`${label} must be a loopback host`], 400)
  return host === '[::1]' ? '::1' : host
}

function isLoopbackHost(value) {
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(String(value ?? '').toLowerCase())
}

function assertLoopbackRemote(value) {
  const remote = String(value ?? '')
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
    throw new WorkerObserverServiceError(['worker observer accepts loopback clients only'], 403)
  }
}

function assertIncomingAuthorization(headers, expected) {
  const actual = getRequestHeader(headers, expected.name)
  if (actual === null || !timingSafeStringEqual(actual, expected.value)) {
    throw new WorkerObserverServiceError(['worker observer authorization failed'], 401)
  }
}

function getRequestHeader(headers, name) {
  if (typeof Headers !== 'undefined' && headers instanceof Headers) return headers.get(name)
  if (headers instanceof Map) return headers.get(name) ?? headers.get(name.toLowerCase()) ?? null
  if (!isObject(headers)) return null
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue
    if (Array.isArray(value)) return value.join(', ')
    return value === undefined ? null : String(value)
  }
  return null
}

function getFetchHeader(headers, name) {
  if (!headers || typeof headers.get !== 'function') return null
  const value = headers.get(name)
  return value === null ? null : String(value)
}

function timingSafeStringEqual(left, right) {
  const leftBuffer = Buffer.from(String(left))
  const rightBuffer = Buffer.from(String(right))
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer)
}

function safeRelativePath(value, label) {
  const result = String(value ?? '')
  if (!SAFE_RELATIVE_PATH.test(result) || result.includes('..') || result.startsWith('//')) {
    throw new WorkerObserverServiceError([`${label} must be a safe origin-relative path`], 400)
  }
  return result
}

function requiredString(value, label) {
  const result = String(value ?? '')
  if (!result || result.length > 1_024 || /[\0\r\n]/u.test(result)) throw new WorkerObserverServiceError([`${label} is required or invalid`], 400)
  return result
}

function boundedInteger(value, minimum, maximum, label) {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new WorkerObserverServiceError([`${label} must be an integer in ${minimum}..${maximum}`], 400)
  }
  return result
}

function quoteIdentifier(value) {
  if (!SAFE_IDENTIFIER.test(String(value))) throw new WorkerObserverServiceError(['unsafe SQL identifier'], 500)
  return `"${value}"`
}

function quoteResultAlias(value) {
  if (!SAFE_RESULT_ALIAS.test(String(value))) throw new WorkerObserverServiceError(['unsafe SQL result alias'], 500)
  return `"${value}"`
}

function quoteSqlLiteral(value) {
  const text = String(value)
  if (/[\0\r\n]/u.test(text)) throw new WorkerObserverServiceError(['unsafe SQL selector value'], 400)
  return `'${text.replaceAll("'", "''")}'`
}

function postgresProcessEnvironment(privateEnvironment) {
  return {
    ...minimalProcessEnvironment(),
    PGHOST: privateEnvironment.FSUSBLOG_WORKER_OBSERVER_PGHOST,
    PGPORT: privateEnvironment.FSUSBLOG_WORKER_OBSERVER_PGPORT,
    PGDATABASE: privateEnvironment.FSUSBLOG_WORKER_OBSERVER_PGDATABASE,
    PGUSER: privateEnvironment.FSUSBLOG_WORKER_OBSERVER_PGUSER,
    PGPASSWORD: privateEnvironment.FSUSBLOG_WORKER_OBSERVER_PGPASSWORD,
    PGCONNECT_TIMEOUT: '10'
  }
}

function minimalProcessEnvironment() {
  return Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'DOCKER_HOST']
    .filter(name => process.env[name] !== undefined)
    .map(name => [name, process.env[name]]))
}

function assertExternalResult(result, label) {
  if (result?.error) throw new WorkerObserverServiceError([`${label} failed to start: ${message(result.error)}`], 502)
  if (result?.status !== 0) {
    throw new WorkerObserverServiceError([`${label} exited with status ${String(result?.status ?? 'unknown')}`], 502)
  }
}

function assertRedisKey(value) {
  if (!/^[0-9A-Za-z:._-]{8,500}$/u.test(String(value ?? ''))) throw new WorkerObserverServiceError(['Redis key is invalid'], 500)
}

function renderTemplate(template, values) {
  let result = String(template)
  for (const [name, value] of Object.entries(values)) result = result.replaceAll(`{${name}}`, String(value))
  if (/\{[^}]+\}/u.test(result)) throw new WorkerObserverServiceError(['runtime key template contains unresolved fields'], 500)
  return result
}

function canonicalRegularFile(value, label) {
  const file = path.resolve(requiredString(value, label))
  const metadata = fs.lstatSync(file)
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new WorkerObserverServiceError([`${label} must be a regular non-symlink file`], 400)
  return file
}

function privateRegularFileMetadata(value, label, requirePrivate) {
  const file = path.resolve(requiredString(value, label))
  let metadata
  try { metadata = fs.lstatSync(file) } catch (error) {
    throw new WorkerObserverServiceError([`${label} is unavailable: ${message(error)}`], 400)
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new WorkerObserverServiceError([`${label} must be a regular non-symlink file`], 400)
  const mode = metadata.mode & 0o777
  if (requirePrivate && ![0o400, 0o600].includes(mode)) {
    throw new WorkerObserverServiceError([`${label} must have mode 0400 or 0600`], 400)
  }
  return { path: file, bytes: metadata.size, sha256: hashFile(file), mode }
}

function assertPrivateDirectory(directory, label) {
  const metadata = fs.lstatSync(directory)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new WorkerObserverServiceError([`${label} must be a real directory`], 400)
  if ((metadata.mode & 0o777) !== 0o700) throw new WorkerObserverServiceError([`${label} must have mode 0700`], 400)
}

function assertNoSymlinkComponents(value, label) {
  const resolved = path.resolve(value)
  const parsed = path.parse(resolved)
  let current = parsed.root
  for (const component of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component)
    if (!fs.existsSync(current)) continue
    if (fs.lstatSync(current).isSymbolicLink()) throw new WorkerObserverServiceError([`${label} must not traverse symlinks`], 400)
  }
}

function journalPath(directory, namespace, identity) {
  const digest = sha256(`${namespace}\u0000${identity}`)
  return path.join(directory, `${namespace.replaceAll(/[^a-z0-9-]/gu, '-')}-${digest}.json`)
}

function readOptionalJournal(file) {
  if (!fs.existsSync(file)) return null
  privateRegularFileMetadata(file, 'worker observer journal', true)
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!isObject(value)) throw new Error('journal must be an object')
    return value
  } catch (error) {
    throw new WorkerObserverServiceError([`worker observer journal is invalid: ${message(error)}`], 500)
  }
}

function atomicWritePrivateJson(file, value) {
  const directory = path.dirname(file)
  assertPrivateDirectory(directory, 'worker observer state-dir')
  const temporary = path.join(directory, `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`)
  let descriptor
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporary, file)
    const directoryDescriptor = fs.openSync(directory, 'r')
    try { fs.fsyncSync(directoryDescriptor) } finally { fs.closeSync(directoryDescriptor) }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    fs.rmSync(temporary, { force: true })
  }
}

function hashFile(file) {
  return sha256(fs.readFileSync(file))
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function normalizeError(error) {
  if (error instanceof WorkerObserverServiceError) return error
  return new WorkerObserverServiceError([message(error)], 500)
}

function errorList(error) {
  return error instanceof WorkerObserverServiceError ? error.errors : [message(error)]
}

function message(value) {
  return value instanceof Error ? value.message : String(value)
}

function unique(values) {
  return [...new Set(values)]
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startWorkerObserverService(parseArguments(process.argv.slice(2)))
    .then(({ address }) => {
      process.stdout.write(`${JSON.stringify({
        schema: WORKER_OBSERVER_RESPONSE_SCHEMA,
        status: 'listening',
        address
      })}\n`)
    })
    .catch(error => {
      const normalized = normalizeError(error)
      process.stderr.write(`${JSON.stringify({
        schema: WORKER_OBSERVER_RESPONSE_SCHEMA,
        status: 'fail',
        errors: normalized.errors
      })}\n`)
      process.exitCode = 1
    })
}
