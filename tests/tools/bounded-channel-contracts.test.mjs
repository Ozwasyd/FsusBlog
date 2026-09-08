import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  buildBoundedQueueAcceptanceReceipt,
  defaultCatalogPath,
  deliveryCatalogDigest,
  discoverBoundedChannels,
  discoverUnboundedChannels,
  queueDispositionReport,
  validateBoundedChannelCatalog,
  verifyBoundedQueueAcceptanceReceipt
} from '../../tools/governance/bounded-channel-contracts.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
let discoveredCatalogQueues = null

function catalog() {
  return JSON.parse(fs.readFileSync(defaultCatalogPath, 'utf8'))
}

function currentDiscovery() {
  discoveredCatalogQueues ??= discoverBoundedChannels()
  return discoveredCatalogQueues
}

function mutate(change) {
  const value = catalog()
  change(value)
  value.digest = deliveryCatalogDigest(value.queues)
  return validateBoundedChannelCatalog(defaultCatalogPath, { catalog: value, discovered: currentDiscovery() })
}

test('discovers direct, wrapped, and indirect bounded channel owners', () => {
  const file = 'src/Fixture.cs'
  const discovered = discoverBoundedChannels({ sources: new Map([[file, `
using System.Threading.Channels;
sealed class Fixture {
  private const string RawExample = """Channel.CreateBounded<int>(1)""";
  private const string VerbatimExample = @"Channel.CreateBounded<int>(1)";
  private const string InterpolatedExample = $"Channel.CreateBounded<int>({1})";
  // Channel<int> commented = Channel.CreateBounded<int>(1);
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

test('discovers unbounded channels after masking comments and literals', () => {
  const file = 'src/Fixture.cs'
  const discovered = discoverUnboundedChannels({ sources: new Map([[file, `
const string text = "Channel.CreateUnbounded<int>()";
// Channel.CreateUnbounded<int>();
Channel<int> actual = Channel.CreateUnbounded<int>();
`]]) })
  assert.deepEqual(discovered, [{ file, line: 4 }])
})

test('catalog is bidirectionally exact and emits successor dispositions', () => {
  assert.deepEqual(validateBoundedChannelCatalog(defaultCatalogPath, { discovered: currentDiscovery() }), [])
  const report = queueDispositionReport()
  assert.equal(report.length, currentDiscovery().length)
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
  assert.match(mutate((value) => { delete value.queues[0].failureSemantics }).join('\n'), /required property 'failureSemantics'/u)
  assert.match(mutate((value) => { value.queues[0].wildcardSuppression = '*' }).join('\n'), /additional properties/u)
  assert.match(mutate((value) => { value.queues[0].classProof.wildcardSuppression = '*' }).join('\n'), /additional properties|oneOf/u)
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

test('drain participant adapters must implement and register the exact wrapper', () => {
  assert.match(mutate((value) => { value.queues[0].participantAdapter.token = 'UnregisteredAdapter' }).join('\n'), /participantAdapter token|participantAdapter is not registered/u)
  assert.match(mutate((value) => { value.queues[0].participantAdapter.file = 'src/backend/Infrastructure/Operations/ReleaseDrainParticipants.cs' }).join('\n'), /participantAdapter token|participantAdapter is not registered/u)
})

test('writer primitive mutations fail closed instead of becoming universal WriteAsync', () => {
  assert.match(mutate((value) => {
    value.queues.find((queue) => queue.channelBehavior.writerPrimitive.includes('TryWrite')).channelBehavior.writerPrimitive = 'WriteAsync'
  }).join('\n'), /writer primitive does not match/u)
})

test('protected audit and security queues cannot be downgraded to warning-only best effort', () => {
  assert.match(mutate((value) => {
    const target = value.queues.find((queue) => /audit|security|risk|challenge/iu.test(`${queue.queueId} ${queue.owner.type}`))
    const bestEffort = value.queues.find((queue) => queue.deliveryClass === 'best-effort')
    target.deliveryClass = 'best-effort'
    target.classProof = structuredClone(bestEffort.classProof)
  }).join('\n'), /protected audit\/security queue cannot be best-effort/u)
})

test('a newly discovered bounded channel fails closed until cataloged', () => {
  const discovered = [...currentDiscovery()]
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
  assert.match(validateBoundedChannelCatalog(defaultCatalogPath, { catalog: value, discovered: currentDiscovery() }).join('\n'), /stable queueId ordering/u)
  const clean = catalog()
  clean.queues[0].disposition += '-drift'
  assert.match(validateBoundedChannelCatalog(defaultCatalogPath, { catalog: clean, discovered: currentDiscovery() }).join('\n'), /digest does not match/u)
})

test('terminal receipt binds current source, catalog, aggregate, matrix, mutations, and zero warnings', () => {
  const receipt = buildBoundedQueueAcceptanceReceipt()
  const participantQueues = catalog().queues.filter((queue) => queue.drainParticipant)
  assert.equal(receipt.schema, 'fsusblog.bounded-queue-acceptance.v1')
  assert.equal(receipt.perQueue.length, participantQueues.length)
  assert.deepEqual(receipt.perQueue.map((queue) => queue.queueId), participantQueues.map((queue) => queue.queueId))
  assert.ok(receipt.perQueue.every((queue) => queue.scenarios.length === 10 && queue.participantAdapter.token))
  assert.equal(receipt.matrix.enumeration, 'BoundedQueueDeliveryCatalog.Embedded.DrainParticipants')
  assert.equal(receipt.matrix.fixtureCount, participantQueues.length * 10)
  assert.deepEqual(receipt.drainAggregate.participantQueueIds, participantQueues.map((queue) => queue.queueId))
  assert.equal(receipt.mutationResults.length, 8)
  assert.deepEqual(receipt.warnings, [])
  assert.match(receipt.contentDigest, /^sha256:[a-f0-9]{64}$/u)
  assert.deepEqual(verifyBoundedQueueAcceptanceReceipt(receipt), receipt)
  const tampered = structuredClone(receipt)
  tampered.warnings.push('mutation warning')
  assert.throws(() => verifyBoundedQueueAcceptanceReceipt(tampered), /does not match current source/u)
})

test('published JSON schema owns the catalog shape', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'config/testing/bounded-channel-delivery-contracts.schema.json'), 'utf8'))
  assert.equal(schema.$id, 'https://fsus.blog/schemas/testing/bounded-channel-delivery-contracts.schema.json')
  assert.deepEqual(schema.properties.queues.items.properties.deliveryClass.enum, ['required', 'best-effort', 'coalescible', 'replayable'])
  assert.deepEqual(
    schema.properties.queues.items.properties.classProof.oneOf.map((entry) => entry.$ref),
    ['#/$defs/requiredProof', '#/$defs/bestEffortProof', '#/$defs/coalescibleProof', '#/$defs/replayableProof']
  )
})
