/**
 * FixtureReceipt builder / validator / digest (#1710).
 *
 * Aggregates ProducerReceipts; terminalStatus verified only when all
 * capability postconditions pass with bound observation digests.
 */

import { readFixtureCatalogs } from '../../testing/fixture-catalog.mjs'
import {
  assertDigest,
  digestCanonical,
  digestReceiptBody,
  freezeDeep,
  plainObject
} from './canonical.mjs'
import {
  digestCacheObservation,
  digestDatabaseObservation,
  digestRedisObservation,
  emptyCacheObservation,
  emptyDatabaseObservation,
  emptyRedisObservation,
  mergeCacheObservations,
  mergeDatabaseObservations,
  mergeRedisObservations,
  normalizeCacheObservation,
  normalizeDatabaseObservation,
  normalizeRedisObservation,
  reverifyObservationDigests
} from './observations.mjs'
import { assertProfilePostconditionsBound } from './postconditions.mjs'
import { validateProducerReceipt } from './producer-receipt.mjs'
import { writePrivateJson, readPrivateJson } from './private-io.mjs'
import { assertNoSecrets } from './secrets.mjs'
import {
  FIXTURE_RECEIPT_SCHEMA,
  FIXTURE_TERMINAL_STATUSES,
  RETIRED_FIXTURE_RECEIPT_SCHEMAS
} from './schemas.mjs'

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`)
  return value.trim()
}

function normalizeExecutionIdentity(value) {
  if (!plainObject(value)) throw new Error('executionIdentity is required')
  return freezeDeep({
    runId: value.runId == null ? null : String(value.runId),
    namespace: value.namespace == null ? null : String(value.namespace),
    source: value.source == null
      ? null
      : freezeDeep({
        commit: value.source.commit == null ? null : String(value.source.commit),
        worktreeFingerprint: value.source.worktreeFingerprint == null
          ? null
          : String(value.source.worktreeFingerprint)
      }),
    serviceGeneration: value.serviceGeneration == null ? null : String(value.serviceGeneration)
  })
}

function normalizeProfileIdentity(value) {
  if (!plainObject(value)) throw new Error('profileIdentity is required')
  return freezeDeep({
    profileId: requireText(String(value.profileId ?? ''), 'profileIdentity.profileId'),
    profileSource: requireText(String(value.profileSource ?? ''), 'profileIdentity.profileSource'),
    executionClass: value.executionClass == null ? null : String(value.executionClass),
    sealed: value.sealed === true
  })
}

function normalizeServiceIdentity(value) {
  if (value == null) {
    return freezeDeep({
      databaseSchema: 'public',
      databaseInstance: null,
      redisNamespace: null,
      redisInstance: null,
      schemaIdentity: 'public'
    })
  }
  if (!plainObject(value)) throw new Error('serviceIdentity must be an object')
  return freezeDeep({
    databaseSchema: value.databaseSchema == null ? 'public' : String(value.databaseSchema),
    databaseInstance: value.databaseInstance == null ? null : String(value.databaseInstance),
    redisNamespace: value.redisNamespace == null ? null : String(value.redisNamespace),
    redisInstance: value.redisInstance == null ? null : String(value.redisInstance),
    schemaIdentity: value.schemaIdentity == null ? 'public' : String(value.schemaIdentity)
  })
}

function normalizeOutputArtifacts(items) {
  if (!Array.isArray(items)) throw new Error('outputArtifacts must be an array')
  const normalized = items.map((item, index) => {
    if (!plainObject(item)) throw new Error(`outputArtifacts[${index}] must be an object`)
    return freezeDeep({
      path: requireText(String(item.path ?? ''), `outputArtifacts[${index}].path`),
      digest: assertDigest(String(item.digest ?? ''), `outputArtifacts[${index}].digest`),
      role: item.role == null ? 'fixture-output' : String(item.role)
    })
  })
  normalized.sort((left, right) => left.path.localeCompare(right.path))
  return Object.freeze(normalized)
}

function normalizeCapabilityMap(items) {
  if (!Array.isArray(items)) throw new Error('capabilityMap must be an array')
  const normalized = items.map((item, index) => {
    if (!plainObject(item)) throw new Error(`capabilityMap[${index}] must be an object`)
    return freezeDeep({
      capabilityId: requireText(String(item.capabilityId ?? ''), `capabilityMap[${index}].capabilityId`),
      producerId: requireText(String(item.producerId ?? ''), `capabilityMap[${index}].producerId`),
      postconditionIds: Object.freeze([...(item.postconditionIds ?? [])].map(String).sort())
    })
  })
  normalized.sort((left, right) => left.capabilityId.localeCompare(right.capabilityId))
  return Object.freeze(normalized)
}

function normalizeProducerReceiptDigests(digests) {
  if (!Array.isArray(digests)) throw new Error('orderedProducerReceiptDigests must be an array')
  return Object.freeze(digests.map((item, index) => assertDigest(String(item), `orderedProducerReceiptDigests[${index}]`)))
}

/**
 * Build a FixtureReceipt. terminalStatus must be one of FIXTURE_TERMINAL_STATUSES.
 * Only terminalStatus === 'verified' is publishable success evidence.
 */
export function buildFixtureReceipt({
  terminalStatus,
  executionIdentity,
  profileIdentity,
  catalogDigest,
  expandedCapabilityDigest,
  orderedProducerReceiptDigests = [],
  producerReceipts = [],
  capabilityMap = [],
  serviceIdentity = null,
  outputArtifacts = [],
  databaseObservation = null,
  redisObservation = null,
  cacheObservation = null,
  verifiedAt = null,
  primaryFailure = null,
  cleanupFailure = null,
  catalogs = readFixtureCatalogs()
} = {}) {
  if (!FIXTURE_TERMINAL_STATUSES.includes(terminalStatus)) {
    throw new Error(`invalid FixtureReceipt terminalStatus: ${terminalStatus}`)
  }

  const profile = normalizeProfileIdentity(profileIdentity)
  const execution = normalizeExecutionIdentity(executionIdentity)
  const catalog = assertDigest(catalogDigest, 'catalogDigest')
  const capabilityDigest = assertDigest(expandedCapabilityDigest, 'expandedCapabilityDigest')

  // Bind sealed catalog producers for capability map completeness on verified.
  const profileCapabilities = capabilityMap.map((item) => item.capabilityId)
  if (terminalStatus === 'verified') {
    assertProfilePostconditionsBound(profileCapabilities, catalogs)
    // none profile: zero producers and zero capabilities.
    if (profile.profileId === 'none') {
      if (orderedProducerReceiptDigests.length !== 0 || producerReceipts.length !== 0) {
        throw new Error('none profile verified receipt must have zero producer receipts')
      }
      if (capabilityMap.length !== 0) {
        throw new Error('none profile verified receipt must have zero capability map entries')
      }
    }
    for (const receipt of producerReceipts) {
      validateProducerReceipt(receipt, { catalogs })
    }
    const digests = producerReceipts.map((item) => item.producerReceiptDigest)
    if (JSON.stringify(digests) !== JSON.stringify([...orderedProducerReceiptDigests])) {
      throw new Error('orderedProducerReceiptDigests must match producerReceipts order exactly')
    }
  }

  const identity = {
    namespace: execution.namespace,
    catalogDigest: catalog,
    serviceGeneration: execution.serviceGeneration,
    schemaIdentity: serviceIdentity?.schemaIdentity ?? serviceIdentity?.databaseSchema ?? 'public',
    redisNamespace: serviceIdentity?.redisNamespace ?? null,
    aotGeneration: null
  }

  let databaseObs
  let redisObs
  let cacheObs
  if (producerReceipts.length && terminalStatus === 'verified' && profile.profileId !== 'none') {
    databaseObs = mergeDatabaseObservations(
      producerReceipts.map((item) => item.observations?.database).filter(Boolean),
      identity
    )
    redisObs = mergeRedisObservations(
      producerReceipts.map((item) => item.observations?.redis).filter(Boolean),
      identity
    )
    cacheObs = mergeCacheObservations(
      producerReceipts.map((item) => item.observations?.cache).filter(Boolean),
      identity
    )
  } else {
    databaseObs = databaseObservation
      ? normalizeDatabaseObservation(databaseObservation)
      : emptyDatabaseObservation(identity)
    redisObs = redisObservation
      ? normalizeRedisObservation(redisObservation)
      : emptyRedisObservation(identity)
    cacheObs = cacheObservation
      ? normalizeCacheObservation(cacheObservation)
      : emptyCacheObservation(identity)
  }

  // none verified: prove zero business fixture mutation (explicit non-empty observations fail closed).
  if (terminalStatus === 'verified' && profile.profileId === 'none') {
    if ((databaseObs.entities ?? []).length !== 0
      || (redisObs.keys ?? []).length !== 0
      || (cacheObs.entries ?? []).length !== 0
      || outputArtifacts.length !== 0
      || orderedProducerReceiptDigests.length !== 0
      || producerReceipts.length !== 0) {
      throw new Error('none profile verified receipt must prove zero business fixture mutation')
    }
  }

  const databaseObservationDigest = digestDatabaseObservation(databaseObs)
  const redisObservationDigest = digestRedisObservation(redisObs)
  const cacheObservationDigest = digestCacheObservation(cacheObs)

  if (terminalStatus === 'verified' && verifiedAt == null) {
    verifiedAt = new Date().toISOString()
  }
  if (terminalStatus !== 'verified') {
    // Non-verified receipts must not look like success evidence via verifiedAt alone.
    verifiedAt = null
  }

  const body = {
    schema: FIXTURE_RECEIPT_SCHEMA,
    terminalStatus,
    executionIdentity: execution,
    profileIdentity: profile,
    catalogDigest: catalog,
    expandedCapabilityDigest: capabilityDigest,
    orderedProducerReceiptDigests: normalizeProducerReceiptDigests(orderedProducerReceiptDigests),
    capabilityMap: normalizeCapabilityMap(capabilityMap),
    serviceIdentity: normalizeServiceIdentity(serviceIdentity),
    outputArtifacts: normalizeOutputArtifacts(outputArtifacts),
    databaseObservationDigest,
    redisObservationDigest,
    cacheObservationDigest,
    // Observations retained for re-verify; digests are authoritative for binding.
    databaseObservation: freezeDeep(databaseObs),
    redisObservation: freezeDeep(redisObs),
    cacheObservation: freezeDeep(cacheObs),
    producerReceipts: Object.freeze((producerReceipts ?? []).map((item) => freezeDeep(item))),
    zeroBusinessMutation: profile.profileId === 'none' && terminalStatus === 'verified',
    verifiedAt,
    primaryFailure: primaryFailure == null ? null : freezeDeep(primaryFailure),
    cleanupFailure: cleanupFailure == null ? null : freezeDeep(cleanupFailure)
  }

  assertNoSecrets(body)
  const receiptDigest = digestReceiptBody(body, 'receiptDigest')
  return freezeDeep({ ...body, receiptDigest })
}

export function validateFixtureReceipt(document, {
  catalogs = readFixtureCatalogs(),
  requireVerified = false,
  expectedExecutionIdentity = null,
  expectedCatalogDigest = null,
  expectedProfileId = null
} = {}) {
  if (!plainObject(document)) throw new Error('FixtureReceipt must be an object')
  if (RETIRED_FIXTURE_RECEIPT_SCHEMAS.includes(document.schema)) {
    throw new Error(`retired fixture receipt schema ${document.schema}; no dual adapter`)
  }
  if (document.schema !== FIXTURE_RECEIPT_SCHEMA) {
    throw new Error(`FixtureReceipt schema must be ${FIXTURE_RECEIPT_SCHEMA}`)
  }
  if (!FIXTURE_TERMINAL_STATUSES.includes(document.terminalStatus)) {
    throw new Error(`invalid terminalStatus ${document.terminalStatus}`)
  }
  if (requireVerified && document.terminalStatus !== 'verified') {
    throw new Error(`FixtureReceipt terminalStatus is ${document.terminalStatus}, not verified`)
  }
  assertNoSecrets(document)

  const expected = digestReceiptBody(document, 'receiptDigest')
  if (document.receiptDigest !== expected) {
    throw new Error('FixtureReceipt digest mismatch (tampered or incomplete)')
  }
  assertDigest(document.receiptDigest, 'receiptDigest')
  assertDigest(document.catalogDigest, 'catalogDigest')
  assertDigest(document.expandedCapabilityDigest, 'expandedCapabilityDigest')

  reverifyObservationDigests({
    databaseObservation: document.databaseObservation,
    redisObservation: document.redisObservation,
    cacheObservation: document.cacheObservation,
    databaseObservationDigest: document.databaseObservationDigest,
    redisObservationDigest: document.redisObservationDigest,
    cacheObservationDigest: document.cacheObservationDigest
  })

  if (expectedCatalogDigest != null && document.catalogDigest !== expectedCatalogDigest) {
    throw new Error('FixtureReceipt catalogDigest does not match current catalog (cross-identity reuse refused)')
  }
  if (expectedProfileId != null && document.profileIdentity?.profileId !== expectedProfileId) {
    throw new Error('FixtureReceipt profile identity mismatch')
  }
  if (expectedExecutionIdentity != null) {
    const want = normalizeExecutionIdentity(expectedExecutionIdentity)
    const got = normalizeExecutionIdentity(document.executionIdentity)
    if (digestCanonical(want) !== digestCanonical(got)) {
      throw new Error('FixtureReceipt execution identity mismatch (cross-run reuse refused)')
    }
  }

  if (document.terminalStatus === 'verified') {
    for (const producerReceipt of document.producerReceipts ?? []) {
      validateProducerReceipt(producerReceipt, { catalogs })
    }
    if (document.profileIdentity?.profileId === 'none') {
      if ((document.databaseObservation?.entities ?? []).length !== 0
        || (document.redisObservation?.keys ?? []).length !== 0
        || (document.cacheObservation?.entries ?? []).length !== 0
        || (document.outputArtifacts ?? []).length !== 0
        || (document.orderedProducerReceiptDigests ?? []).length !== 0) {
        throw new Error('none verified receipt must prove zero business fixture mutation')
      }
    }
  }

  return freezeDeep(document)
}

export function writeFixtureReceipt(file, document, options = {}) {
  const validated = validateFixtureReceipt(document, options)
  const result = writePrivateJson(file, validated, { label: 'FixtureReceipt' })
  // Re-read and validate integrity.
  const loaded = readFixtureReceipt(file, options)
  if (loaded.receiptDigest !== validated.receiptDigest) {
    throw new Error('FixtureReceipt digest mismatch after private write')
  }
  return { receipt: loaded, ...result }
}

export function readFixtureReceipt(file, options = {}) {
  const { document } = readPrivateJson(file, { label: 'FixtureReceipt' })
  return validateFixtureReceipt(document, options)
}

/**
 * Aggregate validated producer receipts into a verified FixtureReceipt.
 */
export function aggregateVerifiedFixtureReceipt({
  plan,
  producerReceipts,
  serviceIdentity = null,
  outputArtifacts = [],
  catalogs = readFixtureCatalogs()
}) {
  if (!plan) throw new Error('plan is required')
  const capabilities = plan.capabilities ?? []
  const catalogByCapability = new Map(
    (catalogs.capability.capabilities ?? []).map((item) => [item.id, item])
  )
  const capabilityMap = capabilities.map((capabilityId) => {
    const capability = catalogByCapability.get(capabilityId)
    if (!capability) throw new Error(`unknown capability ${capabilityId}`)
    const owner = capability.ownerProducerId
    const ownerReceipt = producerReceipts.find((item) => item.producerId === owner)
    if (!ownerReceipt && plan.profileIdentity?.profileId !== 'none') {
      throw new Error(`missing ProducerReceipt for capability owner ${owner} (${capabilityId})`)
    }
    if (ownerReceipt && !(ownerReceipt.providedCapabilities ?? []).includes(capabilityId)) {
      throw new Error(`ProducerReceipt ${owner} did not provide required capability ${capabilityId}`)
    }
    return {
      capabilityId,
      producerId: owner,
      postconditionIds: [...(capability.postconditionIds ?? [])]
    }
  })

  // Every profile capability must appear exactly once.
  assertProfilePostconditionsBound(capabilities, catalogs)

  return buildFixtureReceipt({
    terminalStatus: 'verified',
    executionIdentity: {
      runId: plan.executionIdentity?.runId ?? null,
      namespace: plan.executionIdentity?.namespace ?? null,
      source: plan.executionIdentity?.sourceIdentity ?? null,
      serviceGeneration: plan.executionIdentity?.serviceGeneration
        ?? plan.executionIdentity?.handles?.serviceGeneration
        ?? null
    },
    profileIdentity: {
      profileId: plan.profileIdentity?.profileId ?? plan.profileId,
      profileSource: plan.profileIdentity?.profileSource ?? plan.profileSource,
      executionClass: plan.profileIdentity?.executionClass ?? null,
      sealed: plan.profileIdentity?.sealed === true || plan.profileIdentity?.profileSource === 'matrix'
    },
    catalogDigest: plan.catalogDigest,
    expandedCapabilityDigest: plan.expandedCapabilityDigest,
    orderedProducerReceiptDigests: producerReceipts.map((item) => item.producerReceiptDigest),
    producerReceipts,
    capabilityMap,
    serviceIdentity: serviceIdentity ?? {
      databaseSchema: 'public',
      databaseInstance: plan.executionIdentity?.handles?.pgContainer ?? null,
      redisInstance: plan.executionIdentity?.handles?.redisContainer ?? null,
      redisNamespace: plan.executionIdentity?.namespace
        ? `FsusBlog_${plan.executionIdentity.namespace}_`
        : null,
      schemaIdentity: 'public'
    },
    outputArtifacts,
    catalogs
  })
}

export function buildTerminalFailureReceipt({
  terminalStatus,
  plan,
  primaryFailure = null,
  cleanupFailure = null,
  producerReceipts = [],
  catalogs = readFixtureCatalogs()
}) {
  if (terminalStatus === 'verified') {
    throw new Error('buildTerminalFailureReceipt cannot emit verified')
  }
  if (!['partial', 'failed', 'cleanup-failed'].includes(terminalStatus)) {
    throw new Error(`invalid failure terminalStatus ${terminalStatus}`)
  }
  return buildFixtureReceipt({
    terminalStatus,
    executionIdentity: {
      runId: plan.executionIdentity?.runId ?? null,
      namespace: plan.executionIdentity?.namespace ?? null,
      source: plan.executionIdentity?.sourceIdentity ?? null,
      serviceGeneration: plan.executionIdentity?.handles?.serviceGeneration ?? null
    },
    profileIdentity: {
      profileId: plan.profileIdentity?.profileId,
      profileSource: plan.profileIdentity?.profileSource,
      executionClass: plan.profileIdentity?.executionClass ?? null,
      sealed: plan.profileIdentity?.profileSource === 'matrix'
    },
    catalogDigest: plan.catalogDigest,
    expandedCapabilityDigest: plan.expandedCapabilityDigest,
    orderedProducerReceiptDigests: producerReceipts.map((item) => item.producerReceiptDigest),
    producerReceipts,
    capabilityMap: [],
    serviceIdentity: {
      databaseSchema: 'public',
      databaseInstance: plan.executionIdentity?.handles?.pgContainer ?? null,
      redisInstance: plan.executionIdentity?.handles?.redisContainer ?? null,
      redisNamespace: plan.executionIdentity?.namespace
        ? `FsusBlog_${plan.executionIdentity.namespace}_`
        : null
    },
    primaryFailure,
    cleanupFailure,
    catalogs
  })
}
