import { strict as assert } from 'node:assert'
import test from 'node:test'
import { defaultCanvasViewport, type CanvasGraphEdge, type CanvasGraphHeader, type CanvasNode } from '../../src/Contracts/canvas-graph.ts'
import {
  buildCanvasEdge,
  buildCanvasNode,
  canApplyOptimisticNodeUpsert,
  CHOICE_CAP,
  computeHistoryAvailability,
  createCanvasCommand,
  deleteCanvasCommand,
  editCanvasCommand,
  filterEndpointChoices,
  filterMemberChoices,
  filterOutlineEdges,
  filterOutlineNodes,
  hasNextOutlinePage,
  historyTravelCommand,
  mergeFrameMembers,
  OUTLINE_PAGE_SIZE,
  resolveActiveArticleLink,
  resolveHistoryShortcutAction,
  sliceOutlineRecords,
  validateCanvasCommand,
} from '../../src/Web/src/authoring/canvasCommands.ts'

const uuid = (n: number) => `22222222-0000-4000-8000-${String(n).padStart(12, '0')}`
const header = (overrides: Partial<CanvasGraphHeader> = {}): CanvasGraphHeader => ({
  id: uuid(1),
  revision: 3n,
  title: 'Research graph',
  viewport: defaultCanvasViewport,
  deleted: false,
  nodeCount: 2,
  edgeCount: 1,
  touchedAt: 1_700_000_000_000,
  ...overrides,
})

test('graph command builders produce wire-valid commands and reject malformed edits', () => {
  const doc = header()
  const createCmd = createCanvasCommand('Planning', uuid(10), uuid(11))
  assert.equal(createCmd.action, 'create')
  assert.equal(createCmd.expectedRevision, 0n)
  assert.equal(validateCanvasCommand(createCmd), true)

  const editCmd = editCanvasCommand(doc, uuid(12), { title: 'Renamed' })
  assert.equal(editCmd.expectedRevision, 3n)
  assert.equal(validateCanvasCommand(editCmd), true)
  assert.equal(validateCanvasCommand(editCanvasCommand(doc, uuid(13), { title: 'bad\nline' })), false)
  assert.equal(validateCanvasCommand(editCanvasCommand(doc, uuid(14))), false)

  assert.equal(validateCanvasCommand(historyTravelCommand(doc, 'undo', uuid(15))), true)
  assert.equal(validateCanvasCommand(historyTravelCommand(doc, 'redo', uuid(16))), true)
  assert.equal(validateCanvasCommand(deleteCanvasCommand(doc, uuid(17))), true)
})

test('node and edge builders preserve shift placement, reference validation, and hidden frame members', () => {
  const canvas = header({ nodeCount: 3, viewport: { x: 1000, y: 2000, zoom: 1000 } })
  const noteBuilt = buildCanvasNode(
    { kind: 'plain-text-note', text: 'Note body', article: '', anchor: '', pinned: '', memberIds: [] },
    canvas,
    uuid(20),
  )
  assert.equal(noteBuilt.ok, true)
  if (noteBuilt.ok) {
    assert.deepEqual(noteBuilt.node.geometry, {
      x: 1000 + 3500 + 3 * 3400,
      y: 2000 + 3500 + 3 * 3400,
      width: 17000,
      height: 10000,
    })
  }

  const invalidRef = buildCanvasNode(
    { kind: 'article-reference', text: '', article: '0', anchor: '', pinned: '', memberIds: [] },
    canvas,
    uuid(21),
  )
  assert.deepEqual(invalidRef, {
    ok: false,
    errorKey: 'author.canvas.enter_a_valid_article_id_and_optional_pinned_revision',
  })

  const invalidPin = buildCanvasNode(
    { kind: 'heading-reference', text: '', article: '42', anchor: 'intro', pinned: 'abc', memberIds: [] },
    canvas,
    uuid(22),
  )
  assert.equal(invalidPin.ok, false)

  const validBlock = buildCanvasNode(
    { kind: 'block-reference', text: '', article: '42', anchor: 'detail', pinned: '12', memberIds: [] },
    canvas,
    uuid(23),
  )
  assert.equal(validBlock.ok, true)
  if (validBlock.ok && validBlock.node.kind === 'block-reference') {
    assert.equal(validBlock.node.articleId, 42)
    assert.equal(validBlock.node.pinnedRevision, 12n)
    assert.equal(validBlock.node.anchor, 'detail')
  }

  const existing: CanvasNode = {
    id: uuid(24),
    kind: 'plain-text-note',
    geometry: { x: 50, y: 60, width: 17000, height: 10000 },
    text: 'Old',
  }
  const edited = buildCanvasNode(
    { kind: 'plain-text-note', text: 'Updated', article: '', anchor: '', pinned: '', memberIds: [] },
    canvas,
    uuid(25),
    existing,
  )
  assert.equal(edited.ok, true)
  if (edited.ok) {
    assert.equal(edited.node.id, existing.id)
    assert.deepEqual(edited.node.geometry, existing.geometry)
  }

  const n1: CanvasNode = { id: uuid(30), kind: 'article-reference', geometry: existing.geometry, articleId: 1, pinnedRevision: null }
  const n2: CanvasNode = { id: uuid(31), kind: 'article-reference', geometry: existing.geometry, articleId: 2, pinnedRevision: null }
  const byId = new Map([[n1.id, n1], [n2.id, n2]])
  const createdEdge = buildCanvasEdge(
    { endpoint: n2.id, kind: 'explicit-reference-note', label: 'Link' },
    { selectedNodeId: n1.id, byId, edgeCount: 5, generatedEdgeId: uuid(32) },
  )
  assert.deepEqual(createdEdge, {
    id: uuid(32),
    sourceNodeId: n1.id,
    targetNodeId: n2.id,
    kind: 'explicit-reference-note',
    order: 5,
    label: 'Link',
  })

  // Unloaded target on an existing edge remains valid.
  const priorEdge: CanvasGraphEdge = {
    id: uuid(33),
    sourceNodeId: n1.id,
    targetNodeId: uuid(99),
    kind: 'visual-only',
    order: 2,
    label: null,
  }
  const keptUnloaded = buildCanvasEdge(
    { endpoint: uuid(99), kind: 'visual-only', label: '' },
    { prior: priorEdge, byId, edgeCount: 5, generatedEdgeId: uuid(34) },
  )
  assert.equal(keptUnloaded?.id, priorEdge.id)
  assert.equal(keptUnloaded?.order, 2)
  assert.equal(keptUnloaded?.label, null)

  // Filtered-out members remain checked when modifying visible subset.
  assert.deepEqual(
    mergeFrameMembers([uuid(1), uuid(2), uuid(3)], [n1, { ...n2, id: uuid(2) }], [uuid(2), uuid(4)]),
    [uuid(1), uuid(3), uuid(2), uuid(4)],
  )
})

test('link eligibility, optimistic upsert, history availability, and shortcut parsing keep exact invariants', () => {
  const g = { x: 0, y: 0, width: 17000, height: 10000 }
  const ref1: CanvasNode = { id: uuid(1), kind: 'article-reference', geometry: g, articleId: 10, pinnedRevision: null }
  const ref2: CanvasNode = { id: uuid(2), kind: 'article-reference', geometry: g, articleId: 20, pinnedRevision: null }
  const refPinned: CanvasNode = { id: uuid(3), kind: 'article-reference', geometry: g, articleId: 30, pinnedRevision: 5n }
  const headingRef: CanvasNode = { id: uuid(4), kind: 'heading-reference', geometry: g, articleId: 40, anchor: 'sec', pinnedRevision: null }
  const byId = new Map([[ref1.id, ref1], [ref2.id, ref2], [refPinned.id, refPinned], [headingRef.id, headingRef]])

  assert.deepEqual(
    resolveActiveArticleLink({ id: uuid(10), kind: 'visual-only', sourceNodeId: ref1.id, targetNodeId: ref2.id, order: 0, label: null }, byId),
    { from: ref1, to: ref2 },
  )
  assert.equal(
    resolveActiveArticleLink({ id: uuid(11), kind: 'explicit-reference-note', sourceNodeId: ref1.id, targetNodeId: refPinned.id, order: 1, label: null }, byId),
    undefined,
  )
  assert.equal(
    resolveActiveArticleLink({ id: uuid(12), kind: 'explicit-reference-note', sourceNodeId: ref1.id, targetNodeId: ref1.id, order: 2, label: null }, byId),
    undefined,
  )
  assert.equal(
    resolveActiveArticleLink({ id: uuid(13), kind: 'explicit-reference-note', sourceNodeId: ref1.id, targetNodeId: headingRef.id, order: 3, label: null }, byId),
    undefined,
  )

  const doc = header({ revision: 3n, nodeCount: 4, edgeCount: 1 })
  const updatedRef1 = { ...ref1, geometry: { ...g, x: 800 } }
  const upsertExisting = editCanvasCommand(doc, uuid(20), { changes: [{ kind: 'upsert-node', node: updatedRef1 }] })
  const nextHeader = header({ revision: 4n, nodeCount: 4, edgeCount: 1 })
  assert.equal(canApplyOptimisticNodeUpsert(true, upsertExisting, byId, nextHeader, 4, 1), updatedRef1)
  assert.equal(canApplyOptimisticNodeUpsert(false, upsertExisting, byId, nextHeader, 4, 1), undefined)
  assert.equal(
    canApplyOptimisticNodeUpsert(true, upsertExisting, byId, header({ revision: 4n, nodeCount: 5, edgeCount: 1 }), 4, 1),
    undefined,
  )

  assert.deepEqual(
    computeHistoryAvailability({
      disabled: false,
      hasOpenForm: false,
      document: doc,
      history: { revision: 3n, undoRevision: 2n, redoRevision: null },
    }),
    { undo: true, redo: false },
  )
  assert.deepEqual(
    computeHistoryAvailability({
      disabled: false,
      hasOpenForm: true,
      document: doc,
      history: { revision: 3n, undoRevision: 2n, redoRevision: 4n },
    }),
    { undo: false, redo: false },
  )
  assert.deepEqual(
    computeHistoryAvailability({
      disabled: false,
      hasOpenForm: false,
      document: doc,
      history: { revision: 2n, undoRevision: 1n, redoRevision: 3n },
    }),
    { undo: false, redo: false },
  )

  const baseKey = {
    defaultPrevented: false,
    repeat: false,
    isComposing: false,
    altKey: false,
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    key: 'z',
  }
  assert.equal(resolveHistoryShortcutAction(baseKey), 'undo')
  assert.equal(resolveHistoryShortcutAction({ ...baseKey, shiftKey: true }), 'redo')
  assert.equal(resolveHistoryShortcutAction({ ...baseKey, ctrlKey: false, metaKey: true, key: 'y' }), 'redo')
  assert.equal(resolveHistoryShortcutAction({ ...baseKey, metaKey: true }), undefined)
  assert.equal(resolveHistoryShortcutAction({ ...baseKey, isComposing: true }), undefined)
})

test('outline search, 50-record paging, and 256-choice caps preserve anchor matching and selected endpoints', () => {
  const g = { x: 0, y: 0, width: 17000, height: 10000 }
  const nodes: CanvasNode[] = [
    ...Array.from({ length: CHOICE_CAP + 10 }, (_, i) => ({
      id: uuid(i + 1),
      kind: 'plain-text-note' as const,
      geometry: g,
      text: `Note ${i + 1}`,
    })),
    { id: uuid(500), kind: 'heading-reference', geometry: g, articleId: 7, anchor: 'target-anchor', pinnedRevision: null },
    { id: uuid(501), kind: 'group-frame', geometry: g, text: 'Frame', memberIds: [] },
  ]
  const byId = new Map(nodes.map(n => [n.id, n]))
  const nodeLabel = (node: CanvasNode) => 'text' in node ? node.text : `Ref ${node.articleId}`

  const anchorHits = filterOutlineNodes(nodes, 'target-anchor', nodeLabel)
  assert.deepEqual(anchorHits.map(n => n.id), [uuid(500)])

  const page0 = sliceOutlineRecords(nodes, 0)
  const page1 = sliceOutlineRecords(nodes, 1)
  assert.equal(page0.length, OUTLINE_PAGE_SIZE)
  assert.equal(page1[0]?.id, uuid(OUTLINE_PAGE_SIZE + 1))
  assert.equal(hasNextOutlinePage(nodes.length, 0, 0), true)
  assert.equal(hasNextOutlinePage(OUTLINE_PAGE_SIZE, OUTLINE_PAGE_SIZE, 0), false)

  const edges: CanvasGraphEdge[] = [
    { id: uuid(900), kind: 'visual-only', sourceNodeId: uuid(1), targetNodeId: uuid(2), order: 0, label: 'Alpha link' },
    { id: uuid(901), kind: 'visual-only', sourceNodeId: uuid(1), targetNodeId: uuid(3), order: 1, label: 'Beta link' },
  ]
  assert.equal(filterOutlineEdges(edges, 'alpha', e => e.label ?? '').length, 1)

  const members = filterMemberChoices(nodes, '', nodeLabel)
  assert.equal(members.length, CHOICE_CAP)
  assert.equal(members.some(n => n.kind === 'group-frame'), false)

  const selectedEndpoint = uuid(500)
  const endpoints = filterEndpointChoices(nodes, byId, selectedEndpoint, 'Note', nodeLabel)
  assert.equal(endpoints.length, CHOICE_CAP)
  assert.equal(endpoints[0]?.id, selectedEndpoint)
})
