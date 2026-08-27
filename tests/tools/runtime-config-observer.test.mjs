import assert from 'node:assert/strict'
import test from 'node:test'

import { digestCanonical } from '../../tools/test-fixtures/receipt/canonical.mjs'
import { observeRuntimeConfig } from '../../tools/test-fixtures/observers/runtime-config.mjs'
import { digest, noSideEffects, runtimeIdentity } from './support/runtime-state-fixture.mjs'

const identity = runtimeIdentity()
const domain = 'fixture.runtime-config'
const plannedConfig = {
  schema: 'fsusblog.runtime-config.v1',
  namespace: 'runtime-a',
  requiredKeys: ['Mode', 'PublicOrigin'],
  values: { Mode: 'Production', PublicOrigin: 'loopback' },
  sources: { Mode: 'application-json', PublicOrigin: 'execution-envelope' },
  featuresDigest: digest('features'),
  policyDigest: digest('policy'),
  endpoints: [{ role: 'backend', protocol: 'https', hostAuthority: 'loopback' }],
  secrets: [{ secretClass: 'database-password', sourceOwner: 'secret-store', present: true, value: 'secret' }]
}
const handle = {
  owner: { runId: identity.runId, attemptId: identity.attemptId, sessionId: identity.sessionId, domain },
  catalogDigest: identity.catalogDigest,
  namespace: 'runtime-a',
  configReceiptDigest: digest('config-receipt'),
  plannedConfig
}

function context(actual = {}) {
  return {
    handles: { [domain]: handle },
    ports: {
      runtimeConfig: {
        readonly: true,
        async readResolvedConfig() { return { ...plannedConfig, readonly: true, envelopeDigest: identity.envelopeDigest, ...actual } },
        async readSideEffectCounters() { return noSideEffects() }
      }
    },
    protectedFingerprintKey: Buffer.alloc(32, 2),
    fingerprintScopeId: 'runtime-config-run'
  }
}

test('runtime config observer proves planned/actual exactness and redacts secrets', async () => {
  const first = await observeRuntimeConfig({ domain, identity, context: context() })
  const reordered = await observeRuntimeConfig({ domain, identity, context: context({ values: { PublicOrigin: 'loopback', Mode: 'Production' } }) })
  assert.equal(digestCanonical(first.semantic), digestCanonical(reordered.semantic))
  assert.equal(JSON.stringify(first).includes('"secret"'), false)
  assert.equal(first.metadata.ambientEnvironmentReads, 0)
})

test('runtime config observer rejects unknown/defaulted/source/policy/cross-envelope drift', async () => {
  await assert.rejects(observeRuntimeConfig({ domain, identity, context: context({ requiredKeys: ['Mode'], values: { Mode: 'Production' }, sources: { Mode: 'application-json' } }) }), /planned\/actual config mismatch/)
  await assert.rejects(observeRuntimeConfig({ domain, identity, context: context({ sources: { Mode: 'other', PublicOrigin: 'execution-envelope' } }) }), /mismatch at Mode/)
  await assert.rejects(observeRuntimeConfig({ domain, identity, context: context({ policyDigest: digest('other') }) }), /namespace\/policy/)
  await assert.rejects(observeRuntimeConfig({ domain, identity, context: context({ envelopeDigest: digest('other') }) }), /sealed envelope/)
})
