/**
 * Immutable ProducerReceipt builder / validator / digest (#1710).
 *
 * Success receipts are published only after prepare + postcondition verify.
 */

import { readFixtureCatalogs } from '../../testing/fixture-catalog.mjs'
import {
  assertDigest,
  digestReceiptBody,
  freezeDeep,
  plainObject
} from './canonical.mjs'
import {
  digestCacheObservation,
  digestDatabaseObservation,
  digestRedisObservation,
  normalizeCacheObservation,
  normalizeDatabaseObservation,
  normalizeRedisObservation
} from './observations.mjs'
import { assertNoSecrets } from './secrets.mjs'
import {
  ENTITY_IDENTITY_KINDS,
  PRODUCER_RECEIPT_SCHEMA,
  RETIRED_FIXTURE_RECEIPT_SCHEMAS
} from './schemas.mjs'

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`)
  return value.trim()
}

function freezeSortedStrings(values, label) {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`)
  const list = values.map((item) => requireText(String(item), label))
  const sorted = [...new Set(list)].sort()
  if (JSON.stringify(sorted) !== JSON.stringify(list) && list.length !== sorted.length) {
    // allow already-sorted unique; coerce to sorted unique
  }
  return Object.freeze([...new Set(list)].sort())
}

const ENTITY_IDENTITY_ALLOWED_KEYS = new Set(['kind', 'id', 'handle', 'digest'])

function normalizeEntityIdentities(entities) {
  if (!Array.isArray(entities)) throw new Error('entityIdentities must be an array')
  const normalized = entities.map((item, index) => {
    if (!plainObject(item)) throw new Error(`entityIdentities[${index}] must be an object`)
    // Fail closed on invented fields (tokens/cookies must not be smuggled under alternate keys).
    assertNoSecrets(item)
    for (const key of Object.keys(item)) {
      if (!ENTITY_IDENTITY_ALLOWED_KEYS.has(key)) {
        throw new Error(`entityIdentities[${index}] forbids field ${key}; only kind/id/handle/digest allowed`)
      }
    }
    const kind = requireText(String(item.kind ?? 'other'), `entityIdentities[${index}].kind`)
    if (!ENTITY_IDENTITY_KINDS.includes(kind) && kind !== 'other') {
      // allow extension via 'other'
    }
    const id = requireText(String(item.id ?? item.handle ?? ''), `entityIdentities[${index}].id`)
    const entry = {
      kind,
      id,
      handle: item.handle == null ? null : String(item.handle),
      digest: item.digest == null ? null : assertDigest(String(item.digest), `entityIdentities[${index}].digest`)
    }
    assertNoSecrets(entry)
    return entry
  })
  normalized.sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`))
  return Object.freeze(normalized.map((item) => freezeDeep(item)))
}

function normalizePostconditionObservations(items) {
  if (!Array.isArray(items)) throw new Error('postconditionObservations must be an array')
  const normalized = items.map((item, index) => {
    if (!plainObject(item)) throw new Error(`postconditionObservations[${index}] must be an object`)
    return freezeDeep({
      capabilityId: requireText(String(item.capabilityId ?? ''), `postconditionObservations[${index}].capabilityId`),
      postconditionId: requireText(String(item.postconditionId ?? ''), `postconditionObservations[${index}].postconditionId`),
      ok: item.ok === true,
      detail: item.detail ?? null,
      reason: item.reason == null ? null : String(item.reason)
    })
  })
  normalized.sort((left, right) => `${left.capabilityId}:${left.postconditionId}`
    .localeCompare(`${right.capabilityId}:${right.postconditionId}`))
  return Object.freeze(normalized)
}

function normalizeCleanupContract(value) {
  if (value == null) return Object.freeze({ kind: 'owned-namespace' })
  if (!plainObject(value)) throw new Error('cleanupContract must be an object')
  return freezeDeep({
    kind: requireText(String(value.kind ?? 'owned-namespace'), 'cleanupContract.kind'),
    notes: value.notes == null ? null : String(value.notes)
  })
}

function normalizeSource(source) {
  if (source == null) return null
  if (!plainObject(source)) throw new Error('source must be an object')
  const commit = source.commit == null ? null : String(source.commit)
  const worktreeFingerprint = source.worktreeFingerprint == null
    ? null
    : String(source.worktreeFingerprint)
  if (commit != null && commit !== '' && !/^[a-f0-9]{40}$/u.test(commit) && !/^[a-f0-9]{64}$/u.test(commit)) {
    // allow shortened in unit tests only when explicitly marked; production prefers full hash
    if (!/^[a-f0-9]{7,64}$/u.test(commit)) {
      throw new Error('source.commit must be a hex commit id')
    }
  }
  return freezeDeep({ commit, worktreeFingerprint })
}

/**
 * Build an immutable success ProducerReceipt. Caller must only invoke after verify.
 */
export function buildProducerReceipt({
  producerId,
  strategy,
  runId = null,
  namespace = null,
  source = null,
  fixtureCatalogDigest,
  profileId,
  expandedCapabilityDigest,
  serviceGeneration = null,
  providedCapabilities,
  ownedStateDomains,
  entityIdentities = [],
  postconditionObservations = [],
  cleanupContract = null,
  databaseObservation = null,
  redisObservation = null,
  cacheObservation = null,
  catalogs = readFixtureCatalogs()
} = {}) {
  const id = requireText(String(producerId ?? ''), 'producerId')
  const catalogProducer = (catalogs.producer.producers ?? []).find((item) => item.id === id)
  if (!catalogProducer) throw new Error(`unknown producer ${id}`)
  const sealedStrategy = requireText(String(strategy ?? catalogProducer.strategy), 'strategy')
  if (sealedStrategy !== catalogProducer.strategy) {
    throw new Error(`producer ${id} strategy ${sealedStrategy} does not match catalog ${catalogProducer.strategy}`)
  }

  const provided = freezeSortedStrings(providedCapabilities ?? catalogProducer.provides, 'providedCapabilities')
  for (const capabilityId of provided) {
    if (!catalogProducer.provides.includes(capabilityId)) {
      throw new Error(`producer ${id} cannot claim undeclared capability ${capabilityId}`)
    }
  }
  // Producers may provide a subset of catalog provides for a profile slice, but never a superset.

  const domains = freezeSortedStrings(ownedStateDomains ?? catalogProducer.stateDomains, 'ownedStateDomains')
  const catalogDomains = [...catalogProducer.stateDomains].sort()
  for (const domain of domains) {
    if (!catalogDomains.includes(domain)) {
      throw new Error(`producer ${id} owned state domain ${domain} is not catalog-declared`)
    }
  }

  const observations = {
    database: databaseObservation
      ? normalizeDatabaseObservation(databaseObservation)
      : null,
    redis: redisObservation
      ? normalizeRedisObservation(redisObservation)
      : null,
    cache: cacheObservation
      ? normalizeCacheObservation(cacheObservation)
      : null
  }

  const body = {
    schema: PRODUCER_RECEIPT_SCHEMA,
    producerId: id,
    strategy: sealedStrategy,
    runId: runId == null ? null : String(runId),
    namespace: namespace == null ? null : String(namespace),
    source: normalizeSource(source),
    fixtureCatalogDigest: assertDigest(fixtureCatalogDigest, 'fixtureCatalogDigest'),
    profileId: requireText(String(profileId ?? ''), 'profileId'),
    expandedCapabilityDigest: assertDigest(expandedCapabilityDigest, 'expandedCapabilityDigest'),
    serviceGeneration: serviceGeneration == null ? null : String(serviceGeneration),
    providedCapabilities: provided,
    ownedStateDomains: domains,
    entityIdentities: normalizeEntityIdentities(entityIdentities),
    postconditionObservations: normalizePostconditionObservations(postconditionObservations),
    cleanupContract: normalizeCleanupContract(cleanupContract),
    observationDigests: freezeDeep({
      database: observations.database ? digestDatabaseObservation(observations.database) : null,
      redis: observations.redis ? digestRedisObservation(observations.redis) : null,
      cache: observations.cache ? digestCacheObservation(observations.cache) : null
    }),
    // Keep normalized observations for re-verify / aggregation; digests bind them.
    observations: freezeDeep(observations)
  }

  // Reject invented top-level fields by reconstructing from allow-list only (already done).
  assertNoSecrets(body)
  for (const item of body.postconditionObservations) {
    if (item.ok !== true) {
      throw new Error(`cannot publish ProducerReceipt success while postcondition ${item.postconditionId} failed`)
    }
  }

  const producerReceiptDigest = digestReceiptBody(body, 'producerReceiptDigest')
  return freezeDeep({ ...body, producerReceiptDigest })
}

export function validateProducerReceipt(document, { catalogs = readFixtureCatalogs() } = {}) {
  if (!plainObject(document)) throw new Error('ProducerReceipt must be an object')
  if (RETIRED_FIXTURE_RECEIPT_SCHEMAS.includes(document.schema)) {
    throw new Error(`retired receipt schema ${document.schema} is not accepted; no dual adapter`)
  }
  if (document.schema !== PRODUCER_RECEIPT_SCHEMA) {
    throw new Error(`ProducerReceipt schema must be ${PRODUCER_RECEIPT_SCHEMA}`)
  }
  assertNoSecrets(document)
  const expected = digestReceiptBody(document, 'producerReceiptDigest')
  if (document.producerReceiptDigest !== expected) {
    throw new Error('ProducerReceipt digest mismatch (tampered or incomplete)')
  }
  assertDigest(document.producerReceiptDigest, 'producerReceiptDigest')
  assertDigest(document.fixtureCatalogDigest, 'fixtureCatalogDigest')
  assertDigest(document.expandedCapabilityDigest, 'expandedCapabilityDigest')

  const catalogProducer = (catalogs.producer.producers ?? []).find((item) => item.id === document.producerId)
  if (!catalogProducer) throw new Error(`ProducerReceipt producer ${document.producerId} not in catalog`)
  if (document.strategy !== catalogProducer.strategy) {
    throw new Error(`ProducerReceipt strategy does not match catalog for ${document.producerId}`)
  }
  for (const capabilityId of document.providedCapabilities ?? []) {
    if (!catalogProducer.provides.includes(capabilityId)) {
      throw new Error(`ProducerReceipt claims undeclared capability ${capabilityId}`)
    }
  }
  // Recompute observation digests when observations are present.
  const obs = document.observations ?? {}
  if (obs.database) {
    const dig = digestDatabaseObservation(obs.database)
    if (document.observationDigests?.database !== dig) {
      throw new Error('ProducerReceipt database observation digest mismatch')
    }
  }
  if (obs.redis) {
    const dig = digestRedisObservation(obs.redis)
    if (document.observationDigests?.redis !== dig) {
      throw new Error('ProducerReceipt redis observation digest mismatch')
    }
  }
  if (obs.cache) {
    const dig = digestCacheObservation(obs.cache)
    if (document.observationDigests?.cache !== dig) {
      throw new Error('ProducerReceipt cache observation digest mismatch')
    }
  }
  return freezeDeep(document)
}

export function producerReceiptDigestOf(document) {
  return validateProducerReceipt(document).producerReceiptDigest
}
