import assert from 'node:assert/strict'
import { fixtureBytes, frameResponse } from './fixture-source.ts'
import { test } from 'node:test'
import { decodeFrame, encodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts'
import { PodWriter } from '../../src/Contracts/binary.ts'
import { canvasBundle, decodeCanvasBundlePlan, encodeCanvasBundleExecute } from '../../src/Contracts/canvas-bundle.ts'
import { FrameType, WireLimits, WireRoutes } from '../../src/Contracts/wire.generated.ts'

const canvasId = '7a7a7a7a-0000-4000-8000-000000000001'
const commandId = '7a7a7a7a-0000-4000-8000-000000000002'
const digest = '1b784b422a40ce408a17deb133dcb419f5d1528b906ab1b97f72a9a87364fdc8'
const raw = new TextEncoder().encode('{"kind":"authoring-canvas","demo":"检验"}\n')
const sourceRevision = 9_007_199_254_740_993n

function bundleCommand() {
  return { canvasId, commandId, digest, bundle: raw, mappings: [
    { slot: 1, articleId: 17, pinnedRevision: null },
    { slot: 2, articleId: 21, pinnedRevision: sourceRevision + 1n },
  ] }
}

// Packed independently with Python struct, hashlib and bitwise CRC.
test('bundle plan and execution preserve exact reference slots, pins and intake bytes', () => {
  const { payload } = decodeFrame(fixtureBytes('canvas-bundle-plan.hex'), FrameType.CanvasBundlePlan)
  assert.deepEqual(decodeCanvasBundlePlan(payload), {
    digest, sourceRevision, title: 'Private notes 猫', nodeCount: 3, edgeCount: 1,
    references: [
      { slot: 1, kind: 'article-reference', pinned: false, anchor: null },
      { slot: 2, kind: 'block-reference', pinned: true, anchor: 'named-block' },
    ],
  })
  assert.throws(() => decodeCanvasBundlePlan(payload.subarray(0, -1)), ProtocolError)
  const invalid = payload.slice()
  const firstSlotOffset = 4 + 64 + 8 + 4 + new TextEncoder().encode('Private notes 猫').length + 12
  new DataView(invalid.buffer).setInt32(firstSlotOffset, 2, true)
  assert.throws(() => decodeCanvasBundlePlan(invalid), /bundle reference/)

  const command = bundleCommand()
  assert.deepEqual(encodeFrame(FrameType.CanvasBundleExecute, encodeCanvasBundleExecute(command)), fixtureBytes('canvas-bundle-execute.hex'))
  assert.throws(() => encodeCanvasBundleExecute({ ...command, mappings: command.mappings.slice(1) }), /bundle mapping/)
  assert.throws(() => encodeCanvasBundleExecute({ ...command, digest: digest.toUpperCase() }), /bundle digest/)
  assert.throws(() => encodeCanvasBundleExecute({ ...command, bundle: new Uint8Array(0) }), /bundle byte length/)
  assert.throws(() => encodeCanvasBundleExecute({ ...command, bundle: new Uint8Array(WireLimits.CanvasBundleBytes + 1) }), /bundle byte length/)
})

test('preflight compares plan digest to the transmitted bytes and keeps revision exact in download URLs', async t => {
  const plan = fixtureBytes('canvas-bundle-plan.hex')
  const signal = new AbortController().signal
  const posts: Uint8Array[] = []
  t.mock.method(globalThis, 'fetch', async (path: string, init: RequestInit) => {
    assert.equal(path, WireRoutes.CanvasBundlePlan)
    assert.equal(init.signal, signal)
    assert.equal(init.method, 'POST')
    assert.ok(init.body instanceof Uint8Array)
    posts.push(init.body)
    return frameResponse(plan)
  })
  assert.equal((await canvasBundle.plan(raw, signal)).digest, digest)
  assert.deepEqual(posts[0], fixtureBytes('canvas-bundle-intake.hex'))
  await assert.rejects(canvasBundle.plan(Uint8Array.of(42), signal), /bundle plan digest/)
  assert.equal(canvasBundle.downloadHref(canvasId, sourceRevision),
    `${WireRoutes.CanvasBundleExport.replace('{id:guid}', canvasId)}?revision=${sourceRevision}`)
  assert.throws(() => canvasBundle.downloadHref(canvasId, 0n), /export revision/)
})

test('bundle import accepts only the fresh authorized canvas receipt', async t => {
  const command = bundleCommand()
  let receiptId = canvasId
  let receiptRevision = 1n
  t.mock.method(globalThis, 'fetch', async (path: string, init: RequestInit) => {
    assert.equal(path, WireRoutes.CanvasBundleExecute)
    assert.equal(init.method, 'POST')
    assert.deepEqual(init.body, fixtureBytes('canvas-bundle-execute.hex'))
    const receipt = new PodWriter()
    receipt.uuid(receiptId)
    receipt.i64(receiptRevision)
    receipt.text('Private notes 猫', WireLimits.TitleBytes)
    receipt.i32(0)
    receipt.i32(0)
    receipt.i32(1000)
    receipt.bool(false)
    receipt.i32(3)
    receipt.i32(1)
    receipt.i64(1_700_000_000_000n)
    return frameResponse(encodeFrame(FrameType.CanvasGraphReceipt, receipt.finish()))
  })
  assert.equal((await canvasBundle.import(command)).revision, 1n)
  receiptRevision = 2n
  await assert.rejects(canvasBundle.import(command), /bundle import receipt/)
  receiptRevision = 1n
  receiptId = commandId
  await assert.rejects(canvasBundle.import(command), /bundle import receipt/)
})
