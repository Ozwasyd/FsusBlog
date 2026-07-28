/** Narrow producer port contract for FixtureOrchestrator (#1709). */

import { buildProducerFixtureVariantPlan } from '../testing/fixture-catalog.mjs'

const STRATEGIES = new Set(['transaction-fixture', 'public-api-scenario', 'deterministic-generator'])

/**
 * Validate and freeze a producer port. Strategy is sealed at registration; ports
 * must not consult arbitrary process.env to change capability or strategy.
 */
export function normalizeProducerPort(port, { catalogProducer = null } = {}) {
  if (!port || typeof port !== 'object') throw new Error('producer port is required')
  const id = String(port.id ?? '').trim()
  if (!id) throw new Error('producer port id is required')
  const strategy = String(port.strategy ?? '').trim()
  if (!STRATEGIES.has(strategy)) {
    throw new Error(`producer ${id} has invalid strategy ${strategy || '<missing>'}`)
  }
  if (catalogProducer) {
    if (catalogProducer.id !== id) {
      throw new Error(`producer port id ${id} does not match catalog ${catalogProducer.id}`)
    }
    if (catalogProducer.strategy !== strategy) {
      throw new Error(
        `producer ${id} strategy ${strategy} does not match catalog ${catalogProducer.strategy}; strategy cannot be overridden`
      )
    }
  }
  if (typeof port.prepare !== 'function') throw new Error(`producer ${id} prepare(context, signal) is required`)
  if (typeof port.verify !== 'function') throw new Error(`producer ${id} verify(context, producerReceipt) is required`)
  if (typeof port.cleanup !== 'function') throw new Error(`producer ${id} cleanup(context, producerReceipt, signal) is required`)

  const providedCapabilities = freezeStringList(port.providedCapabilities ?? port.provides, `producer ${id} providedCapabilities`)
  const consumedCapabilities = freezeStringList(port.consumedCapabilities ?? port.consumes, `producer ${id} consumedCapabilities`)
  if (catalogProducer) {
    assertSameSet(providedCapabilities, catalogProducer.provides, `producer ${id} providedCapabilities`)
    assertSameSet(consumedCapabilities, catalogProducer.consumes, `producer ${id} consumedCapabilities`)
  }

  return Object.freeze({
    id,
    strategy,
    providedCapabilities,
    consumedCapabilities,
    prepare: port.prepare.bind(port),
    verify: port.verify.bind(port),
    cleanup: port.cleanup.bind(port)
  })
}

export function indexProducerPorts(ports, { catalogProducers = [] } = {}) {
  if (!Array.isArray(ports)) throw new Error('injected producer ports must be an array')
  const byCatalog = new Map((catalogProducers ?? []).map((item) => [item.id, item]))
  const map = new Map()
  for (const port of ports) {
    const catalogProducer = byCatalog.get(port?.id) ?? null
    const normalized = normalizeProducerPort(port, { catalogProducer })
    if (map.has(normalized.id)) {
      throw new Error(`duplicate producer port registration for ${normalized.id}`)
    }
    map.set(normalized.id, normalized)
  }
  return map
}

export function requireProducerPorts(producerIds, portMap) {
  const missing = producerIds.filter((id) => !portMap.has(id))
  if (missing.length) {
    throw new Error(`missing producer ports for planned producers: ${missing.sort().join(', ')}`)
  }
  const unknown = [...portMap.keys()].filter((id) => !producerIds.includes(id))
  // Extra unused ports are allowed for shared registries; unknown planned is not.
  return unknown
}

function freezeStringList(values, label) {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`)
  const list = values.map((value) => String(value))
  if (list.some((value, index) => !value || (index > 0 && list[index - 1] >= value))) {
    // Catalog requires sorted unique; ports must match.
    const sorted = [...new Set(list)].sort()
    if (JSON.stringify(sorted) !== JSON.stringify(list)) {
      throw new Error(`${label} must be sorted and unique stable IDs`)
    }
  }
  return Object.freeze([...list])
}

function assertSameSet(actual, expected, label) {
  const left = [...actual].sort()
  const right = [...(expected ?? [])].sort()
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(`${label} must match catalog exactly`)
  }
}

/**
 * Build a frozen producer context. Producers receive handles via context only;
 * they must not invent capability/strategy from ambient env.
 */
export function createProducerContext({
  plan,
  producerId,
  ports = null,
  namespace = null,
  runIdentity = null,
  sourceIdentity = null,
  profileIdentity = null,
  producerOutputs = null,
  handles = null,
  catalogs = undefined,
  previousProducerReceipt = null,
  temporalContext = null
} = {}) {
  const producerVariantIds = (plan?.variantPlan?.byProducer
    ?.find((item) => item.producerId === producerId)?.variants ?? [])
    .map((item) => item.id)
  const variantPlan = buildProducerFixtureVariantPlan({
    producerId,
    variantIds: producerVariantIds,
    fixtureVariantIds: plan?.variantIds,
    fixtureVariantPlanDigest: plan?.variantPlanDigest,
    ...(catalogs ? { catalogs } : {})
  })
  return Object.freeze({
    plan,
    producerId,
    namespace: namespace ?? plan?.executionIdentity?.namespace ?? null,
    runIdentity: runIdentity ?? plan?.executionIdentity?.runId ?? null,
    sourceIdentity: sourceIdentity ?? plan?.executionIdentity?.sourceIdentity ?? null,
    profileIdentity: profileIdentity ?? plan?.profileIdentity ?? null,
    variantPlan,
    producerOutputs: Object.freeze({ ...(producerOutputs ?? {}) }),
    handles: Object.freeze({ ...(handles ?? {}) }),
    previousProducerReceipt,
    temporalContext,
    ports: ports ?? null
  })
}
