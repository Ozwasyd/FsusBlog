/**
 * Default producer ports bound to catalog strategies and implementation paths.
 * Business data logic stays in existing modules; ports only invoke them.
 * Strategy is sealed from the producer registry — never from process.env.
 */

import path from 'node:path'
import { readFixtureCatalogs } from '../../testing/fixture-catalog.mjs'
import { buildProducerChildEnv, repositoryRoot, runProcess } from './spawn-helper.mjs'

function catalogProducer(id, catalogs = readFixtureCatalogs()) {
  const producer = (catalogs.producer.producers ?? []).find((item) => item.id === id)
  if (!producer) throw new Error(`catalog producer ${id} is missing`)
  return producer
}

function basePort(producer, handlers) {
  return {
    id: producer.id,
    strategy: producer.strategy,
    providedCapabilities: [...producer.provides],
    consumedCapabilities: [...producer.consumes],
    prepare: handlers.prepare,
    // Default verify fails closed without service observations (#1710).
    verify: handlers.verify ?? (async (_context, producerResult) => {
      if (producerResult?.observations || producerResult?.databaseObservation
        || producerResult?.redisObservation || producerResult?.cacheObservation) {
        return { ok: true, producerId: producer.id }
      }
      return {
        ok: false,
        producerId: producer.id,
        reason: 'producer verify missing database/redis/cache observations'
      }
    }),
    cleanup: handlers.cleanup ?? (async () => undefined)
  }
}

function assertNoStrategyEnv() {
  const banned = [
    'FSUSBLOG_FIXTURE_PRODUCER_STRATEGY',
    'FSUSBLOG_PUBLIC_FIXTURE_STRATEGY',
    'FSUSBLOG_FORCE_DIRECT_DB_SEED',
    'FSUSBLOG_FIXTURE_STRATEGY'
  ]
  for (const key of banned) {
    if (process.env[key]) {
      throw new Error(`producer strategy/env override ${key} is forbidden`)
    }
  }
}

export function createAuthSessionPort(catalogs = readFixtureCatalogs()) {
  const producer = catalogProducer('auth-session', catalogs)
  const script = path.join(repositoryRoot, 'tests/frontend/fixtures/prepare-auth-smoke-users.mjs')
  return basePort(producer, {
    async prepare(context, signal) {
      assertNoStrategyEnv()
      await runProcess(process.execPath, [script], {
        env: buildProducerChildEnv(context),
        signal
      })
      return {
        producerId: producer.id,
        strategy: producer.strategy,
        implementation: 'tests/frontend/fixtures/prepare-auth-smoke-users.mjs',
        postconditions: [...producer.receiptPostconditions]
      }
    },
    async cleanup() {
      // Auth fixture rows are namespace-owned; outer bootstrap owns DB drop.
    }
  })
}

export function createPublicContentPort(catalogs = readFixtureCatalogs()) {
  const producer = catalogProducer('public-content', catalogs)
  return basePort(producer, {
    async prepare(context, signal) {
      assertNoStrategyEnv()
      // transaction-fixture only (#1712): domain-port composition root, no API/DB fallback.
      const {
        preparePublicContent
      } = await import('./public-content-producer.mjs')
      const result = await preparePublicContent(context, signal)
      return {
        ...result,
        producerId: producer.id,
        strategy: producer.strategy,
        postconditions: [...producer.receiptPostconditions]
      }
    },
    async verify(context, producerReceipt) {
      const {
        verifyPublicContent
      } = await import('./public-content-producer.mjs')
      return verifyPublicContent(context, producerReceipt)
    },
    async cleanup(context, receipt, signal) {
      const {
        cleanupPublicContent
      } = await import('./public-content-producer.mjs')
      await cleanupPublicContent(context, receipt, signal)
    }
  })
}

export function createDevelopmentDemoPort(catalogs = readFixtureCatalogs()) {
  const producer = catalogProducer('development-demo', catalogs)
  const script = path.join(repositoryRoot, 'tools/dev/seed-demo-data.sh')
  return basePort(producer, {
    async prepare(context, signal) {
      assertNoStrategyEnv()
      await runProcess('bash', [script], {
        env: buildProducerChildEnv(context),
        signal
      })
      return {
        producerId: producer.id,
        strategy: producer.strategy,
        implementation: 'tools/dev/seed-demo-data.sh',
        postconditions: [...producer.receiptPostconditions]
      }
    }
  })
}

export function createScaleDataPort(catalogs = readFixtureCatalogs()) {
  const producer = catalogProducer('scale-data', catalogs)
  const script = path.join(repositoryRoot, 'tools/data-scale/seed.sh')
  const cleanupScript = path.join(repositoryRoot, 'tools/data-scale/cleanup.sh')
  return basePort(producer, {
    async prepare(context, signal) {
      assertNoStrategyEnv()
      const tier = context.handles?.scaleTier
        ?? context.plan?.profileIdentity?.profileId
        ?? 'scale-xs'
      await runProcess('bash', [script, tier], {
        env: buildProducerChildEnv(context),
        signal
      })
      return {
        producerId: producer.id,
        strategy: producer.strategy,
        implementation: 'tools/data-scale/seed.sh',
        scaleTier: tier,
        postconditions: [...producer.receiptPostconditions]
      }
    },
    async cleanup(context, receipt, signal) {
      const tier = receipt?.scaleTier
        ?? context.handles?.scaleTier
        ?? context.plan?.profileIdentity?.profileId
        ?? 'scale-xs'
      await runProcess('bash', [cleanupScript, tier], {
        env: buildProducerChildEnv(context),
        signal
      })
    }
  })
}

export function createSecurityStatePort(catalogs = readFixtureCatalogs()) {
  return createStructuralBusinessPort(catalogProducer('security-state', catalogs), 'securityStateAdapter')
}

function requireConsumedProducerOutputs(producer, context) {
  for (const capabilityId of producer.consumes ?? []) {
    const owner = context.plan?.producerSpecs?.find((item) => item.provides?.includes(capabilityId))?.id
      ?? Object.keys(context.producerOutputs ?? {}).find((id) => {
        const output = context.producerOutputs[id]
        return Array.isArray(output?.postconditions) || output?.producerId === id
      })
    // Prefer catalog owner from plan producerSpecs.
    const ownerFromPlan = (context.plan?.producerSpecs ?? []).find((item) => (item.provides ?? []).includes(capabilityId))?.id
    const resolvedOwner = ownerFromPlan ?? owner
    if (!resolvedOwner || !context.producerOutputs?.[resolvedOwner]) {
      throw new Error(
        `producer ${producer.id} requires consumed capability ${capabilityId} from ${resolvedOwner ?? '<missing owner>'} before prepare`
      )
    }
  }
}

/**
 * Structural port for producers whose business seed is owned by later issues / consumer tests.
 * Still runs through the unique orchestrator (no dual lifecycle), seals catalog strategy,
 * and enforces consume ordering — but does not invent SQL/API business rows (#1709 scope).
 * Callers may inject a real adapter via handles.<id>Adapter to replace the structural path.
 */
function createStructuralBusinessPort(producer, adapterHandleName) {
  return basePort(producer, {
    async prepare(context) {
      assertNoStrategyEnv()
      const adapter = context.handles?.[adapterHandleName]
      if (adapter && typeof adapter.prepare === 'function') {
        requireConsumedProducerOutputs(producer, context)
        const result = await adapter.prepare(context)
        return {
          producerId: producer.id,
          strategy: producer.strategy,
          implementation: `injected-${adapterHandleName}`,
          structuralOnly: false,
          ...(result && typeof result === 'object' ? result : {}),
          postconditions: [...producer.receiptPostconditions]
        }
      }
      requireConsumedProducerOutputs(producer, context)
      return {
        producerId: producer.id,
        strategy: producer.strategy,
        implementation: 'structural-port',
        structuralOnly: true,
        postconditions: [...producer.receiptPostconditions]
      }
    },
    async verify(context, producerReceipt) {
      // #1710: structural-only prepare cannot become verified evidence.
      if (producerReceipt?.structuralOnly === true) {
        return {
          ok: false,
          structuralOnly: true,
          producerId: producer.id,
          reason: 'business observations required before ProducerReceipt success (#1712+)'
        }
      }
      const adapter = context.handles?.[adapterHandleName]
      if (adapter && typeof adapter.verify === 'function') {
        return adapter.verify(context, producerReceipt)
      }
      // Without an injected adapter or observations, fail closed.
      if (!producerReceipt?.observations && !producerReceipt?.databaseObservation) {
        return {
          ok: false,
          producerId: producer.id,
          reason: 'producer verify missing database/redis/cache observations'
        }
      }
      return { ok: true, producerId: producer.id }
    },
    async cleanup(context, receipt, signal) {
      const adapter = context.handles?.[adapterHandleName]
      if (adapter && typeof adapter.cleanup === 'function') {
        await adapter.cleanup(context, receipt, signal)
      }
    }
  })
}

export function createAccountMessagingPort(catalogs = readFixtureCatalogs()) {
  return createStructuralBusinessPort(catalogProducer('account-messaging', catalogs), 'accountMessagingAdapter')
}

export function createCommentModerationPort(catalogs = readFixtureCatalogs()) {
  return createStructuralBusinessPort(catalogProducer('comment-moderation', catalogs), 'commentModerationAdapter')
}

/** Full default registry for catalog producers. */
export function createDefaultProducerPorts(catalogs = readFixtureCatalogs()) {
  return [
    createAuthSessionPort(catalogs),
    createPublicContentPort(catalogs),
    createDevelopmentDemoPort(catalogs),
    createScaleDataPort(catalogs),
    createSecurityStatePort(catalogs),
    createAccountMessagingPort(catalogs),
    createCommentModerationPort(catalogs)
  ]
}

/**
 * Ports required for a planned producer id list only.
 * Unknown catalog producers fail closed.
 */
export function createPortsForProducerIds(producerIds, catalogs = readFixtureCatalogs()) {
  const all = new Map(createDefaultProducerPorts(catalogs).map((port) => [port.id, port]))
  return producerIds.map((id) => {
    const port = all.get(id)
    if (!port) throw new Error(`no default port registered for producer ${id}`)
    return port
  })
}
