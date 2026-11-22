import assert from 'node:assert/strict'
import { fixtureBytes, frameResponse } from './fixture-source.ts'
import { test } from 'node:test'
import { decodeFrame, encodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts'
import {
  canvasGraph, decodeCanvasGraphHistory, decodeCanvasGraphPage, decodeCanvasReferenceResolution, encodeCanvasGraphCommand, type CanvasGraphCommand,
} from '../../src/Contracts/canvas-graph.ts'
import { FrameType, WireRoutes } from '../../src/Contracts/wire.generated.ts'

const id = (value: number) => `7a7a7a7a-0000-4000-8000-${String(value).padStart(12, '0')}`
const geometry = { x: 100, y: -200, width: 20_000, height: 10_000 }
const viewport = { x: -300, y: 400, zoom: 1250 }
const revision = 9_007_199_254_740_993n
const title = 'Private graph 🐈'
const commands = {
  id: id(1), commandId: id(2), expectedRevision: revision, action: 'edit', title, viewport,
  changes: [
    { kind: 'upsert-node', node: { id: id(3), kind: 'plain-text-note', geometry, text: 'note\n行' } },
    { kind: 'upsert-node', node: { id: id(4), kind: 'group-frame', geometry, text: 'Review', memberIds: [id(3)] } },
    { kind: 'upsert-node', node: { id: id(5), kind: 'article-reference', geometry, articleId: 17, pinnedRevision: revision } },
    { kind: 'upsert-node', node: { id: id(6), kind: 'heading-reference', geometry, articleId: 17, anchor: 'stable-anchor', pinnedRevision: null } },
    { kind: 'upsert-node', node: { id: id(7), kind: 'block-reference', geometry, articleId: 18, anchor: 'sub-block', pinnedRevision: 1n } },
    { kind: 'upsert-edge', edge: { id: id(8), kind: 'explicit-reference-note', sourceNodeId: id(5), targetNodeId: id(6), order: 1, label: 'Cite' } },
    { kind: 'remove-edge', id: id(8) },
  ],
} satisfies CanvasGraphCommand

// Packed independently with Python struct and bitwise AEDS CRC.
test('graph command preserves exact wire bytes for all five nodes and stable typed edges', () => {
  const bytes = encodeFrame(FrameType.CanvasGraphCommand, encodeCanvasGraphCommand(commands))
  assert.deepEqual(bytes, fixtureBytes('canvas-graph-command.hex'))
  const invalidEdits: Partial<CanvasGraphCommand>[] = [
    { expectedRevision: 0n }, { action: 'delete' }, { title: 'line\nbreak' }, { title: '<markup>' },
  ]
  for (const edit of invalidEdits)
    assert.throws(() => encodeCanvasGraphCommand({ ...commands, ...edit }), ProtocolError)
  assert.throws(() => encodeCanvasGraphCommand({
    ...commands, changes: [{ kind: 'upsert-node', node: { id: id(3), kind: 'group-frame', text: 'Frame', geometry, memberIds: [id(3)] } }],
  }), ProtocolError)
})

test('paged Canvas response binds exact scope, revision, membership, and combined sequential offset', () => {
  const payload = decodeFrame(fixtureBytes('canvas-graph-page-node.hex'), FrameType.CanvasGraphPage).payload
  const first = decodeCanvasGraphPage(payload)
  assert.equal(first.header.id, id(1))
  assert.equal(first.header.revision, revision)
  assert.equal(first.header.title, title)
  assert.deepEqual(first.header.viewport, viewport)
  assert.equal(first.nextOffset, 1)
  assert.deepEqual(first.nodes, [{
    id: id(4), kind: 'group-frame', geometry, text: 'Review', memberIds: [id(3)],
  }])
  assert.deepEqual(first.edges, [])
  assert.throws(() => decodeCanvasGraphPage(payload.subarray(0, -1)), ProtocolError)
  assert.throws(() => decodeCanvasGraphPage(payload, 1), ProtocolError)

  const last = decodeFrame(fixtureBytes('canvas-graph-page-edge.hex'), FrameType.CanvasGraphPage).payload
  assert.throws(() => decodeCanvasGraphPage(last, 1), ProtocolError)
  assert.throws(() => decodeCanvasGraphPage(last, 3), /page offset/)
  assert.equal(decodeCanvasGraphPage(last, 2).nextOffset, null)
  assert.deepEqual(decodeCanvasGraphPage(last, 2).edges, [commands.changes[5].edge])
})

test('graph fetch preserves loaded page coordinates and rejects cross-document responses', async t => {
  const calls: string[] = []
  t.mock.method(globalThis, 'fetch', async (path: string) => {
    calls.push(path)
    return frameResponse(fixtureBytes('canvas-graph-page-edge.hex'))
  })
  const page = await canvasGraph.page(id(1), { revision, offset: 2 })
  assert.equal(page.header.revision, revision)
  assert.equal(page.edges[0]?.id, id(8))
  const endpoint = WireRoutes.CanvasGraphPage.replace(/\{id(?::guid)?\}/, id(1))
  assert.equal(calls[0], `${endpoint}?revision=${revision}&offset=2`)
  await assert.rejects(canvasGraph.page(id(2), { revision, offset: 2 }), /page document or revision/)
  assert.throws(() => canvasGraph.page(id(1), { offset: 2 }), /page revision/)
})

test('undo and redo preserve their command envelopes and reject edit fields', () => {
  const actions = ['undo', 'redo'] as const
  for (const action of actions) {
    const command = { ...commands, action, title: '', viewport: null, changes: [] }
    assert.deepEqual(encodeFrame(FrameType.CanvasGraphCommand, encodeCanvasGraphCommand(command)), fixtureBytes(`canvas-graph-${action}.hex`))
    for (const edit of [{ title: 'x' }, { viewport }, { changes: commands.changes }])
      assert.throws(() => encodeCanvasGraphCommand({ ...command, ...edit }), /history command shape/)
    assert.throws(() => encodeCanvasGraphCommand({ ...command, expectedRevision: 0n }), /command revision or action/)
  }
})

test('history reads exact revision echoes and rejects malformed optional revisions', async t => {
  const bytes = fixtureBytes('canvas-graph-history.hex')
  const { payload } = decodeFrame(bytes, FrameType.CanvasGraphHistory)
  const expected = { revision, undoRevision: revision, redoRevision: null }
  assert.deepEqual(decodeCanvasGraphHistory(payload), expected)
  assert.throws(() => decodeCanvasGraphHistory(payload.subarray(0, -1)), ProtocolError)
  assert.throws(() => decodeCanvasGraphHistory(Uint8Array.from([...payload, 0])), ProtocolError)
  for (const redo of [-1n, revision, revision + 1n]) {
    const bad = payload.slice()
    new DataView(bad.buffer).setBigInt64(16, redo, true)
    assert.throws(() => decodeCanvasGraphHistory(bad), /history revision/)
  }

  const signal = new AbortController().signal
  const mocked = t.mock.method(globalThis, 'fetch', async (path: string, init: RequestInit) => {
    assert.equal(init.signal, signal)
    assert.match(path, new RegExp(`/${id(1)}/history\\.aeds\\?revision=\\d+$`))
    return frameResponse(bytes)
  })
  const read = (at: bigint) => canvasGraph.history(id(1), at, signal)
  assert.deepEqual(await read(revision), expected)
  await assert.rejects(read(revision + 1n), /history revision/)
  assert.throws(() => read(0n), /history revision/)
  assert.throws(() => read(1n << 63n), /history revision/)
  assert.equal(mocked.mock.callCount(), 2)
})

test('reference resolution preserves authorized metadata, offset zero and redacted states', () => {
  const payload = (name: string) => decodeFrame(fixtureBytes(`canvas-reference-${name}.hex`), FrameType.CanvasReferenceResolution).payload
  const expected = {
    canvasId: id(1), nodeId: id(6), canvasRevision: revision, state: 'resolved', articleId: 17, articleRevision: revision + 1n,
    pinned: true, title: 'Draft title 猫', excerpt: 'Heading\nPlain excerpt', sourceOffset: 0,
  }
  const resolved = payload('resolved')
  assert.deepEqual(decodeCanvasReferenceResolution(resolved), expected)
  assert.deepEqual(decodeCanvasReferenceResolution(payload('missing')), {
    ...expected, state: 'missing-anchor', pinned: false, excerpt: null, sourceOffset: null,
  })
  const redacted = {
    ...expected, state: 'unavailable', articleId: null, articleRevision: null, pinned: false, title: null, excerpt: null, sourceOffset: null,
  }
  assert.deepEqual(decodeCanvasReferenceResolution(payload('unavailable')), redacted)
  const stateOffset = 16 + 16 + 8
  const stale = payload('unavailable').slice()
  new DataView(stale.buffer).setInt32(stateOffset, 4, true)
  assert.deepEqual(decodeCanvasReferenceResolution(stale), { ...redacted, state: 'stale-revision' })
  for (const state of [0, 2, 3, 4, 5]) {
    const invalid = resolved.slice()
    new DataView(invalid.buffer).setInt32(stateOffset, state, true)
    assert.throws(() => decodeCanvasReferenceResolution(invalid), ProtocolError)
  }
  assert.throws(() => decodeCanvasReferenceResolution(resolved.subarray(0, -1)), ProtocolError)
  const noOffset = resolved.slice()
  new DataView(noOffset.buffer).setInt32(noOffset.length - 4, -1, true)
  assert.throws(() => decodeCanvasReferenceResolution(noOffset), /reference excerpt or offset/)
})

test('reference fetch requires exact canvas, node and revision response echoes', async t => {
  const bytes = fixtureBytes('canvas-reference-resolved.hex')
  const requests: string[] = []
  const signal = new AbortController().signal
  t.mock.method(globalThis, 'fetch', async (path: string, init: RequestInit) => {
    assert.equal(init.signal, signal)
    requests.push(path)
    return frameResponse(bytes)
  })
  const path = WireRoutes.CanvasReference.replace('{id:guid}', id(1)).replace('{nodeId:guid}', id(6))
  const resolve = (canvas: number, node: number, at: bigint) => canvasGraph.resolve(id(canvas), id(node), at, signal)
  assert.equal((await resolve(1, 6, revision)).title, 'Draft title 猫')
  assert.equal(requests[0], `${path}?revision=${revision}`)
  await assert.rejects(resolve(2, 6, revision), /reference response coordinates/)
  await assert.rejects(resolve(1, 7, revision), /reference response coordinates/)
  await assert.rejects(resolve(1, 6, revision + 1n), /reference response coordinates/)
  assert.throws(() => resolve(1, 6, 0n), /reference revision/)
  assert.equal(requests.length, 4)
})
