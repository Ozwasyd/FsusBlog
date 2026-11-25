import type { CanvasGeometry, CanvasGraphEdge, CanvasNode, CanvasViewport } from '../../../Contracts/canvas-graph.ts'

export const CANVAS_NODES_ON_SCREEN = 100
export const CANVAS_EDGES_ON_SCREEN = 200
export const CANVAS_MAX_COORDINATE = 1_000_000_000
export const CANVAS_MIN_ZOOM = 100
export const CANVAS_MAX_ZOOM = 4000
export const CANVAS_DRAG_THRESHOLD_PX = 4
export const CANVAS_NODE_ARROW_STEP = 800
export const CANVAS_PAN_ARROW_STEP = 3_200
export const CANVAS_ARROW_SHIFT_MULTIPLIER = 4
export const CANVAS_SHOW_NODE_OFFSET = 3500

export type CanvasSurfaceSize = Readonly<{ width: number; height: number }>
export type CanvasPoint = Readonly<{ x: number; y: number }>
export type ProjectedCanvasNode = Readonly<{ node: CanvasNode; x: number; y: number; width: number; height: number }>
export type ProjectedCanvasEdge = Readonly<{ edge: CanvasGraphEdge; x1: number; y1: number; x2: number; y2: number }>

export type CanvasGesture = {
  pointer: number; startX: number; startY: number; zoom: number; original: { x: number; y: number }; moved: boolean
} & ({ kind: 'node'; id: string; geometry: CanvasGeometry } | { kind: 'pan'; viewport: CanvasViewport })

export type CanvasGestureCommit =
  | Readonly<{ kind: 'node'; id: string; geometry: CanvasGeometry }>
  | Readonly<{ kind: 'viewport'; viewport: CanvasViewport }>
export type CanvasArrowStep = CanvasGestureCommit

const arrowDeltas: Record<string, readonly [number, number]> = {
  ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
}

export const clampCanvasCoordinate = (value: number): number => Math.max(-CANVAS_MAX_COORDINATE, Math.min(CANVAS_MAX_COORDINATE, Math.round(value)))
export const clampCanvasZoom = (value: number): number => Math.min(CANVAS_MAX_ZOOM, Math.max(CANVAS_MIN_ZOOM, Math.round(value)))
export const viewportEquals = (left: CanvasViewport, right: CanvasViewport): boolean => left.x === right.x && left.y === right.y && left.zoom === right.zoom
export const zoomCanvasViewport = (viewport: CanvasViewport, delta: number): CanvasViewport => ({ ...viewport, zoom: clampCanvasZoom(viewport.zoom + delta) })
export const focusNodeViewport = (viewport: CanvasViewport, node: CanvasNode): CanvasViewport => ({
  ...viewport,
  x: Math.max(-CANVAS_MAX_COORDINATE, node.geometry.x - CANVAS_SHOW_NODE_OFFSET),
  y: Math.max(-CANVAS_MAX_COORDINATE, node.geometry.y - CANVAS_SHOW_NODE_OFFSET),
})

export function projectCanvasNode(node: CanvasNode, viewport: CanvasViewport, box: CanvasGeometry = node.geometry): ProjectedCanvasNode {
  const scale = (viewport.zoom / 1000) / 100
  return { node, x: (box.x - viewport.x) * scale, y: (box.y - viewport.y) * scale, width: box.width * scale, height: box.height * scale }
}

export function queryVisibleCanvasNodes(
  nodes: readonly CanvasNode[], nodesById: ReadonlyMap<string, CanvasNode>,
  viewport: CanvasViewport, size: CanvasSurfaceSize, selectedNodeId?: string | null,
): ProjectedCanvasNode[] {
  const result: ProjectedCanvasNode[] = []
  const inside = (box: ProjectedCanvasNode) => box.x + box.width >= 0 && box.y + box.height >= 0 && box.x <= size.width && box.y <= size.height
  const selected = selectedNodeId ? nodesById.get(selectedNodeId) : undefined
  const selectedBox = selected ? projectCanvasNode(selected, viewport, selected.geometry) : undefined
  if (selectedBox && inside(selectedBox)) result.push(selectedBox)
  for (const node of nodes) {
    if (node === selected) continue
    const box = projectCanvasNode(node, viewport, node.geometry)
    if (inside(box)) result.push(box)
    if (result.length === CANVAS_NODES_ON_SCREEN) break
  }
  // Frames sit beneath their contents. UUID/revision authority stays with the document.
  return result.sort((left, right) => Number(left.node.kind !== 'group-frame') - Number(right.node.kind !== 'group-frame'))
}

export function queryVisibleCanvasEdges(
  edges: readonly CanvasGraphEdge[], visibleNodes: readonly ProjectedCanvasNode[],
  nodesById: ReadonlyMap<string, CanvasNode>, viewport: CanvasViewport,
  resolveGeometry: (node: CanvasNode) => CanvasGeometry = node => node.geometry,
): ProjectedCanvasEdge[] {
  const shown = new Set(visibleNodes.map(box => box.node.id))
  const lines: ProjectedCanvasEdge[] = []
  for (const edge of edges) {
    if (!shown.has(edge.sourceNodeId) && !shown.has(edge.targetNodeId)) continue
    const source = nodesById.get(edge.sourceNodeId), target = nodesById.get(edge.targetNodeId)
    if (!source || !target) continue
    const from = projectCanvasNode(source, viewport, resolveGeometry(source))
    const to = projectCanvasNode(target, viewport, resolveGeometry(target))
    lines.push({ edge, x1: from.x + from.width / 2, y1: from.y + from.height / 2, x2: to.x + to.width / 2, y2: to.y + to.height / 2 })
    if (lines.length === CANVAS_EDGES_ON_SCREEN) break
  }
  return lines
}

export function createCanvasGesture(pointer: number, clientX: number, clientY: number, viewport: CanvasViewport, node?: CanvasNode): CanvasGesture {
  const original = node?.geometry ?? viewport
  const base = { pointer, startX: clientX, startY: clientY, zoom: viewport.zoom / 1000, original: { x: original.x, y: original.y }, moved: false }
  return node ? { ...base, kind: 'node', id: node.id, geometry: node.geometry } : { ...base, kind: 'pan', viewport }
}

export function stepCanvasGesture(drag: CanvasGesture, clientX: number, clientY: number): CanvasPoint | undefined {
  const dx = clientX - drag.startX, dy = clientY - drag.startY
  if (Math.abs(dx) + Math.abs(dy) < CANVAS_DRAG_THRESHOLD_PX && !drag.moved) return undefined
  drag.moved = true
  const direction = drag.kind === 'node' ? 1 : -1
  return { x: clampCanvasCoordinate(drag.original.x + direction * dx * 100 / drag.zoom), y: clampCanvasCoordinate(drag.original.y + direction * dy * 100 / drag.zoom) }
}

export function commitCanvasGesture(drag: CanvasGesture, clientX: number, clientY: number): CanvasGestureCommit | undefined {
  const next = stepCanvasGesture(drag, clientX, clientY)
  if (!next || (next.x === drag.original.x && next.y === drag.original.y)) return undefined
  return drag.kind === 'node' ? { kind: 'node', id: drag.id, geometry: { ...drag.geometry, ...next } } : { kind: 'viewport', viewport: { ...drag.viewport, ...next } }
}

export function stepCanvasArrow(
  key: string, shiftKey: boolean, target: { kind: 'node'; node: CanvasNode } | { kind: 'viewport'; viewport: CanvasViewport },
): CanvasArrowStep | undefined {
  const delta = arrowDeltas[key]
  if (!delta) return undefined
  const original = target.kind === 'node' ? target.node.geometry : target.viewport
  const step = (target.kind === 'node' ? CANVAS_NODE_ARROW_STEP : CANVAS_PAN_ARROW_STEP) * (shiftKey ? CANVAS_ARROW_SHIFT_MULTIPLIER : 1)
  const next = { x: clampCanvasCoordinate(original.x + delta[0] * step), y: clampCanvasCoordinate(original.y + delta[1] * step) }
  if (next.x === original.x && next.y === original.y) return undefined
  return target.kind === 'node' ? { kind: 'node', id: target.node.id, geometry: { ...target.node.geometry, ...next } } : { kind: 'viewport', viewport: { ...target.viewport, ...next } }
}

export function rovingCanvasNodeIndex(key: string, currentIndex: number, length: number): number | undefined {
  if (currentIndex < 0 || length <= 0) return undefined
  if (key === 'Home') return 0
  if (key === 'End') return length - 1
  if (key === 'PageDown') return Math.min(length - 1, currentIndex + 1)
  return key === 'PageUp' ? Math.max(0, currentIndex - 1) : undefined
}
