import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultCanvasViewport, type CanvasGraphEdge, type CanvasGraphHeader, type CanvasNode } from '../../src/Contracts/canvas-graph.ts'
import { CanvasFormModel } from '../../src/Web/src/authoring/canvasForm.ts'

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
}

const header: CanvasGraphHeader = {
  id: uuid(1),
  revision: 3n,
  title: 'Original canvas',
  viewport: defaultCanvasViewport,
  nodeCount: 2,
  edgeCount: 1,
}

const noteA: CanvasNode = {
  kind: 'plain-text-note',
  id: uuid(10),
  geometry: { x: 10, y: 20, width: 220, height: 140 },
  zOrder: 0,
  text: 'Alpha',
}

const refB: CanvasNode = {
  kind: 'heading-reference',
  id: uuid(11),
  geometry: { x: 260, y: 20, width: 240, height: 150 },
  zOrder: 1,
  articleId: 42,
  anchor: 'intro',
  pinnedRevision: 5n,
}

const frameC: CanvasNode = {
  kind: 'group-frame',
  id: uuid(12),
  geometry: { x: 40, y: 40, width: 420, height: 300 },
  zOrder: 2,
  title: 'Cluster',
  memberIds: [uuid(10), uuid(99)],
}

test('CanvasFormModel opens title, node, and edge drafts and preserves hidden frame members', () => {
  const model = new CanvasFormModel()
  model.openTitle(header.title)
  assert.equal(model.isOpen, true)
  assert.equal(model.snapshot().form, 'title')
  assert.equal(model.snapshot().title, 'Original canvas')

  model.update({ title: 'Renamed' })
  assert.equal(model.title, 'Renamed')
  assert.equal(model.close(true), false)
  assert.equal(model.isOpen, true)
  assert.equal(model.close(false), true)
  assert.equal(model.isOpen, false)

  model.openNode('plain-text-note', refB)
  const refSnap = model.snapshot()
  assert.equal(refSnap.form, 'node')
  assert.equal(refSnap.nodeKind, 'heading-reference')
  assert.equal(refSnap.article, '42')
  assert.equal(refSnap.anchor, 'intro')
  assert.equal(refSnap.pinned, '5')

  model.openNode('group-frame', frameC)
  // Filtering shows only noteA; selecting empty leaves hidden member uuid(99) intact.
  model.setFrameMembers([noteA], [])
  assert.deepEqual(model.snapshot().members, [uuid(99)])

  const edge: CanvasGraphEdge = {
    id: uuid(20),
    sourceNodeId: noteA.id,
    targetNodeId: refB.id,
    kind: 'explicit-reference-note',
    order: 0,
    label: 'links',
  }
  model.openEdge(edge)
  const edgeSnap = model.snapshot()
  assert.equal(edgeSnap.form, 'edge')
  assert.equal(edgeSnap.endpoint, refB.id)
  assert.equal(edgeSnap.edgeKind, 'explicit-reference-note')
  assert.equal(edgeSnap.label, 'links')

  const builtEdge = model.buildEdge({
    selectedNodeId: noteA.id,
    byId: new Map([[noteA.id, noteA], [refB.id, refB]]),
    edgeCount: 1,
    generatedEdgeId: uuid(21),
  })
  assert.equal(builtEdge?.id, edge.id)

  model.clearEditing()
  assert.equal(model.isOpen, false)
  assert.equal(model.snapshot().editingNode, undefined)
  assert.equal(model.snapshot().editingEdge, undefined)
})

test('CanvasFormModel validates invalid node drafts and resets title conditionally', () => {
  const model = new CanvasFormModel()
  model.openNode('article-reference')
  model.update({ article: '0' })
  const invalid = model.buildNode(header, uuid(30))
  assert.deepEqual(invalid, { ok: false, errorKey: 'author.canvas.enter_a_valid_article_id_and_optional_pinned_revision' })

  model.update({ title: 'Keep me' })
  model.reset(false)
  assert.equal(model.title, 'Keep me')
  model.reset(true)
  assert.equal(model.title, '')
})
