import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'

import { digestCanonical } from '../../tools/test-fixtures/receipt/canonical.mjs'
import { observeObjectStorage } from '../../tools/test-fixtures/observers/object-storage.mjs'
import { noSideEffects, runtimeIdentity } from './support/runtime-state-fixture.mjs'

const identity = runtimeIdentity()
const domain = 'storage.fixture-objects'
const handle = {
  owner: { runId: identity.runId, attemptId: identity.attemptId, sessionId: identity.sessionId, domain },
  catalogDigest: identity.catalogDigest,
  namespaceClass: 'fixture-session',
  namespaceId: 'objects-a',
  providerId: 'memory-provider',
  expectedObjects: [{ key: 'covers/a.svg', required: true }, { key: 'covers/b.svg', required: true }]
}

function context(order = ['covers/a.svg', 'covers/b.svg'], bytes = {}) {
  return {
    handles: { [domain]: handle },
    ports: {
      objectStorage: {
        readonly: true,
        async *listObjects() {
          yield {
            complete: true,
            objects: order.map((key) => ({ key, state: 'active', mediaType: 'image/svg+xml', generation: 'g1', version: 'v1' }))
          }
        },
        async openRead({ key }) { return Readable.from([Buffer.from(bytes[key] ?? key)]) },
        async readSideEffectCounters() { return noSideEffects() }
      }
    }
  }
}

test('object observer is pagination/order stable and content/generation sensitive', async () => {
  const first = await observeObjectStorage({ domain, identity, context: context() })
  const reordered = await observeObjectStorage({ domain, identity, context: context(['covers/b.svg', 'covers/a.svg']) })
  assert.equal(digestCanonical(first.semantic), digestCanonical(reordered.semantic))
  const changed = await observeObjectStorage({ domain, identity, context: context(undefined, { 'covers/a.svg': 'changed' }) })
  assert.notEqual(digestCanonical(first.semantic), digestCanonical(changed.semantic))
  assert.equal(JSON.stringify(first).includes('covers/a.svgcovers/a.svg'), false)
})

test('object observer rejects missing/extra/partial/cross-session and provider writes', async () => {
  await assert.rejects(observeObjectStorage({ domain, identity, context: context(['covers/a.svg']) }), /omitted expected/)
  await assert.rejects(observeObjectStorage({ domain, identity, context: context(['covers/a.svg', 'covers/b.svg', 'extra']) }), /unexpected object/)
  const partial = context()
  partial.ports.objectStorage.listObjects = async function * () { yield { complete: false, objects: [] } }
  await assert.rejects(observeObjectStorage({ domain, identity, context: partial }), /partial pagination/)
  await assert.rejects(observeObjectStorage({ domain, identity: runtimeIdentity({ sessionId: 'other' }), context: context() }), /cross-session/)
})
