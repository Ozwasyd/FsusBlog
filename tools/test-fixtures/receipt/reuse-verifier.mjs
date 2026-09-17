/**
 * FixtureReceipt-backed run-once reuse verifier (#1711).
 *
 * Generic run-once stays pure (no PostgreSQL/Redis/profile knowledge). Fixture
 * producers inject this verifier so reuse requires real postconditions, not
 * fingerprint + required-output file digests alone.
 */

import path from 'node:path'
import { readFixtureCatalogs } from '../../testing/fixture-catalog.mjs'
import { digestCanonical, freezeDeep, plainObject } from './canonical.mjs'
import {
  digestCacheObservation,
  digestDatabaseObservation,
  digestRedisObservation,
  mergeCacheObservations,
  mergeDatabaseObservations,
  mergeRedisObservations
} from './observations.mjs'
import { verifyCapabilityPostconditions } from './postconditions.mjs'
import { readFixtureReceipt, validateFixtureReceipt } from './fixture-receipt.mjs'
import { FIXTURE_RECEIPT_SCHEMA, RETIRED_FIXTURE_RECEIPT_SCHEMAS } from './schemas.mjs'

/** Stable reuse rejection / success reason codes (#1711). */
export const FIXTURE_REUSE_REASON_CODES = Object.freeze([
  'fixture.reusable',
  'fixture.receipt-missing',
  'fixture.receipt-invalid',
  'fixture.identity-mismatch',
  'fixture.database-drift',
  'fixture.redis-drift',
  'fixture.cache-drift',
  'fixture.capability-missing',
  'fixture.output-drift',
  'fixture.terminal-state-invalid',
  'fixture.generation-mismatch',
  'fixture.skip-bypass-forbidden',
  'fixture.verifier-fault'
])

export const FIXTURE_RUN_ONCE_REUSE_CONTRACT = 'fixture-receipt'

const FORBIDDEN_SKIP_ENV = Object.freeze([
  'FSUSBLOG_SKIP_FIXTURE_VERIFY',
  'FSUSBLOG_SKIP_FIXTURE_REUSE_VERIFY',
  'FSUSBLOG_FIXTURE_REUSE_ANYWAY',
  'FSUSBLOG_FIXTURE_FAST_REUSE'
])

function refuse(reasonCode, detail = null) {
  return freezeDeep({
    reusable: false,
    reasonCode,
    observationDigest: null,
    detail
  })
}

function accept(observationDigest, detail = null) {
  return freezeDeep({
    reusable: true,
    reasonCode: 'fixture.reusable',
    observationDigest,
    detail
  })
}

/**
 * Fail closed if correctness tries to skip postcondition revalidation.
 */
export function assertFixtureReuseBypassForbidden(env = process.env) {
  for (const key of FORBIDDEN_SKIP_ENV) {
    const value = env?.[key]
    if (value != null && String(value).trim() !== '' && String(value) !== '0' && String(value).toLowerCase() !== 'false') {
      const error = new Error(`${key} is forbidden; fixture reuse must revalidate FixtureReceipt postconditions`)
      error.reasonCode = 'fixture.skip-bypass-forbidden'
      throw error
    }
  }
  return true
}

function compositeObservationDigest({
  databaseObservationDigest,
  redisObservationDigest,
  cacheObservationDigest,
  stateGeneration = null,
  receiptDigest = null
}) {
  return digestCanonical({
    databaseObservationDigest,
    redisObservationDigest,
    cacheObservationDigest,
    stateGeneration,
    receiptDigest
  })
}

function resolveReceiptPath(state, context, fixtureReceiptPath) {
  // Bound contract path is authoritative for reuse; caller path must not override it.
  const fromState = state?.reuseContract?.fixtureReceiptPath
    ?? state?.fixtureReceiptPath
    ?? state?.reuseEvidence?.fixtureReceiptPath
  if (typeof fromState === 'string' && fromState.trim()) {
    if (typeof fixtureReceiptPath === 'string' && fixtureReceiptPath.trim()) {
      const left = pathResolveSafe(fixtureReceiptPath)
      const right = pathResolveSafe(fromState)
      if (left !== right) {
        return { mismatch: true, expected: right, actual: left }
      }
    }
    return fromState
  }
  if (typeof fixtureReceiptPath === 'string' && fixtureReceiptPath.trim()) {
    return fixtureReceiptPath
  }
  const fromContext = context?.fixtureReceiptPath
  if (typeof fromContext === 'string' && fromContext.trim()) return fromContext
  const outputs = context?.requiredOutputs ?? state?.requiredOutputs ?? []
  const receiptNamed = outputs.find((item) => /fixture-receipt\.json$/u.test(String(item)))
  return receiptNamed ?? null
}

function pathResolveSafe(value) {
  try {
    return path.resolve(String(value))
  } catch {
    return String(value)
  }
}

function identityMismatch(receipt, {
  expectedExecutionIdentity,
  expectedCatalogDigest,
  expectedProfileId
}) {
  try {
    validateFixtureReceipt(receipt, {
      requireVerified: true,
      expectedExecutionIdentity,
      expectedCatalogDigest,
      expectedProfileId
    })
    return null
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/catalogDigest|profile identity|execution identity|cross-run|cross-identity/iu.test(message)) {
      return { reasonCode: 'fixture.identity-mismatch', detail: message }
    }
    if (/retired|schema|digest mismatch|tampered|invalid terminal/iu.test(message)) {
      return { reasonCode: 'fixture.receipt-invalid', detail: message }
    }
    return { reasonCode: 'fixture.receipt-invalid', detail: message }
  }
}

/**
 * Revalidate a stored FixtureReceipt against live observations.
 * Pure over injected observations — never opens DB/Redis itself.
 */
export async function verifyFixtureReusableState(state, context = {}, options = {}) {
  assertFixtureReuseBypassForbidden(options.env ?? process.env)

  const {
    fixtureReceiptPath = null,
    expectedExecutionIdentity = null,
    expectedCatalogDigest = null,
    expectedProfileId = null,
    observeCurrentState = null,
    currentStateGeneration = null,
    requireStateGeneration = true,
    catalogs = readFixtureCatalogs()
  } = options

  const reuseContract = state?.reuseContract
  if (!reuseContract || reuseContract.kind !== FIXTURE_RUN_ONCE_REUSE_CONTRACT) {
    // One-shot: old fixture run-once states (file-digest only) are not reusable.
    return refuse('fixture.receipt-missing', {
      message: 'fixture run-once state lacks fixture-receipt reuse contract; re-prepare required'
    })
  }

  const resolvedPath = resolveReceiptPath(state, context, fixtureReceiptPath ?? reuseContract.fixtureReceiptPath)
  if (resolvedPath && typeof resolvedPath === 'object' && resolvedPath.mismatch) {
    return refuse('fixture.receipt-invalid', {
      message: 'fixture receipt path diverged from bound reuse contract',
      expected: resolvedPath.expected,
      actual: resolvedPath.actual
    })
  }
  const receiptPath = resolvedPath
  if (!receiptPath) {
    return refuse('fixture.receipt-missing', { message: 'fixture receipt path missing from state/context' })
  }

  let receipt
  try {
    receipt = readFixtureReceipt(receiptPath, { catalogs, requireVerified: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/ENOENT|unreadable|missing/iu.test(message)) {
      return refuse('fixture.receipt-missing', { message, path: receiptPath })
    }
    if (RETIRED_FIXTURE_RECEIPT_SCHEMAS.some((schema) => message.includes(schema))
      || /retired|no dual adapter/iu.test(message)) {
      return refuse('fixture.receipt-invalid', { message, path: receiptPath })
    }
    return refuse('fixture.receipt-invalid', { message, path: receiptPath })
  }

  if (receipt.schema !== FIXTURE_RECEIPT_SCHEMA || receipt.terminalStatus !== 'verified') {
    return refuse('fixture.terminal-state-invalid', {
      schema: receipt.schema,
      terminalStatus: receipt.terminalStatus
    })
  }

  if (reuseContract.fixtureReceiptDigest
    && reuseContract.fixtureReceiptDigest !== receipt.receiptDigest) {
    return refuse('fixture.receipt-invalid', {
      message: 'stored reuse contract receipt digest does not match on-disk FixtureReceipt'
    })
  }

  const identityError = identityMismatch(receipt, {
    expectedExecutionIdentity: expectedExecutionIdentity ?? {
      runId: context.runId ?? null,
      namespace: context.namespace ?? state?.namespace ?? null,
      source: context.sourceIdentity ?? null,
      serviceGeneration: currentStateGeneration
        ?? context.serviceGeneration
        ?? context.currentStateGeneration
        ?? null
    },
    expectedCatalogDigest: expectedCatalogDigest ?? context.catalogDigest ?? null,
    expectedProfileId: expectedProfileId ?? context.profileId ?? null
  })
  if (identityError) {
    return refuse(identityError.reasonCode, identityError.detail)
  }

  // Required output projection digests are enforced by run-once base match.
  // When context supplies a second projection snapshot (consumer admission), refuse drift.
  if (Array.isArray(context.projectedOutputStates) && Array.isArray(state.requiredOutputStates)) {
    if (JSON.stringify(context.projectedOutputStates) !== JSON.stringify(state.requiredOutputStates)) {
      return refuse('fixture.output-drift', {
        message: 'required output projection digests drifted at consumer admission'
      })
    }
  }

  const boundGeneration = reuseContract.stateGeneration
    ?? receipt.executionIdentity?.serviceGeneration
    ?? null
  const liveGeneration = currentStateGeneration
    ?? context.currentStateGeneration
    ?? context.serviceGeneration
    ?? null
  if (requireStateGeneration && (boundGeneration == null || liveGeneration == null)) {
    return refuse('fixture.generation-mismatch', {
      message: 'state generation binding required for fixture reuse (fail closed; no best-effort verify)',
      boundGeneration,
      liveGeneration
    })
  }
  if (boundGeneration != null && liveGeneration != null && String(boundGeneration) !== String(liveGeneration)) {
    return refuse('fixture.generation-mismatch', {
      boundGeneration,
      liveGeneration
    })
  }

  if (typeof observeCurrentState !== 'function') {
    const error = new Error('fixture reuse verifier requires observeCurrentState(context)')
    error.reasonCode = 'fixture.verifier-fault'
    throw error
  }

  let live
  try {
    live = await observeCurrentState({
      state,
      context,
      receipt,
      stateGeneration: liveGeneration
    })
  } catch (error) {
    const fault = error instanceof Error ? error : new Error(String(error))
    fault.reasonCode = fault.reasonCode ?? 'fixture.verifier-fault'
    throw fault
  }

  if (!plainObject(live)) {
    const error = new Error('observeCurrentState must return { database, redis, cache } observations')
    error.reasonCode = 'fixture.verifier-fault'
    throw error
  }

  // Bind live observations to the same identity envelope as FixtureReceipt (#1710 merge).
  const observationIdentity = {
    namespace: receipt.executionIdentity?.namespace
      ?? receipt.databaseObservation?.namespace
      ?? null,
    catalogDigest: receipt.catalogDigest,
    serviceGeneration: liveGeneration
      ?? receipt.executionIdentity?.serviceGeneration
      ?? null,
    schemaIdentity: receipt.serviceIdentity?.schemaIdentity
      ?? receipt.serviceIdentity?.databaseSchema
      ?? 'public',
    redisNamespace: receipt.serviceIdentity?.redisNamespace ?? null,
    aotGeneration: receipt.cacheObservation?.aotGeneration ?? null
  }
  const databaseObservation = mergeDatabaseObservations(
    [live.database ?? live.databaseObservation ?? {}],
    observationIdentity
  )
  const redisObservation = mergeRedisObservations(
    [live.redis ?? live.redisObservation ?? {}],
    observationIdentity
  )
  const cacheObservation = mergeCacheObservations(
    [live.cache ?? live.cacheObservation ?? {}],
    observationIdentity
  )

  const liveDatabaseDigest = digestDatabaseObservation(databaseObservation)
  const liveRedisDigest = digestRedisObservation(redisObservation)
  const liveCacheDigest = digestCacheObservation(cacheObservation)

  if (liveDatabaseDigest !== receipt.databaseObservationDigest) {
    return refuse('fixture.database-drift', {
      expected: receipt.databaseObservationDigest,
      actual: liveDatabaseDigest
    })
  }
  if (liveRedisDigest !== receipt.redisObservationDigest) {
    return refuse('fixture.redis-drift', {
      expected: receipt.redisObservationDigest,
      actual: liveRedisDigest
    })
  }
  if (liveCacheDigest !== receipt.cacheObservationDigest) {
    return refuse('fixture.cache-drift', {
      expected: receipt.cacheObservationDigest,
      actual: liveCacheDigest
    })
  }

  // Re-run every capability postcondition against live observations.
  try {
    for (const producerReceipt of receipt.producerReceipts ?? []) {
      verifyCapabilityPostconditions({
        capabilities: (receipt.capabilityMap ?? []).map((item) => item.capabilityId),
        producerId: producerReceipt.producerId,
        providedCapabilities: producerReceipt.providedCapabilities,
        observations: {
          database: databaseObservation,
          redis: redisObservation,
          cache: cacheObservation
        },
        entityIdentities: producerReceipt.entityIdentities ?? [],
        catalogs
      })
    }
    // none profile: zero producers — still require empty observations (already bound by digests).
    if ((receipt.producerReceipts ?? []).length === 0
      && receipt.profileIdentity?.profileId === 'none') {
      if ((databaseObservation.entities ?? []).length
        || (redisObservation.keys ?? []).length
        || (cacheObservation.entries ?? []).length) {
        return refuse('fixture.capability-missing', {
          message: 'none profile live observations are non-empty'
        })
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return refuse('fixture.capability-missing', { message })
  }

  const observationDigest = compositeObservationDigest({
    databaseObservationDigest: liveDatabaseDigest,
    redisObservationDigest: liveRedisDigest,
    cacheObservationDigest: liveCacheDigest,
    stateGeneration: liveGeneration,
    receiptDigest: receipt.receiptDigest
  })

  return accept(observationDigest, {
    fixtureReceiptPath: receiptPath,
    fixtureReceiptDigest: receipt.receiptDigest,
    stateGeneration: liveGeneration
  })
}

/**
 * Build an injectable verifyReusableState(state, context) bound to FixtureReceipt.
 */
export function createFixtureReceiptReuseVerifier(options = {}) {
  if (typeof options.observeCurrentState !== 'function') {
    throw new Error('createFixtureReceiptReuseVerifier requires observeCurrentState')
  }
  return async function verifyReusableState(state, context) {
    return verifyFixtureReusableState(state, context, options)
  }
}

/**
 * Enrich a successful run-once state with the fixture-receipt reuse contract.
 * Old states without this contract cannot be reused (one-shot migration).
 *
 * requiredOutputStates is stored as a plain JSON clone (not freezeDeep) so path/digest
 * key order matches run-once captureOutputStates for equality checks.
 */
export function buildFixtureReuseContract({
  fixtureReceiptPath,
  fixtureReceiptDigest,
  observationDigest,
  stateGeneration,
  catalogDigest = null,
  profileId = null,
  requiredOutputStates = null
}) {
  if (!fixtureReceiptPath || !fixtureReceiptDigest) {
    throw new Error('fixture reuse contract requires receipt path and digest')
  }
  return {
    reuseContract: {
      kind: FIXTURE_RUN_ONCE_REUSE_CONTRACT,
      fixtureReceiptPath: String(fixtureReceiptPath),
      fixtureReceiptDigest: String(fixtureReceiptDigest),
      observationDigest: observationDigest ?? null,
      stateGeneration: stateGeneration == null ? null : String(stateGeneration),
      catalogDigest: catalogDigest ?? null,
      profileId: profileId ?? null,
      requiredOutputStates: requiredOutputStates == null
        ? null
        : JSON.parse(JSON.stringify(requiredOutputStates))
    }
  }
}

export function isFixtureReuseVerifierRegistered(value) {
  return value === FIXTURE_RUN_ONCE_REUSE_CONTRACT || value === 'fixture-receipt'
}
