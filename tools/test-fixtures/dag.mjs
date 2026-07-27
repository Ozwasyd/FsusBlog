/**
 * Deterministic producer DAG from sealed profile capability closure.
 * State-domain parallel conflicts reuse registry domain ids only (#1598/#1599);
 * no second conflict table is invented here.
 */

import {
  expandFixtureProfile,
  producersForCapabilities,
  readFixtureCatalogs
} from '../testing/fixture-catalog.mjs'

const STRATEGIES = new Set(['transaction-fixture', 'public-api-scenario', 'deterministic-generator'])

/**
 * @param {string} profileId
 * @param {object} [catalogs]
 * @returns {Readonly<{
 *   profileId: string,
 *   capabilities: readonly string[],
 *   producers: readonly object[],
 *   edges: readonly { from: string, to: string, capability: string }[],
 *   order: readonly string[],
 *   waves: readonly (readonly string[])[]
 * }>}
 */
export function buildProducerDag(profileId, catalogs = readFixtureCatalogs()) {
  if (profileId === 'none') {
    return Object.freeze({
      profileId: 'none',
      capabilities: Object.freeze([]),
      producers: Object.freeze([]),
      edges: Object.freeze([]),
      order: Object.freeze([]),
      waves: Object.freeze([])
    })
  }

  const expanded = expandFixtureProfile(profileId, catalogs)
  const capabilities = expanded.capabilities
  if (capabilities.length === 0) {
    return Object.freeze({
      profileId,
      capabilities: Object.freeze([]),
      producers: Object.freeze([]),
      edges: Object.freeze([]),
      order: Object.freeze([]),
      waves: Object.freeze([])
    })
  }

  const producerRecords = catalogs.producer.producers ?? []
  const byId = new Map(producerRecords.map((item) => [item.id, item]))
  const capabilityOwner = new Map(
    (catalogs.capability.capabilities ?? []).map((item) => [item.id, item.ownerProducerId])
  )

  // Capability → single owner (catalog authority). Fail closed on missing/duplicate owners.
  const selectedProducerIds = new Set()
  for (const capabilityId of capabilities) {
    const owners = producerRecords.filter((producer) => producer.provides.includes(capabilityId))
    if (owners.length === 0) {
      throw new Error(`fixture capability ${capabilityId} has no owner producer`)
    }
    if (owners.length !== 1) {
      throw new Error(
        `two producers provide the same capability ${capabilityId}: ${owners.map((item) => item.id).join(', ')}`
      )
    }
    const catalogOwner = capabilityOwner.get(capabilityId)
    if (catalogOwner && owners[0].id !== catalogOwner) {
      throw new Error(`capability ${capabilityId} owner mismatch: ${owners[0].id} vs ${catalogOwner}`)
    }
    selectedProducerIds.add(owners[0].id)
  }

  // Closure producers from producersForCapabilities must match owner-derived set.
  const listed = new Set(producersForCapabilities(capabilities, catalogs))
  for (const id of listed) {
    if (!selectedProducerIds.has(id)) selectedProducerIds.add(id)
  }
  for (const id of selectedProducerIds) {
    if (!byId.has(id)) throw new Error(`unknown fixture producer ${id}`)
  }

  const producers = [...selectedProducerIds]
    .map((id) => byId.get(id))
    .sort((left, right) => left.id.localeCompare(right.id))

  for (const producer of producers) {
    if (!STRATEGIES.has(producer.strategy)) {
      throw new Error(`producer ${producer.id} has invalid strategy ${producer.strategy}`)
    }
    if (!Array.isArray(producer.stateDomains) || producer.stateDomains.length === 0) {
      throw new Error(`producer ${producer.id} must declare state-domains`)
    }
    for (const capabilityId of producer.provides) {
      // Only selected capabilities matter for this plan, but producer must own them if selected.
      if (capabilities.includes(capabilityId) && capabilityOwner.get(capabilityId) !== producer.id) {
        throw new Error(`producer ${producer.id} is not catalog owner of ${capabilityId}`)
      }
    }
  }

  // Edges: consume capability → edge from owner(consume) to consumer producer.
  const providesIndex = new Map()
  for (const producer of producers) {
    for (const capabilityId of producer.provides) {
      if (!capabilities.includes(capabilityId) && !producer.consumes.includes(capabilityId)) {
        // Producer may provide extra capabilities not in profile; ignore for edges unless consumed.
      }
      if (!providesIndex.has(capabilityId)) providesIndex.set(capabilityId, [])
      providesIndex.get(capabilityId).push(producer.id)
    }
  }

  const edges = []
  const adjacency = new Map(producers.map((item) => [item.id, new Set()]))
  const indegree = new Map(producers.map((item) => [item.id, 0]))

  for (const producer of producers) {
    for (const capabilityId of producer.consumes ?? []) {
      const providers = providesIndex.get(capabilityId) ?? []
      // Prefer catalog owner; if the owner is not in this plan, fail closed.
      const owner = capabilityOwner.get(capabilityId)
      if (!owner || !selectedProducerIds.has(owner)) {
        // Consumed capability must be provided by its catalog owner in this plan.
        // Profile expansion pulls capability dependsOn; producer consumes still need the owner present.
        throw new Error(
          `producer ${producer.id} consumes ${capabilityId} but owner ${owner ?? '<missing>'} is not in the producer DAG`
        )
      }
      const from = owner
      const to = producer.id
      if (from === to) continue
      if (!adjacency.get(from).has(to)) {
        adjacency.get(from).add(to)
        indegree.set(to, indegree.get(to) + 1)
        edges.push({ from, to, capability: capabilityId })
      }
    }
  }

  // Kahn topo with deterministic tie-break by id.
  const queue = producers.map((item) => item.id).filter((id) => indegree.get(id) === 0).sort()
  const order = []
  const remaining = new Map(indegree)
  while (queue.length) {
    const id = queue.shift()
    order.push(id)
    const nextIds = [...adjacency.get(id)].sort()
    for (const next of nextIds) {
      remaining.set(next, remaining.get(next) - 1)
      if (remaining.get(next) === 0) {
        queue.push(next)
        queue.sort()
      }
    }
  }
  if (order.length !== producers.length) {
    const leftover = producers.map((item) => item.id).filter((id) => !order.includes(id)).sort()
    throw new Error(`fixture producer dependency cycle involving ${leftover.join(', ')}`)
  }

  // Waves: ready producers with disjoint stateDomains may share a wave.
  const producerById = new Map(producers.map((item) => [item.id, item]))
  const pending = new Set(order)
  const satisfied = new Set()
  const waves = []
  while (pending.size) {
    const ready = [...pending]
      .filter((id) => {
        const producer = producerById.get(id)
        return (producer.consumes ?? []).every((capabilityId) => {
          const owner = capabilityOwner.get(capabilityId)
          return !owner || satisfied.has(owner) || owner === id
        })
      })
      .sort()
    if (ready.length === 0) {
      throw new Error(`fixture producer DAG cannot schedule remaining ${[...pending].sort().join(', ')}`)
    }
    const wave = []
    const waveDomains = new Set()
    for (const id of ready) {
      const domains = producerById.get(id).stateDomains ?? []
      const conflicts = domains.some((domain) => waveDomains.has(domain))
      if (conflicts) {
        // Defer to a later wave; state-domain ids come from the registry authority.
        continue
      }
      wave.push(id)
      for (const domain of domains) waveDomains.add(domain)
    }
    if (wave.length === 0) {
      // All ready producers conflict on domains; serialize first ready id.
      wave.push(ready[0])
    }
    waves.push(Object.freeze([...wave]))
    for (const id of wave) {
      pending.delete(id)
      satisfied.add(id)
    }
  }

  return Object.freeze({
    profileId,
    capabilities: Object.freeze([...capabilities]),
    producers: Object.freeze(producers.map((item) => Object.freeze({
      id: item.id,
      strategy: item.strategy,
      provides: Object.freeze([...(item.provides ?? [])]),
      consumes: Object.freeze([...(item.consumes ?? [])]),
      stateDomains: Object.freeze([...(item.stateDomains ?? [])]),
      receiptPostconditions: Object.freeze([...(item.receiptPostconditions ?? [])]),
      implementationPaths: Object.freeze([...(item.implementationPaths ?? [])])
    }))),
    edges: Object.freeze(edges.map((edge) => Object.freeze({ ...edge }))),
    order: Object.freeze(order),
    waves: Object.freeze(waves)
  })
}

export function reverseTopo(order) {
  return Object.freeze([...(order ?? [])].reverse())
}
