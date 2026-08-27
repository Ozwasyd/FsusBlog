import assert from 'node:assert/strict'
import test from 'node:test'

import { digestCanonical } from '../../tools/test-fixtures/receipt/canonical.mjs'
import { observeRuntimeTopology } from '../../tools/test-fixtures/observers/runtime-topology.mjs'
import { digest, noSideEffects, runtimeIdentity } from './support/runtime-state-fixture.mjs'

const identity = runtimeIdentity()
const domain = 'runtime.backend-process'
const services = [{
  role: 'backend',
  ownerNamespace: 'runtime-a',
  runtimeKind: 'process',
  executableDigest: digest('backend-bin'),
  networkNamespace: 'network-a',
  endpoints: [{ role: 'public-api', protocol: 'https' }],
  resources: { cpuUnits: 2, memoryBytes: 1024, processLimit: 8 },
  readinessDigest: digest('ready'),
  liveness: 'live'
}, {
  role: 'postgres',
  ownerNamespace: 'runtime-a',
  runtimeKind: 'container',
  imageDigest: digest('postgres-image'),
  networkNamespace: 'network-a',
  endpoints: [{ role: 'database', protocol: 'postgresql' }],
  resources: { cpuUnits: 1, memoryBytes: 2048, processLimit: 32 },
  readinessDigest: digest('pg-ready'),
  liveness: 'live'
}]
const plannedTopology = { services }
const handle = {
  owner: { runId: identity.runId, attemptId: identity.attemptId, sessionId: identity.sessionId, domain },
  catalogDigest: identity.catalogDigest,
  namespace: 'runtime-a',
  plannedTopology,
  plannedTopologyDigest: digestCanonical(plannedTopology)
}

function context(actualServices = [...services].reverse(), diagnostics = { pidCount: 2, ephemeralPortCount: 2 }) {
  return {
    handles: { [domain]: handle },
    ports: {
      runtimeTopology: {
        readonly: true,
        async readOwnedTopology() { return { readonly: true, namespace: handle.namespace, plannedTopologyDigest: handle.plannedTopologyDigest, services: actualServices, diagnostics } },
        async readSideEffectCounters() { return noSideEffects() }
      }
    }
  }
}

test('topology observer is PID/port/order stable and binds semantic executable/network/resources', async () => {
  const first = await observeRuntimeTopology({ domain, identity, context: context() })
  const second = await observeRuntimeTopology({ domain, identity, context: context(services, { pidCount: 99, ephemeralPortCount: 99 }) })
  assert.equal(digestCanonical(first.semantic), digestCanonical(second.semantic))
  assert.equal(JSON.stringify(first.semantic).includes('pid'), false)
  assert.equal(JSON.stringify(first.semantic).includes('port'), false)
})

test('topology observer rejects missing/unowned/tag-only/readiness/resource drift', async () => {
  await assert.rejects(observeRuntimeTopology({ domain, identity, context: context(services.slice(0, 1)) }), /topology mismatch/)
  await assert.rejects(observeRuntimeTopology({ domain, identity, context: context([{ ...services[0], ownerNamespace: 'other' }, services[1]]) }), /unowned or cross-session/)
  await assert.rejects(observeRuntimeTopology({ domain, identity, context: context([{ ...services[0], executableDigest: digest('other') }, services[1]]) }), /topology mismatch/)
  await assert.rejects(observeRuntimeTopology({ domain, identity, context: context([{ ...services[0], liveness: 'dead' }, services[1]]) }), /not live/)
})
