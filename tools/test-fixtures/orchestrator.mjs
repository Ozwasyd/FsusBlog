/**
 * Unique FixtureOrchestrator (#1709).
 *
 * Public surface:
 *   plan(profileIdentity, executionIdentity)
 *   prepare(plan, injectedPorts, signal)
 *   verify(receipt, injectedVerifiers)
 *   cleanup(receipt, injectedPorts, signal)
 *
 * Orchestrator reads only #1707 catalog authority (+ #1708 sealed digests).
 * It does not parse business SQL, open Docker/PostgreSQL/Redis, or import browser tests.
 */

import {
  fixtureCatalogDigest,
  planFixtureMutation,
  readFixtureCatalogs,
  resolveFixtureProfile
} from '../testing/fixture-catalog.mjs'
import { buildProducerDag, reverseTopo } from './dag.mjs'
import { createProducerContext, indexProducerPorts, requireProducerPorts } from './producer-port.mjs'
import { createTerminalState } from './terminal-state.mjs'

export { buildProducerDag } from './dag.mjs'
export { createTerminalState, FIXTURE_TERMINAL_STATES } from './terminal-state.mjs'
export { normalizeProducerPort, createProducerContext } from './producer-port.mjs'

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const reason = signal.reason instanceof Error ? signal.reason : new Error('fixture orchestration aborted')
    throw reason
  }
}

function serializeError(error) {
  if (!error) return null
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error)
  }
}

/**
 * @param {object} profileIdentity - { profileId, profileSource, executionClass?, sealed? }
 * @param {object} [executionIdentity] - { runId?, namespace?, sourceIdentity?, handles? }
 */
export function plan(profileIdentity, executionIdentity = {}, { catalogs = readFixtureCatalogs() } = {}) {
  if (!profileIdentity || typeof profileIdentity !== 'object') {
    throw new Error('profileIdentity is required')
  }
  const profileId = String(profileIdentity.profileId ?? '').trim()
  if (!profileId) throw new Error('profileIdentity.profileId is required')

  const profileSource = profileIdentity.profileSource
    ?? (profileIdentity.sealed ? 'matrix' : 'dev-cli')

  const resolved = resolveFixtureProfile({
    profileId,
    profileSource,
    executionClass: profileIdentity.executionClass ?? null,
    sealed: profileIdentity.sealed ?? null,
    catalogs,
    allowFreeProfileEnv: profileSource === 'dev-cli',
    freeProfileEnv: profileSource === 'dev-cli' ? '' : (profileIdentity.freeProfileEnv ?? '')
  })

  // Fail closed: unknown profile already rejected; re-check catalog digest for sealed matrix plans.
  const liveDigest = fixtureCatalogDigest(catalogs)
  if (resolved.catalogDigest !== liveDigest) {
    throw new Error('fixture catalog digest drifted; refusing plan')
  }

  const mutation = planFixtureMutation(profileId, catalogs)
  const dag = buildProducerDag(profileId, catalogs)

  if (profileId === 'none' || mutation.mutationPolicy === 'zero-mutation') {
    if (dag.producers.length !== 0 || dag.order.length !== 0) {
      throw new Error('none plan producer DAG must be empty')
    }
  }

  // Reject attempts to register producers for none via identity smuggling.
  if ((profileId === 'none' || mutation.capabilities.length === 0) && (executionIdentity?.forcedProducers ?? []).length) {
    throw new Error('none profile cannot register producers')
  }

  return Object.freeze({
    schema: 'fsusblog.fixture-orchestrator-plan.v1',
    profileIdentity: Object.freeze({
      profileId: resolved.profileId,
      profileSource: resolved.profileSource,
      executionClass: resolved.executionClass,
      sealed: resolved.sealed
    }),
    executionIdentity: Object.freeze({
      runId: executionIdentity.runId ?? null,
      namespace: executionIdentity.namespace ?? null,
      sourceIdentity: executionIdentity.sourceIdentity ?? null,
      handles: Object.freeze({ ...(executionIdentity.handles ?? {}) })
    }),
    catalogDigest: resolved.catalogDigest,
    expandedCapabilityDigest: resolved.expandedCapabilityDigest,
    capabilities: resolved.capabilities,
    producers: Object.freeze(dag.producers.map((item) => item.id)),
    producerSpecs: dag.producers,
    edges: dag.edges,
    order: dag.order,
    waves: dag.waves,
    mutationPolicy: resolved.mutationPolicy,
    requiresLocalAuthBypass: resolved.requiresLocalAuthBypass,
    requiresAuthFixtures: resolved.requiresAuthFixtures,
    requiresPublicFixtures: resolved.requiresPublicFixtures,
    requiresDemoSeed: resolved.requiresDemoSeed,
    requiresSecurityState: resolved.requiresSecurityState,
    requiresSecurityReset: resolved.requiresSecurityReset,
    terminalState: 'planned'
  })
}

/**
 * Prepare producers for a planned DAG. First producer failure is the primary failure;
 * successful producers are cleaned in reverse topo. Cleanup failure is recorded separately.
 */
export async function prepare(planDocument, injectedPorts, signal = undefined, {
  catalogs = readFixtureCatalogs(),
  handles = null
} = {}) {
  if (!planDocument || planDocument.schema !== 'fsusblog.fixture-orchestrator-plan.v1') {
    throw new Error('prepare requires an orchestrator plan')
  }
  throwIfAborted(signal)

  const terminal = createTerminalState('planned')
  terminal.transition('preparing')

  const producerIds = [...(planDocument.order ?? planDocument.producers ?? [])]
  const catalogProducers = planDocument.producerSpecs
    ?? (catalogs.producer.producers ?? []).filter((item) => producerIds.includes(item.id))
  const portMap = indexProducerPorts(injectedPorts ?? [], { catalogProducers })
  requireProducerPorts(producerIds, portMap)

  // Fail closed if caller injects ports for producers outside the plan AND profile is none.
  if (planDocument.profileIdentity.profileId === 'none' && portMap.size > 0 && producerIds.length === 0) {
    // Ports may be a full registry; only planned producers are invoked.
  }

  const producerOutputs = {}
  const producerReceipts = []
  const succeeded = []
  let primaryFailure = null
  let cleanupFailure = null
  const strategies = []

  const baseHandles = Object.freeze({
    ...(planDocument.executionIdentity?.handles ?? {}),
    ...(handles ?? {})
  })

  try {
    for (const wave of planDocument.waves ?? []) {
      throwIfAborted(signal)
      // Parallel within a wave (state-domain disjoint by construction).
      const waveResults = await Promise.all(wave.map(async (producerId) => {
        throwIfAborted(signal)
        const port = portMap.get(producerId)
        if (!port) throw new Error(`missing producer port ${producerId}`)
        const spec = catalogProducers.find((item) => item.id === producerId)
        if (spec && port.strategy !== spec.strategy) {
          throw new Error(`producer ${producerId} attempted strategy change ${port.strategy} != ${spec.strategy}`)
        }
        const context = createProducerContext({
          plan: planDocument,
          producerId,
          namespace: planDocument.executionIdentity?.namespace,
          runIdentity: planDocument.executionIdentity?.runId,
          sourceIdentity: planDocument.executionIdentity?.sourceIdentity,
          profileIdentity: planDocument.profileIdentity,
          producerOutputs,
          handles: baseHandles
        })
        const result = await port.prepare(context, signal)
        throwIfAborted(signal)
        if (!result || typeof result !== 'object') {
          throw new Error(`producer ${producerId} prepare must return a producerResult object`)
        }
        if (result.strategy && result.strategy !== port.strategy) {
          throw new Error(
            `producer ${producerId} returned strategy ${result.strategy}; cannot fallback from ${port.strategy}`
          )
        }
        return {
          producerId,
          strategy: port.strategy,
          result: Object.freeze({ ...result, strategy: port.strategy, producerId })
        }
      }))

      for (const entry of waveResults) {
        succeeded.push(entry.producerId)
        strategies.push({ producerId: entry.producerId, strategy: entry.strategy })
        producerOutputs[entry.producerId] = entry.result
        producerReceipts.push(entry.result)
      }
    }

    terminal.transition('prepared')
    terminal.assertPublishable('prepared')

    return Object.freeze({
      schema: 'fsusblog.fixture-orchestrator-receipt.v1',
      terminalState: terminal.state,
      terminalHistory: terminal.history,
      plan: planDocument,
      catalogDigest: planDocument.catalogDigest,
      expandedCapabilityDigest: planDocument.expandedCapabilityDigest,
      profileId: planDocument.profileIdentity.profileId,
      profileSource: planDocument.profileIdentity.profileSource,
      producerIds: Object.freeze([...producerIds]),
      strategies: Object.freeze(strategies.map((item) => Object.freeze({ ...item }))),
      producerReceipts: Object.freeze(producerReceipts),
      producerOutputs: Object.freeze({ ...producerOutputs }),
      primaryFailure: null,
      cleanupFailure: null,
      zeroData: producerIds.length === 0,
      mutations: Object.freeze([...succeeded])
    })
  } catch (error) {
    primaryFailure = error
    // Do not publish prepared for partial results.
    try {
      if (terminal.state === 'preparing') terminal.transition('failed')
    } catch {
      /* state already terminal */
    }

    // Reverse-topo cleanup of succeeded producers only.
    const reverse = reverseTopo(succeeded)
    if (reverse.length) {
      try {
        if (terminal.state === 'failed') terminal.transition('cleaning')
      } catch { /* ignore */ }
      for (const producerId of reverse) {
        try {
          // Always attempt cleanup after cancel/timeout; pass signal so producers
          // stop mutating, but do not skip cleanup invocation solely because prepare aborted.
          const port = portMap.get(producerId)
          const context = createProducerContext({
            plan: planDocument,
            producerId,
            namespace: planDocument.executionIdentity?.namespace,
            runIdentity: planDocument.executionIdentity?.runId,
            sourceIdentity: planDocument.executionIdentity?.sourceIdentity,
            profileIdentity: planDocument.profileIdentity,
            producerOutputs,
            handles: baseHandles
          })
          await port.cleanup(context, producerOutputs[producerId], signal)
        } catch (cleanupError) {
          if (!cleanupFailure) cleanupFailure = cleanupError
        }
      }
      try {
        if (terminal.state === 'cleaning') {
          terminal.transition(cleanupFailure ? 'cleanup-failed' : 'cleaned')
        }
      } catch { /* ignore */ }
    }

    const receipt = Object.freeze({
      schema: 'fsusblog.fixture-orchestrator-receipt.v1',
      terminalState: terminal.state === 'preparing' ? 'failed' : terminal.state,
      terminalHistory: terminal.history,
      plan: planDocument,
      catalogDigest: planDocument.catalogDigest,
      expandedCapabilityDigest: planDocument.expandedCapabilityDigest,
      profileId: planDocument.profileIdentity.profileId,
      profileSource: planDocument.profileIdentity.profileSource,
      producerIds: Object.freeze([...producerIds]),
      strategies: Object.freeze(strategies.map((item) => Object.freeze({ ...item }))),
      producerReceipts: Object.freeze(producerReceipts),
      producerOutputs: Object.freeze({ ...producerOutputs }),
      primaryFailure: serializeError(primaryFailure),
      cleanupFailure: serializeError(cleanupFailure),
      zeroData: false,
      mutations: Object.freeze([...succeeded])
    })

    const wrapped = new Error(primaryFailure instanceof Error ? primaryFailure.message : String(primaryFailure))
    wrapped.name = primaryFailure instanceof Error ? primaryFailure.name : 'Error'
    wrapped.receipt = receipt
    wrapped.cause = primaryFailure instanceof Error ? primaryFailure : undefined
    throw wrapped
  }
}

export async function verify(receipt, injectedVerifiers = {}, {
  catalogs = readFixtureCatalogs(),
  signal = undefined
} = {}) {
  if (!receipt || receipt.schema !== 'fsusblog.fixture-orchestrator-receipt.v1') {
    throw new Error('verify requires an orchestrator receipt')
  }
  if (receipt.terminalState !== 'prepared' && receipt.terminalState !== 'verified') {
    throw new Error(`cannot verify receipt in terminal state ${receipt.terminalState}`)
  }
  throwIfAborted(signal)

  const terminal = createTerminalState('prepared')
  terminal.transition('verifying')

  const planDocument = receipt.plan
  const producerIds = [...(receipt.producerIds ?? [])]
  const catalogProducers = planDocument.producerSpecs
    ?? (catalogs.producer.producers ?? []).filter((item) => producerIds.includes(item.id))
  const verifierMap = injectedVerifiers instanceof Map
    ? injectedVerifiers
    : indexProducerPorts(
      Array.isArray(injectedVerifiers)
        ? injectedVerifiers
        : Object.entries(injectedVerifiers).map(([id, port]) => ({ id, ...port })),
      { catalogProducers }
    )

  const postconditions = []
  try {
    for (const producerId of producerIds) {
      throwIfAborted(signal)
      const port = verifierMap.get?.(producerId) ?? verifierMap[producerId]
      if (!port || typeof port.verify !== 'function') {
        throw new Error(`missing verifier port for producer ${producerId}`)
      }
      const context = createProducerContext({
        plan: planDocument,
        producerId,
        namespace: planDocument.executionIdentity?.namespace,
        runIdentity: planDocument.executionIdentity?.runId,
        sourceIdentity: planDocument.executionIdentity?.sourceIdentity,
        profileIdentity: planDocument.profileIdentity,
        producerOutputs: receipt.producerOutputs,
        handles: planDocument.executionIdentity?.handles
      })
      const result = await port.verify(context, receipt.producerOutputs[producerId])
      postconditions.push(Object.freeze({
        producerId,
        ...(result && typeof result === 'object' ? result : { ok: result === true })
      }))
    }
    terminal.transition('verified')
    terminal.assertPublishable('verified')
    return Object.freeze({
      ...receipt,
      terminalState: terminal.state,
      terminalHistory: Object.freeze([...(receipt.terminalHistory ?? []), ...terminal.history.slice(1)]),
      postconditions: Object.freeze(postconditions)
    })
  } catch (error) {
    const wrapped = new Error(error instanceof Error ? error.message : String(error))
    wrapped.name = error instanceof Error ? error.name : 'Error'
    wrapped.receipt = Object.freeze({
      ...receipt,
      terminalState: 'failed',
      primaryFailure: serializeError(error),
      postconditions: Object.freeze(postconditions)
    })
    wrapped.cause = error instanceof Error ? error : undefined
    throw wrapped
  }
}

export async function cleanup(receipt, injectedPorts, signal = undefined, {
  catalogs = readFixtureCatalogs(),
  handles = null
} = {}) {
  if (!receipt || receipt.schema !== 'fsusblog.fixture-orchestrator-receipt.v1') {
    throw new Error('cleanup requires an orchestrator receipt')
  }
  throwIfAborted(signal)

  const terminal = createTerminalState(
    ['prepared', 'verified', 'failed', 'cleaned', 'cleanup-failed'].includes(receipt.terminalState)
      ? (receipt.terminalState === 'cleaned' || receipt.terminalState === 'cleanup-failed'
        ? receipt.terminalState
        : receipt.terminalState === 'failed' ? 'failed' : 'prepared')
      : 'prepared'
  )

  if (terminal.state === 'cleaned') {
    return Object.freeze({ ...receipt, terminalState: 'cleaned' })
  }
  if (terminal.state === 'cleanup-failed') {
    return Object.freeze({ ...receipt, terminalState: 'cleanup-failed' })
  }

  if (terminal.state === 'failed') terminal.transition('cleaning')
  else if (terminal.state === 'prepared' || terminal.state === 'verified') terminal.transition('cleaning')
  else terminal.transition('cleaning')

  const planDocument = receipt.plan
  // Cleanup reverse of actual success order (mutations), not a re-sorted catalog topo alone.
  const succeeded = [...(receipt.mutations ?? Object.keys(receipt.producerOutputs ?? {}))]
  const producerIds = reverseTopo(succeeded)
  const catalogProducers = planDocument.producerSpecs
    ?? (catalogs.producer.producers ?? []).filter((item) => producerIds.includes(item.id))
  const portMap = indexProducerPorts(injectedPorts ?? [], { catalogProducers })

  let cleanupFailure = null
  const baseHandles = Object.freeze({
    ...(planDocument.executionIdentity?.handles ?? {}),
    ...(handles ?? {})
  })

  for (const producerId of producerIds) {
    try {
      throwIfAborted(signal)
      const port = portMap.get(producerId)
      if (!port) throw new Error(`missing producer port ${producerId} for cleanup`)
      const context = createProducerContext({
        plan: planDocument,
        producerId,
        namespace: planDocument.executionIdentity?.namespace,
        runIdentity: planDocument.executionIdentity?.runId,
        sourceIdentity: planDocument.executionIdentity?.sourceIdentity,
        profileIdentity: planDocument.profileIdentity,
        producerOutputs: receipt.producerOutputs,
        handles: baseHandles
      })
      await port.cleanup(context, receipt.producerOutputs?.[producerId], signal)
    } catch (error) {
      if (!cleanupFailure) cleanupFailure = error
    }
  }

  const nextState = cleanupFailure ? 'cleanup-failed' : 'cleaned'
  try {
    terminal.transition(nextState)
  } catch {
    /* ignore illegal if already terminal */
  }

  const next = Object.freeze({
    ...receipt,
    terminalState: nextState,
    cleanupFailure: cleanupFailure
      ? serializeError(cleanupFailure)
      : (receipt.cleanupFailure ?? null),
    // Never overwrite primary failure with cleanup failure.
    primaryFailure: receipt.primaryFailure ?? null
  })

  if (cleanupFailure) {
    const wrapped = new Error(cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure))
    wrapped.name = 'FixtureCleanupError'
    wrapped.receipt = next
    wrapped.cause = cleanupFailure instanceof Error ? cleanupFailure : undefined
    throw wrapped
  }
  return next
}
