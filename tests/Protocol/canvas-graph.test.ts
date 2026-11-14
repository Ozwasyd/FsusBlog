import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { decodeFrame, encodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts'
import {
  canvasGraph, decodeCanvasGraphPage, encodeCanvasGraphCommand, type CanvasGraphCommand,
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
function fixture(name: string): Uint8Array {
  return Uint8Array.from(Buffer.from(readFileSync(new URL(`./fixtures/${name}.hex`, import.meta.url), 'utf8').trim(), 'hex'))
}

test('graph command preserves exact wire bytes for all five nodes and stable typed edges', () => {
  const bytes = encodeFrame(FrameType.CanvasGraphCommand, encodeCanvasGraphCommand(commands))
  assert.deepEqual(bytes, fixture('canvas-graph-command'))
  assert.throws(() => encodeCanvasGraphCommand({ ...commands, expectedRevision: 0n }), ProtocolError)
  assert.throws(() => encodeCanvasGraphCommand({ ...commands, action: 'delete' }), ProtocolError)
  assert.throws(() => encodeCanvasGraphCommand({ ...commands, title: 'line\nbreak' }), ProtocolError)
  assert.throws(() => encodeCanvasGraphCommand({ ...commands, title: '<markup>' }), ProtocolError)
  assert.throws(() => encodeCanvasGraphCommand({
    ...commands, changes: [{ kind: 'upsert-node', node: { id: id(3), kind: 'group-frame', text: 'Frame', geometry, memberIds: [id(3)] } }],
  }), ProtocolError)
})

test('paged Canvas response binds exact scope, revision, membership, and combined sequential offset', () => {
  const payload = decodeFrame(fixture('canvas-graph-page-node'), FrameType.CanvasGraphPage).payload
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

  const last = decodeFrame(fixture('canvas-graph-page-edge'), FrameType.CanvasGraphPage).payload
  assert.throws(() => decodeCanvasGraphPage(last, 1), ProtocolError)
  assert.throws(() => decodeCanvasGraphPage(last, 3), /page offset/)
  assert.equal(decodeCanvasGraphPage(last, 2).nextOffset, null)
  assert.deepEqual(decodeCanvasGraphPage(last, 2).edges, [commands.changes[5].edge])
})

test('graph fetch preserves loaded page coordinates and rejects cross-document responses', async t => {
  const calls: string[] = []
  t.mock.method(globalThis, 'fetch', async (path: string) => {
    calls.push(path)
    return new Response(fixture('canvas-graph-page-edge'), { headers: { 'content-type': 'application/octet-stream' } })
  })
  const page = await canvasGraph.page(id(1), { revision, offset: 2 })
  assert.equal(page.header.revision, revision)
  assert.equal(page.edges[0]?.id, id(8))
  const endpoint = WireRoutes.CanvasGraphPage.replace(/\{id(?::guid)?\}/, id(1))
  assert.equal(calls[0], `${endpoint}?revision=${revision}&offset=2`)
  await assert.rejects(canvasGraph.page(id(2), { revision, offset: 2 }), /page document or revision/)
  assert.throws(() => canvasGraph.page(id(1), { offset: 2 }), /page revision/)
})
