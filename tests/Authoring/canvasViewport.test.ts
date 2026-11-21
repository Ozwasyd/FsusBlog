import { strict as assert } from 'node:assert'
import test from 'node:test'
import { defaultCanvasViewport, type CanvasGraphEdge, type CanvasNode, type CanvasViewport } from '../../src/Contracts/canvas-graph.ts'
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

const uuid = (n: number) => `11111111-0000-4000-8000-${String(n).padStart(12, '0')}`
const note = (n: number, x = 0, y = 0, width = 10_000, height = 5_000): CanvasNode => ({
  id: uuid(n),
  kind: 'plain-text-note',
  geometry: { x, y, width, height },
  text: `Note ${n}`,
})
const frame = (n: number, x = 0, y = 0): CanvasNode => ({
  id: uuid(n),
  kind: 'group-frame',
  geometry: { x, y, width: 20_000, height: 15_000 },
  text: `Frame ${n}`,
  memberIds: [],
})

test('viewport clamping, zooming, equality, and node focusing respect coordinate bounds', () => {
  assert.equal(clampCanvasCoordinate(123.6), 124)
  assert.equal(clampCanvasCoordinate(CANVAS_MAX_COORDINATE + 500), CANVAS_MAX_COORDINATE)
  assert.equal(clampCanvasCoordinate(-CANVAS_MAX_COORDINATE - 500), -CANVAS_MAX_COORDINATE)

  assert.equal(zoomCanvasViewport(defaultCanvasViewport, 5000).zoom, CANVAS_MAX_ZOOM)
  assert.equal(zoomCanvasViewport(defaultCanvasViewport, -5000).zoom, CANVAS_MIN_ZOOM)
  assert.equal(zoomCanvasViewport({ x: 10, y: 20, zoom: 1000 }, 250).zoom, 1250)

  assert.equal(viewportEquals({ x: 1, y: 2, zoom: 1000 }, { x: 1, y: 2, zoom: 1000 }), true)
  assert.equal(viewportEquals({ x: 1, y: 2, zoom: 1000 }, { x: 1, y: 3, zoom: 1000 }), false)

  const nearMin = note(1, -CANVAS_MAX_COORDINATE + 100, 12_000)
  assert.deepEqual(focusNodeViewport({ x: 0, y: 0, zoom: 1250 }, nearMin), {
    x: -CANVAS_MAX_COORDINATE,
    y: 8_500,
    zoom: 1250,
  })
})

test('spatial projection and culling prioritize selected node, cap visible nodes/edges, and layer frames underneath', () => {
  const nodes: CanvasNode[] = [
    ...Array.from({ length: CANVAS_NODES_ON_SCREEN + 20 }, (_, i) => note(i + 1, 1000, 1000)),
    frame(999, 1000, 1000),
  ]
  const byId = new Map(nodes.map(item => [item.id, item]))
  const selectedId = uuid(CANVAS_NODES_ON_SCREEN + 15)
  const visible = queryVisibleCanvasNodes(nodes, byId, defaultCanvasViewport, { width: 800, height: 600 }, selectedId)
  assert.equal(visible.length, CANVAS_NODES_ON_SCREEN)
  assert.equal(visible.some(box => box.node.id === selectedId), true)

  const withFrame = queryVisibleCanvasNodes(
    [note(1, 0, 0), frame(2, 0, 0), note(3, 50_000, 0)],
    new Map([
      [uuid(1), note(1, 0, 0)],
      [uuid(2), frame(2, 0, 0)],
      [uuid(3), note(3, 50_000, 0)],
    ]),
    defaultCanvasViewport,
    { width: 800, height: 600 },
  )
  assert.equal(withFrame.map(box => box.node.id).join(','), `${uuid(2)},${uuid(1)},${uuid(3)}`)

  const offscreen = note(500, 200_000, 200_000)
  const edges: CanvasGraphEdge[] = [
    ...Array.from({ length: CANVAS_EDGES_ON_SCREEN + 10 }, (_, i) => ({
      id: uuid(2000 + i),
      kind: 'visual-only' as const,
      sourceNodeId: uuid(1),
      targetNodeId: uuid(2),
      order: i,
      label: null,
    })),
  ]
  const twoNodes = [note(1, 0, 0, 10_000, 10_000), note(2, 20_000, 0, 10_000, 10_000), offscreen]
  const twoMap = new Map(twoNodes.map(item => [item.id, item]))
  const visibleTwo = queryVisibleCanvasNodes(twoNodes, twoMap, defaultCanvasViewport, { width: 800, height: 600 })
  const visibleEdges = queryVisibleCanvasEdges(
    [
      { id: uuid(3000), kind: 'visual-only', sourceNodeId: offscreen.id, targetNodeId: offscreen.id, order: 0, label: null },
      ...edges,
    ],
    visibleTwo,
    twoMap,
    defaultCanvasViewport,
  )
  assert.equal(visibleEdges.length, CANVAS_EDGES_ON_SCREEN)
  assert.equal(visibleEdges[0]?.edge.id, uuid(2000))
  assert.deepEqual(
    { x1: visibleEdges[0]?.x1, y1: visibleEdges[0]?.y1, x2: visibleEdges[0]?.x2, y2: visibleEdges[0]?.y2 },
    { x1: 50, y1: 50, x2: 250, y2: 50 },
  )

  const scaled = projectCanvasNode(note(1, 10_000, 20_000, 10_000, 10_000), { x: 5_000, y: 10_000, zoom: 2000 })
  assert.deepEqual({ x: scaled.x, y: scaled.y, width: scaled.width, height: scaled.height }, {
    x: 100, y: 200, width: 200, height: 200,
  })
})

test('pointer gesture enforces threshold with hysteresis, directionality, and suppresses no-op commits', () => {
  const item = note(1, 1000, 2000)
  const nodeDrag = createCanvasGesture(1, 100, 100, defaultCanvasViewport, item)
  assert.equal(stepCanvasGesture(nodeDrag, 102, 101), undefined)
  assert.equal(nodeDrag.moved, false)
  // Cross threshold >= 4px Manhattan distance.
  assert.deepEqual(stepCanvasGesture(nodeDrag, 104, 100), { x: 1400, y: 2000 })
  assert.equal(nodeDrag.moved, true)
  // Hysteresis keeps tracking if pointer moves back inside 4px after starting.
  assert.deepEqual(stepCanvasGesture(nodeDrag, 101, 100), { x: 1100, y: 2000 })
  // Committing back on the exact original coordinate produces no write.
  assert.equal(commitCanvasGesture(nodeDrag, 100, 100), undefined)
  assert.deepEqual(commitCanvasGesture(nodeDrag, 152, 135), {
    kind: 'node',
    id: item.id,
    geometry: { ...item.geometry, x: 6200, y: 5500 },
  })

  const panDrag = createCanvasGesture(2, 200, 200, { x: 0, y: 0, zoom: 1250 })
  assert.deepEqual(commitCanvasGesture(panDrag, 150, 225), {
    kind: 'viewport',
    viewport: { x: 4000, y: -2000, zoom: 1250 },
  })
})

test('keyboard stepping and roving focus handle multipliers, boundaries, and clamping', () => {
  const target = note(1, 1000, 2000)
  assert.equal(stepCanvasArrow('Enter', false, { kind: 'node', node: target }), undefined)
  assert.deepEqual(stepCanvasArrow('ArrowRight', false, { kind: 'node', node: target }), {
    kind: 'node',
    id: target.id,
    geometry: { ...target.geometry, x: 1800, y: 2000 },
  })
  assert.deepEqual(stepCanvasArrow('ArrowDown', true, { kind: 'node', node: target }), {
    kind: 'node',
    id: target.id,
    geometry: { ...target.geometry, x: 1000, y: 5200 },
  })
  const clampedNode = note(2, CANVAS_MAX_COORDINATE, 0)
  assert.equal(stepCanvasArrow('ArrowRight', false, { kind: 'node', node: clampedNode }), undefined)

  const vp: CanvasViewport = { x: 0, y: 0, zoom: 1000 }
  assert.deepEqual(stepCanvasArrow('ArrowRight', false, { kind: 'viewport', viewport: vp }), {
    kind: 'viewport',
    viewport: { x: 3200, y: 0, zoom: 1000 },
  })
  assert.deepEqual(stepCanvasArrow('ArrowLeft', true, { kind: 'viewport', viewport: vp }), {
    kind: 'viewport',
    viewport: { x: -12_800, y: 0, zoom: 1000 },
  })

  assert.equal(rovingCanvasNodeIndex('Home', 2, 5), 0)
  assert.equal(rovingCanvasNodeIndex('End', 1, 5), 4)
  assert.equal(rovingCanvasNodeIndex('PageUp', 0, 5), 0)
  assert.equal(rovingCanvasNodeIndex('PageDown', 4, 5), 4)
  assert.equal(rovingCanvasNodeIndex('PageDown', 1, 5), 2)
  assert.equal(rovingCanvasNodeIndex('PageUp', -1, 5), undefined)
  assert.equal(rovingCanvasNodeIndex('Tab', 1, 5), undefined)
})
