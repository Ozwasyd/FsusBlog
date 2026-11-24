import { strict as assert } from 'node:assert'
import test from 'node:test'
import { defaultCanvasViewport, type CanvasGraphEdge, type CanvasGraphHeader, type CanvasNode, type CanvasViewport } from '../../src/Contracts/canvas-graph.ts'
import {
  buildCanvasEdge,
  buildCanvasNode,
  type CanvasNodeDraftInput,
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
import { CanvasFormModel } from '../../src/Web/src/authoring/canvasForm.ts'
import {
  CANVAS_EDGES_ON_SCREEN,
  CANVAS_MAX_COORDINATE,
  CANVAS_MAX_ZOOM,
  CANVAS_MIN_ZOOM,
  CANVAS_NODES_ON_SCREEN,
  clampCanvasCoordinate,
  commitCanvasGesture,
  createCanvasGesture,
  focusNodeViewport,
  projectCanvasNode,
  queryVisibleCanvasEdges,
  queryVisibleCanvasNodes,
  rovingCanvasNodeIndex,
  stepCanvasArrow,
  stepCanvasGesture,
  viewportEquals,
  zoomCanvasViewport,
} from '../../src/Web/src/authoring/canvasViewport.ts'
import {
  canvasArticleRef,
  canvasEdge,
  canvasFrame,
  canvasHeader,
  canvasNote,
  canvasUuid,
  expectFields,
} from './authoringFixture.ts'

const P = '22222222'
const uuid = (n: number) => canvasUuid(n, P)
const header = (overrides: Partial<CanvasGraphHeader> = {}) =>
  canvasHeader({ id: uuid(1), revision: 3n, title: 'Research graph', nodeCount: 2, edgeCount: 1, ...overrides })
const nodeDraft = (kind: CanvasNode['kind'], fields: Partial<Omit<CanvasNodeDraftInput, 'kind'>>): CanvasNodeDraftInput =>
  ({ kind, text: '', article: '', anchor: '', pinned: '', memberIds: [], ...fields })
const articleNode = (id: number, geometry: CanvasNode['geometry'], articleId: number, pinnedRevision: bigint | null = null) =>
  canvasArticleRef(id, articleId, pinnedRevision, geometry, P)
const edgeOf = (id: number, src: string, dst: string, kind: CanvasGraphEdge['kind'] = 'visual-only', order = 0, label: string | null = null) =>
  canvasEdge(id, src, dst, kind, order, label, P)

test('graph command builders produce wire-valid commands and reject malformed edits', () => {
  const doc = header()
  const createCmd = createCanvasCommand('Planning', uuid(10), uuid(11))
  expectFields(createCmd, { action: 'create', expectedRevision: 0n })
  assert.equal(validateCanvasCommand(createCmd), true)

  const editCmd = editCanvasCommand(doc, uuid(12), { title: 'Renamed' })
  assert.equal(editCmd.expectedRevision, 3n)
  for (const [cmd, ok] of [
    [editCmd, true],
    [editCanvasCommand(doc, uuid(13), { title: 'bad\nline' }), false],
    [editCanvasCommand(doc, uuid(14)), false],
    [historyTravelCommand(doc, 'undo', uuid(15)), true],
    [historyTravelCommand(doc, 'redo', uuid(16)), true],
    [deleteCanvasCommand(doc, uuid(17)), true],
  ] as const) assert.equal(validateCanvasCommand(cmd), ok)
})

test('node and edge builders preserve shift placement, reference validation, and hidden frame members', () => {
  const canvas = header({ nodeCount: 3, viewport: { x: 1000, y: 2000, zoom: 1000 } })
  const build = (kind: CanvasNode['kind'], fields: Partial<Omit<CanvasNodeDraftInput, 'kind'>>, id: number, prior?: CanvasNode) =>
    buildCanvasNode(nodeDraft(kind, fields), canvas, uuid(id), prior)
  const noteBuilt = build('plain-text-note', { text: 'Note body' }, 20)
  assert.equal(noteBuilt.ok, true)
  if (noteBuilt.ok) assert.deepEqual(noteBuilt.node.geometry, { x: 14700, y: 15700, width: 17000, height: 10000 })

  assert.deepEqual(build('article-reference', { article: '0' }, 21),
    { ok: false, errorKey: 'author.canvas.enter_a_valid_article_id_and_optional_pinned_revision' })
  assert.equal(build('heading-reference', { article: '42', anchor: 'intro', pinned: 'abc' }, 22).ok, false)

  const validBlock = build('block-reference', { article: '42', anchor: 'detail', pinned: '12' }, 23)
  assert.equal(validBlock.ok, true)
  if (validBlock.ok && validBlock.node.kind === 'block-reference')
    expectFields(validBlock.node, { articleId: 42, pinnedRevision: 12n, anchor: 'detail' })

  const existing = canvasNote(24, 'Old', { x: 50, y: 60, width: 17000, height: 10000 }, P)
  const edited = build('plain-text-note', { text: 'Updated' }, 25, existing)
  assert.equal(edited.ok, true)
  if (edited.ok) expectFields(edited.node, { id: existing.id, geometry: existing.geometry })

  const [n1, n2] = [articleNode(30, existing.geometry, 1), articleNode(31, existing.geometry, 2)]
  const byId = new Map([[n1.id, n1], [n2.id, n2]])
  const createdEdge = buildCanvasEdge({ endpoint: n2.id, kind: 'explicit-reference-note', label: 'Link' },
    { selectedNodeId: n1.id, byId, edgeCount: 5, generatedEdgeId: uuid(32) })
  assert.deepEqual(createdEdge, edgeOf(32, n1.id, n2.id, 'explicit-reference-note', 5, 'Link'))

  const priorEdge = edgeOf(33, n1.id, uuid(99), 'visual-only', 2)
  const keptUnloaded = buildCanvasEdge({ endpoint: uuid(99), kind: 'visual-only', label: '' },
    { prior: priorEdge, byId, edgeCount: 5, generatedEdgeId: uuid(34) })
  expectFields(keptUnloaded, { id: priorEdge.id, order: 2, label: null })

  assert.deepEqual(
    mergeFrameMembers([uuid(1), uuid(2), uuid(3)], [n1, { ...n2, id: uuid(2) }], [uuid(2), uuid(4)]),
    [uuid(1), uuid(3), uuid(2), uuid(4)],
  )
})

test('link eligibility, optimistic upsert, history availability, and shortcut parsing keep exact invariants', () => {
  const g = { x: 0, y: 0, width: 17000, height: 10000 }
  const [ref1, ref2, refPinned] = [articleNode(1, g, 10), articleNode(2, g, 20), articleNode(3, g, 30, 5n)]
  const headingRef: CanvasNode = { id: uuid(4), kind: 'heading-reference', geometry: g, articleId: 40, anchor: 'sec', pinnedRevision: null }
  const byId = new Map([[ref1.id, ref1], [ref2.id, ref2], [refPinned.id, refPinned], [headingRef.id, headingRef]])

  const articleLink = (id: number, kind: CanvasGraphEdge['kind'], target: string, order: number) =>
    resolveActiveArticleLink(edgeOf(id, ref1.id, target, kind, order), byId)

  assert.deepEqual(articleLink(10, 'visual-only', ref2.id, 0), { from: ref1, to: ref2 })
  for (const [id, target, order] of [[11, refPinned.id, 1], [12, ref1.id, 2], [13, headingRef.id, 3]] as const)
    assert.equal(articleLink(id, 'explicit-reference-note', target, order), undefined)

  const doc = header({ revision: 3n, nodeCount: 4, edgeCount: 1 })
  const updatedRef1 = { ...ref1, geometry: { ...g, x: 800 } }
  const upsertExisting = editCanvasCommand(doc, uuid(20), { changes: [{ kind: 'upsert-node', node: updatedRef1 }] })
  const canUpsert = (complete: boolean, nodeCount = 4) =>
    canApplyOptimisticNodeUpsert(complete, upsertExisting, byId, header({ revision: 4n, nodeCount, edgeCount: 1 }), 4, 1)
  assert.equal(canUpsert(true), updatedRef1)
  assert.equal(canUpsert(false), undefined)
  assert.equal(canUpsert(true, 5), undefined)

  const checkHistory = (revision: bigint, undoRevision: bigint, redoRevision: bigint | null, hasOpenForm = false) =>
    computeHistoryAvailability({ disabled: false, hasOpenForm, document: doc, history: { revision, undoRevision, redoRevision } })
  assert.deepEqual(checkHistory(3n, 2n, null), { undo: true, redo: false })
  assert.deepEqual(checkHistory(3n, 2n, 4n, true), { undo: false, redo: false })
  assert.deepEqual(checkHistory(2n, 1n, 3n), { undo: false, redo: false })

  const baseKey = { defaultPrevented: false, repeat: false, isComposing: false, altKey: false, ctrlKey: true, metaKey: false, shiftKey: false, key: 'z' }
  for (const [patch, expected] of [
    [{}, 'undo'],
    [{ shiftKey: true }, 'redo'],
    [{ ctrlKey: false, metaKey: true, key: 'y' }, 'redo'],
    [{ metaKey: true }, undefined],
    [{ isComposing: true }, undefined],
  ] as const) assert.equal(resolveHistoryShortcutAction({ ...baseKey, ...patch }), expected)
})

test('outline search, 50-record paging, and 256-choice caps preserve anchor matching and selected endpoints', () => {
  const g = { x: 0, y: 0, width: 17000, height: 10000 }
  const nodes: CanvasNode[] = [
    ...Array.from({ length: CHOICE_CAP + 10 }, (_, i) => canvasNote(i + 1, `Note ${i + 1}`, g, P)),
    { id: uuid(500), kind: 'heading-reference', geometry: g, articleId: 7, anchor: 'target-anchor', pinnedRevision: null },
    canvasFrame(501, [], 'Frame', g, P),
  ]
  const byId = new Map(nodes.map(n => [n.id, n]))
  const nodeLabel = (node: CanvasNode) => ('text' in node ? node.text : `Ref ${node.articleId}`)

  assert.deepEqual(filterOutlineNodes(nodes, 'target-anchor', nodeLabel).map(n => n.id), [uuid(500)])
  assert.equal(sliceOutlineRecords(nodes, 0).length, OUTLINE_PAGE_SIZE)
  assert.equal(sliceOutlineRecords(nodes, 1)[0]?.id, uuid(OUTLINE_PAGE_SIZE + 1))
  assert.equal(hasNextOutlinePage(nodes.length, 0, 0), true)
  assert.equal(hasNextOutlinePage(OUTLINE_PAGE_SIZE, OUTLINE_PAGE_SIZE, 0), false)

  const edges = [edgeOf(900, uuid(1), uuid(2), 'visual-only', 0, 'Alpha link'), edgeOf(901, uuid(1), uuid(3), 'visual-only', 1, 'Beta link')]
  assert.equal(filterOutlineEdges(edges, 'alpha', e => e.label ?? '').length, 1)

  const members = filterMemberChoices(nodes, '', nodeLabel)
  assert.equal(members.length, CHOICE_CAP)
  assert.equal(members.some(n => n.kind === 'group-frame'), false)

  const selectedEndpoint = uuid(500)
  const endpoints = filterEndpointChoices(nodes, byId, selectedEndpoint, 'Note', nodeLabel)
  assert.equal(endpoints.length, CHOICE_CAP)
  assert.equal(endpoints[0]?.id, selectedEndpoint)
})

test('CanvasFormModel opens title, node, and edge drafts, validates invalid inputs, and preserves hidden frame members', () => {
  const doc = header({ title: 'Original canvas' })
  const noteA = canvasNote(10, 'Alpha', { x: 10, y: 20, width: 220, height: 140 }, P)
  const refB: CanvasNode = {
    kind: 'heading-reference', id: uuid(11), geometry: { x: 260, y: 20, width: 240, height: 150 },
    articleId: 42, anchor: 'intro', pinnedRevision: 5n,
  }
  const frameC = canvasFrame(12, [uuid(10), uuid(99)], 'Cluster', { x: 40, y: 40, width: 420, height: 300 }, P)

  const model = new CanvasFormModel()
  model.openTitle(doc.title)
  assert.equal(model.isOpen, true)
  expectFields(model.snapshot(), { form: 'title', title: 'Original canvas' })
  model.update({ title: 'Renamed' })
  assert.equal(model.title, 'Renamed')
  assert.equal(model.close(true), false)
  assert.equal(model.isOpen, true)
  assert.equal(model.close(false), true)
  assert.equal(model.isOpen, false)

  model.openNode('plain-text-note', refB)
  expectFields(model.snapshot(), { form: 'node', nodeKind: 'heading-reference', article: '42', anchor: 'intro', pinned: '5' })
  model.openNode('group-frame', frameC)
  model.setFrameMembers([noteA], [])
  assert.deepEqual(model.snapshot().members, [uuid(99)])

  const edge = edgeOf(20, noteA.id, refB.id, 'explicit-reference-note', 0, 'links')
  model.openEdge(edge)
  expectFields(model.snapshot(), { form: 'edge', endpoint: refB.id, edgeKind: 'explicit-reference-note', label: 'links' })
  assert.equal(model.buildEdge({
    selectedNodeId: noteA.id, byId: new Map([[noteA.id, noteA], [refB.id, refB]]), edgeCount: 1, generatedEdgeId: uuid(21),
  })?.id, edge.id)
  model.clearEditing()
  assert.equal(model.isOpen, false)
  expectFields(model.snapshot(), { editingNode: undefined, editingEdge: undefined })

  model.openNode('article-reference')
  model.update({ article: '0' })
  assert.deepEqual(model.buildNode(doc, uuid(30)),
    { ok: false, errorKey: 'author.canvas.enter_a_valid_article_id_and_optional_pinned_revision' })
  model.update({ title: 'Keep me' })
  model.reset(false)
  assert.equal(model.title, 'Keep me')
  model.reset(true)
  assert.equal(model.title, '')
})

test('viewport clamping, zooming, projection, culling, pointer gestures, and keyboard stepping keep exact bounds', () => {
  const note = (n: number, x = 0, y = 0, width = 10_000, height = 5_000) => canvasNote(n, `Note ${n}`, { x, y, width, height }, P)
  const frame = (n: number, x = 0, y = 0) => canvasFrame(n, [], `Frame ${n}`, { x, y, width: 20_000, height: 15_000 }, P)

  for (const [value, expected] of [
    [123.6, 124], [CANVAS_MAX_COORDINATE + 500, CANVAS_MAX_COORDINATE], [-CANVAS_MAX_COORDINATE - 500, -CANVAS_MAX_COORDINATE],
  ] as const) assert.equal(clampCanvasCoordinate(value), expected)
  for (const [vp, delta, expected] of [
    [defaultCanvasViewport, 5000, CANVAS_MAX_ZOOM], [defaultCanvasViewport, -5000, CANVAS_MIN_ZOOM], [{ x: 10, y: 20, zoom: 1000 }, 250, 1250],
  ] as const) assert.equal(zoomCanvasViewport(vp, delta).zoom, expected)
  assert.equal(viewportEquals({ x: 1, y: 2, zoom: 1000 }, { x: 1, y: 2, zoom: 1000 }), true)
  assert.equal(viewportEquals({ x: 1, y: 2, zoom: 1000 }, { x: 1, y: 3, zoom: 1000 }), false)
  assert.deepEqual(focusNodeViewport({ x: 0, y: 0, zoom: 1250 }, note(1, -CANVAS_MAX_COORDINATE + 100, 12_000)),
    { x: -CANVAS_MAX_COORDINATE, y: 8_500, zoom: 1250 })

  const screen = { width: 800, height: 600 }
  const nodes: CanvasNode[] = [
    ...Array.from({ length: CANVAS_NODES_ON_SCREEN + 20 }, (_, i) => note(i + 1, 1000, 1000)),
    frame(999, 1000, 1000),
  ]
  const selectedId = uuid(CANVAS_NODES_ON_SCREEN + 15)
  const visible = queryVisibleCanvasNodes(nodes, new Map(nodes.map(n => [n.id, n])), defaultCanvasViewport, screen, selectedId)
  assert.equal(visible.length, CANVAS_NODES_ON_SCREEN)
  assert.equal(visible.some(box => box.node.id === selectedId), true)

  const layered = [note(1, 0, 0), frame(2, 0, 0), note(3, 50_000, 0)]
  const withFrame = queryVisibleCanvasNodes(layered, new Map(layered.map(n => [n.id, n])), defaultCanvasViewport, screen)
  assert.equal(withFrame.map(box => box.node.id).join(','), `${uuid(2)},${uuid(1)},${uuid(3)}`)

  const offscreen = note(500, 200_000, 200_000)
  const edges = Array.from({ length: CANVAS_EDGES_ON_SCREEN + 10 }, (_, i) => edgeOf(2000 + i, uuid(1), uuid(2), 'visual-only', i))
  const twoNodes = [note(1, 0, 0, 10_000, 10_000), note(2, 20_000, 0, 10_000, 10_000), offscreen]
  const twoMap = new Map(twoNodes.map(n => [n.id, n]))
  const visibleEdges = queryVisibleCanvasEdges(
    [edgeOf(3000, offscreen.id, offscreen.id), ...edges],
    queryVisibleCanvasNodes(twoNodes, twoMap, defaultCanvasViewport, screen), twoMap, defaultCanvasViewport,
  )
  assert.equal(visibleEdges.length, CANVAS_EDGES_ON_SCREEN)
  assert.equal(visibleEdges[0]?.edge.id, uuid(2000))
  expectFields(visibleEdges[0], { x1: 50, y1: 50, x2: 250, y2: 50 })
  expectFields(projectCanvasNode(note(1, 10_000, 20_000, 10_000, 10_000), { x: 5_000, y: 10_000, zoom: 2000 }),
    { x: 100, y: 200, width: 200, height: 200 })

  const item = note(1, 1000, 2000)
  const nodeDrag = createCanvasGesture(1, 100, 100, defaultCanvasViewport, item)
  assert.equal(stepCanvasGesture(nodeDrag, 102, 101), undefined)
  assert.equal(nodeDrag.moved, false)
  assert.deepEqual(stepCanvasGesture(nodeDrag, 104, 100), { x: 1400, y: 2000 })
  assert.equal(nodeDrag.moved, true)
  assert.deepEqual(stepCanvasGesture(nodeDrag, 101, 100), { x: 1100, y: 2000 })
  assert.equal(commitCanvasGesture(nodeDrag, 100, 100), undefined)
  assert.deepEqual(commitCanvasGesture(nodeDrag, 152, 135), { kind: 'node', id: item.id, geometry: { ...item.geometry, x: 6200, y: 5500 } })
  assert.deepEqual(commitCanvasGesture(createCanvasGesture(2, 200, 200, { x: 0, y: 0, zoom: 1250 }), 150, 225),
    { kind: 'viewport', viewport: { x: 4000, y: -2000, zoom: 1250 } })

  assert.equal(stepCanvasArrow('Enter', false, { kind: 'node', node: item }), undefined)
  assert.deepEqual(stepCanvasArrow('ArrowRight', false, { kind: 'node', node: item }),
    { kind: 'node', id: item.id, geometry: { ...item.geometry, x: 1800, y: 2000 } })
  assert.deepEqual(stepCanvasArrow('ArrowDown', true, { kind: 'node', node: item }),
    { kind: 'node', id: item.id, geometry: { ...item.geometry, x: 1000, y: 5200 } })
  assert.equal(stepCanvasArrow('ArrowRight', false, { kind: 'node', node: note(2, CANVAS_MAX_COORDINATE, 0) }), undefined)
  const vp: CanvasViewport = { x: 0, y: 0, zoom: 1000 }
  assert.deepEqual(stepCanvasArrow('ArrowRight', false, { kind: 'viewport', viewport: vp }), { kind: 'viewport', viewport: { x: 3200, y: 0, zoom: 1000 } })
  assert.deepEqual(stepCanvasArrow('ArrowLeft', true, { kind: 'viewport', viewport: vp }), { kind: 'viewport', viewport: { x: -12_800, y: 0, zoom: 1000 } })
  for (const [key, current, expected] of [
    ['Home', 2, 0], ['End', 1, 4], ['PageUp', 0, 0], ['PageDown', 4, 4],
    ['PageDown', 1, 2], ['PageUp', -1, undefined], ['Tab', 1, undefined],
  ] as const) assert.equal(rovingCanvasNodeIndex(key, current, 5), expected)
})
