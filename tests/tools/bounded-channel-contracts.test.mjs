import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  defaultCatalogPath,
  deliveryCatalogDigest,
  discoverBoundedChannels,
  queueDispositionReport,
  validateBoundedChannelCatalog
} from '../../tools/governance/bounded-channel-contracts.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function catalog() {
  return JSON.parse(fs.readFileSync(defaultCatalogPath, 'utf8'))
}

function mutate(change) {
  const value = catalog()
  change(value)
  value.digest = deliveryCatalogDigest(value.queues)
  return validateBoundedChannelCatalog(defaultCatalogPath, { catalog: value })
}

test('discovers direct, wrapped, and indirect bounded channel owners', () => {
  const file = 'src/Fixture.cs'
  const discovered = discoverBoundedChannels({ sources: new Map([[file, `
using System.Threading.Channels;
sealed class Fixture {
  Channel<int> direct = Channel.CreateBounded<int>(1);
  Channel<int> wrapped;
  Channel<int> indirect;
  Fixture() { wrapped = Inner(); indirect = Outer(); }
  private static Channel<int> Inner() => Channel.CreateBounded<int>(2);
  private static Channel<int> Outer() => Inner();
}
`]]) })
  assert.deepEqual(discovered.map((item) => [item.target, item.creationKind]), [
    ['direct', 'direct'],
    ['indirect', 'indirect'],
    ['wrapped', 'wrapped']
  ])
})

test('catalog is bidirectionally exact and emits successor dispositions', () => {
  assert.deepEqual(validateBoundedChannelCatalog(), [])
  const report = queueDispositionReport()
  assert.equal(report.length, discoverBoundedChannels().length)
  assert.ok(report.every((entry) => entry.disposition && entry.implementationOwner))
})

test('rejects missing, extra, duplicate queue IDs, discovery keys, and owners', () => {
  assert.match(mutate((value) => value.queues.pop()).join('\n'), /missing from catalog/u)
  assert.match(mutate((value) => value.queues.push({ ...value.queues[0], queueId: 'orphan', discoveryKey: 'src/missing.cs#Missing.queue', owner: { ...value.queues[0].owner, id: 'orphan' } })).join('\n'), /orphan catalog queue/u)
  assert.match(mutate((value) => { value.queues[1].queueId = value.queues[0].queueId }).join('\n'), /duplicate queue ID/u)
  assert.match(mutate((value) => { value.queues[1].discoveryKey = value.queues[0].discoveryKey }).join('\n'), /duplicate discovery key/u)
  assert.match(mutate((value) => { value.queues[1].owner.id = value.queues[0].owner.id }).join('\n'), /duplicate owner/u)
})

test('rejects unknown owner and delivery class', () => {
  assert.match(mutate((value) => { value.queues[0].owner.type = 'UnknownOwner' }).join('\n'), /owner does not match/u)
  assert.match(mutate((value) => { value.queues[0].deliveryClass = 'unknown' }).join('\n'), /unknown delivery class/u)
})

test('loaded schema rejects missing fields and additional properties', () => {
  assert.match(mutate((value) => { delete value.queues[0].failureSemantics }).join('\n'), /missing required property failureSemantics/u)
  assert.match(mutate((value) => { value.queues[0].wildcardSuppression = '*' }).join('\n'), /additional property wildcardSuppression/u)
})

test('rejects incomplete class-specific proofs', () => {
  assert.match(mutate((value) => { delete value.queues.find((queue) => queue.deliveryClass === 'required').classProof.durableSource }).join('\n'), /durableSource/u)
  assert.match(mutate((value) => { delete value.queues.find((queue) => queue.deliveryClass === 'required').classProof.replaySource }).join('\n'), /replaySource/u)
  assert.match(mutate((value) => { delete value.queues.find((queue) => queue.deliveryClass === 'best-effort').classProof.productProof }).join('\n'), /productProof/u)
  assert.match(mutate((value) => { delete value.queues.find((queue) => queue.deliveryClass === 'coalescible').classProof.commutativeProof }).join('\n'), /commutativeProof/u)
  assert.match(mutate((value) => { delete value.queues.find((queue) => queue.deliveryClass === 'coalescible').classProof.monotonicProof }).join('\n'), /monotonicProof/u)
  assert.match(mutate((value) => { delete value.queues.find((queue) => queue.deliveryClass === 'replayable').classProof.executableSource }).join('\n'), /executableSource/u)
  assert.match(mutate((value) => { delete value.queues.find((queue) => queue.deliveryClass === 'replayable').classProof.postcondition }).join('\n'), /postcondition/u)
})

test('best-effort product proof cannot waive protected semantics', () => {
  assert.match(mutate((value) => { value.queues.find((queue) => queue.deliveryClass === 'best-effort').classProof.impact = 'security audit may be lost' }).join('\n'), /cannot waive security/u)
})

test('Wait plus TryWrite requires an explicit disposition', () => {
  assert.match(mutate((value) => { delete value.queues.find((queue) => queue.channelBehavior.fullMode === 'Wait' && queue.channelBehavior.writerPrimitive.includes('TryWrite')).channelBehavior.waitTryWriteDisposition }).join('\n'), /Wait plus TryWrite must be explained/u)
})

test('a newly discovered bounded channel fails closed until cataloged', () => {
  const discovered = discoverBoundedChannels()
  discovered.push({ discoveryKey: 'src/backend/FutureQueue.cs#FutureQueue._channel', file: 'src/backend/FutureQueue.cs', ownerType: 'FutureQueue', target: '_channel', creationKind: 'direct', factory: null, line: 4 })
  assert.match(validateBoundedChannelCatalog(defaultCatalogPath, { discovered }).join('\n'), /missing from catalog: .*FutureQueue/u)
})

test('PublicHot references authoritative contracts without copied authority', () => {
  assert.match(mutate((value) => { value.queues.find((queue) => queue.owner.type === 'PublicHotArtifactUpdateQueue').copiedAuthority = { rule: 'local copy' } }).join('\n'), /must not copy/u)
  assert.match(mutate((value) => { value.queues.find((queue) => queue.owner.type === 'PublicHotArtifactUpdateQueue').authoritativeContracts.pop() }).join('\n'), /#1629-#1631 exactly/u)
})

test('stable ordering and digest reject reorder or content drift', () => {
  const value = catalog()
  value.queues.reverse()
  assert.match(validateBoundedChannelCatalog(defaultCatalogPath, { catalog: value }).join('\n'), /stable queueId ordering/u)
  const clean = catalog()
  clean.queues[0].disposition += '-drift'
  assert.match(validateBoundedChannelCatalog(defaultCatalogPath, { catalog: clean }).join('\n'), /digest does not match/u)
})

test('published JSON schema owns the catalog shape', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'config/testing/bounded-channel-delivery-contracts.schema.json'), 'utf8'))
  assert.equal(schema.$id, 'https://fsus.blog/schemas/testing/bounded-channel-delivery-contracts.schema.json')
  assert.deepEqual(schema.properties.queues.items.properties.deliveryClass.enum, ['required', 'best-effort', 'coalescible', 'replayable'])
})
