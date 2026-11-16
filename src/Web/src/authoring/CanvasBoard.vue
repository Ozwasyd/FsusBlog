<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, shallowRef, useId, watch } from 'vue'
import type { CanvasGeometry, CanvasGraphEdge, CanvasNode, CanvasViewport } from '../../../Contracts/canvas-graph'

const props = defineProps<{
  nodes: readonly CanvasNode[]
  edges: readonly CanvasGraphEdge[]
  viewport: CanvasViewport
  selectedNodeId?: string | null
  selectedEdgeId?: string | null
  focusRequestId?: string
  disabled?: boolean
}>()

const emit = defineEmits<{
  'select-node': [id: string]
  'select-edge': [id: string]
  'move-node': [id: string, geometry: CanvasGeometry]
  viewport: [viewport: CanvasViewport]
  'focus-request-handled': []
}>()

const nodesOnScreen = 100
const edgesOnScreen = 200
const maxCoordinate = 1_000_000_000
const point = (value: number) => Math.max(-maxCoordinate, Math.min(maxCoordinate, Math.round(value)))
const board = ref<HTMLElement>()
const keyboardHelpId = useId()
const size = shallowRef({ width: 0, height: 0 })
const position = shallowRef<{ x: number; y: number }>()
const nodesById = computed(() => new Map(props.nodes.map(node => [node.id, node])))
const graphZoom = computed(() => props.viewport.zoom / 1000)
const labels: Record<CanvasNode['kind'], string> = {
  'article-reference': 'Article reference',
  'heading-reference': 'Heading reference',
  'block-reference': 'Block reference',
  'plain-text-note': 'Note',
  'group-frame': 'Frame',
}

type Gesture = {
  pointer: number
  startX: number
  startY: number
  zoom: number
  original: { x: number; y: number }
  moved: boolean
} & ({ kind: 'node'; id: string; geometry: CanvasGeometry } | { kind: 'pan'; viewport: CanvasViewport })

const gesture = shallowRef<Gesture>()
const nodeFocus = ref<string>()
let frame = 0
let observer: ResizeObserver | undefined
let pending: { x: number; y: number } | undefined

function stopGesture() {
  const previous = gesture.value
  gesture.value = undefined
  position.value = undefined
  pending = undefined
  if (frame) cancelAnimationFrame(frame)
  frame = 0
  if (previous && board.value?.hasPointerCapture(previous.pointer)) {
    board.value.releasePointerCapture(previous.pointer)
  }
}

onMounted(() => {
  if (!board.value) return
  observer = new ResizeObserver(([entry]) => {
    if (entry) size.value = { width: entry.contentRect.width, height: entry.contentRect.height }
  })
  observer.observe(board.value)
})

onScopeDispose(() => {
  observer?.disconnect()
  stopGesture()
})

watch(() => [props.disabled, props.nodes, props.viewport], stopGesture)

const viewport = computed(() => gesture.value?.kind === 'pan' && position.value
  ? { ...props.viewport, ...position.value }
  : props.viewport)

function geometry(node: CanvasNode) {
  return gesture.value?.kind === 'node' && gesture.value.id === node.id && position.value
    ? { ...node.geometry, ...position.value }
    : node.geometry
}

function project(node: CanvasNode, view: CanvasViewport = viewport.value, box: CanvasGeometry = geometry(node)) {
  const scale = graphZoom.value / 100
  return {
    node,
    x: (box.x - view.x) * scale,
    y: (box.y - view.y) * scale,
    width: box.width * scale,
    height: box.height * scale,
  }
}

function spatialQuery(nodes: readonly CanvasNode[], view: CanvasViewport) {
  const result: ReturnType<typeof project>[] = []
  const inside = (box: ReturnType<typeof project>) => box.x + box.width >= 0 && box.y + box.height >= 0
    && box.x <= size.value.width && box.y <= size.value.height
  const selected = props.selectedNodeId && nodesById.value.get(props.selectedNodeId)
  const selectedBox = selected ? project(selected, view, selected.geometry) : undefined
  if (selectedBox && inside(selectedBox)) result.push(selectedBox)
  for (const node of nodes) {
    if (node === selected) continue
    const box = project(node, view, node.geometry)
    if (inside(box)) result.push(box)
    if (result.length === nodesOnScreen) break
  }
  // Frames sit beneath their contents. UUID/revision authority stays with the document.
  return result.sort((left, right) => Number(left.node.kind !== 'group-frame') - Number(right.node.kind !== 'group-frame'))
}

// Move one transient node without recomputing the authoritative viewport query at every frame.
const idleProjection = computed(() => spatialQuery(props.nodes, props.viewport))

const visibleNodes = computed(() => {
  const drag = gesture.value
  if (!drag || !position.value) return idleProjection.value
  if (drag.kind === 'pan') return spatialQuery(props.nodes, viewport.value)
  return idleProjection.value.map(box => box.node.id === drag.id ? project(box.node) : box)
})

watch([visibleNodes, () => props.focusRequestId, () => props.disabled], ([boxes, requested, disabled]) => {
  if (!requested || disabled || !boxes.some(box => box.node.id === requested)) return
  const target = board.value?.querySelector<HTMLButtonElement>(`#canvas-board-node-${requested}`)
  if (!target) return
  target.focus()
  emit('focus-request-handled')
}, { flush: 'post' })

const firstNode = computed(() => visibleNodes.value.find(box => box.node.id === nodeFocus.value)?.node.id
  ?? visibleNodes.value.find(box => box.node.id === props.selectedNodeId)?.node.id
  ?? visibleNodes.value[0]?.node.id)

const visibleEdges = computed(() => {
  const shown = new Set(visibleNodes.value.map(box => box.node.id))
  const lines: { edge: CanvasGraphEdge; x1: number; x2: number; y1: number; y2: number }[] = []
  for (const edge of props.edges) {
    if (!shown.has(edge.sourceNodeId) && !shown.has(edge.targetNodeId)) continue
    const source = nodesById.value.get(edge.sourceNodeId)
    const target = nodesById.value.get(edge.targetNodeId)
    if (!source || !target) continue
    const from = project(source)
    const to = project(target)
    lines.push({
      edge,
      x1: from.x + from.width / 2,
      y1: from.y + from.height / 2,
      x2: to.x + to.width / 2,
      y2: to.y + to.height / 2,
    })
    if (lines.length === edgesOnScreen) break
  }
  return lines
})

function description(node: CanvasNode): string {
  if (node.kind === 'plain-text-note') return node.text.slice(0, 240)
  if (node.kind === 'group-frame') return node.text
  const destination = node.kind === 'article-reference' ? `Article #${node.articleId}`
    : `Article #${node.articleId} · ${node.anchor}`
  return node.pinnedRevision === null ? destination : `${destination} · Revision ${node.pinnedRevision}`
}

function begin(event: PointerEvent, node?: CanvasNode) {
  if (props.disabled || !event.isPrimary || event.button !== 0 || !board.value || gesture.value) return
  const original = node?.geometry ?? props.viewport
  const base = {
    pointer: event.pointerId, startX: event.clientX, startY: event.clientY, zoom: graphZoom.value,
    original: { x: original.x, y: original.y }, moved: false,
  }
  gesture.value = node
    ? { ...base, kind: 'node', id: node.id, geometry: node.geometry }
    : { ...base, kind: 'pan', viewport: props.viewport }
  board.value.setPointerCapture(event.pointerId)
  if (node) {
    if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus({ preventScroll: true })
    emit('select-node', node.id)
  } else {
    board.value.focus({ preventScroll: true })
  }
}

function pointerPosition(event: PointerEvent, drag: Gesture) {
  const dx = event.clientX - drag.startX
  const dy = event.clientY - drag.startY
  if (Math.abs(dx) + Math.abs(dy) < 4 && !drag.moved) return
  drag.moved = true
  const direction = drag.kind === 'node' ? 1 : -1
  return {
    x: point(drag.original.x + direction * dx * 100 / drag.zoom),
    y: point(drag.original.y + direction * dy * 100 / drag.zoom),
  }
}

function move(event: PointerEvent) {
  const drag = gesture.value
  if (!drag || drag.pointer !== event.pointerId) return
  pending = pointerPosition(event, drag)
  if (!pending || frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    if (gesture.value === drag) position.value = pending
  })
}

function finish(event: PointerEvent) {
  const drag = gesture.value
  if (!drag || drag.pointer !== event.pointerId) return
  const next = pointerPosition(event, drag)
  stopGesture()
  if (!next || props.disabled || (next.x === drag.original.x && next.y === drag.original.y)) return
  if (drag.kind === 'node') emit('move-node', drag.id, { ...drag.geometry, ...next })
  else emit('viewport', { ...drag.viewport, ...next })
}

function cancel(event: PointerEvent) {
  if (gesture.value?.pointer === event.pointerId) stopGesture()
}

function arrow(event: KeyboardEvent, node?: CanvasNode) {
  if (props.disabled || event.altKey || event.ctrlKey || event.metaKey) return
  if (!node && event.target !== board.value) return
  const deltas: Record<string, readonly [number, number]> = {
    ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
  }
  const delta = deltas[event.key]
  if (!delta) return
  if (node && props.selectedNodeId !== node.id) return
  event.preventDefault()
  const multiplier = event.shiftKey ? 4 : 1
  const original = node?.geometry ?? props.viewport
  const step = (node ? 800 : 3_200) * multiplier
  const next = { x: point(original.x + delta[0] * step), y: point(original.y + delta[1] * step) }
  if (next.x === original.x && next.y === original.y) return
  if (node) emit('move-node', node.id, { ...node.geometry, ...next })
  else emit('viewport', { ...props.viewport, ...next })
}

function boardKeys(event: KeyboardEvent) {
  if (event.key === 'Escape' && gesture.value) {
    event.preventDefault()
    stopGesture()
  } else arrow(event)
}

function focusVisible(event: KeyboardEvent, node: CanvasNode) {
  if (props.disabled || event.altKey || event.ctrlKey || event.metaKey || gesture.value) return
  if (!['Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) return
  const list = visibleNodes.value
  const index = list.findIndex(box => box.node.id === node.id)
  if (index < 0 || !board.value) return
  const destination = event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1
    : Math.max(0, Math.min(list.length - 1, index + (event.key === 'PageDown' ? 1 : -1)))
  const next = list[destination]
  if (!next) return
  event.preventDefault()
  const selector = `#canvas-board-node-${next.node.id}`
  board.value.querySelector<HTMLButtonElement>(selector)?.focus({ preventScroll: true })
}
</script>

<template>
  <div class="canvas-board-group">
  <p :id="keyboardHelpId" class="canvas-board__help">
    Page Up/Down: focus previous/next visible node. Home/End: first/last. Enter/Space: select.
    Arrow keys: move the selected node, or pan when the viewport is focused. Shift: move faster.
    Tab: leave the nodes. Use Outline to find nodes outside the viewport and connections.
  </p>
  <section
    ref="board" class="canvas-board" role="region" aria-label="Interactive Canvas Viewport" tabindex="0" :aria-describedby="keyboardHelpId"
    :class="{ panning: gesture?.kind === 'pan' }"
    @pointerdown="begin($event)"
    @pointermove="move" @pointerup="finish" @pointercancel="cancel" @lostpointercapture="cancel"
    @keydown="boardKeys"
  >
    <svg class="canvas-board__edges" aria-hidden="true" width="100%" height="100%">
      <g v-for="line in visibleEdges" :key="line.edge.id"
        :class="{ explicit: line.edge.kind === 'explicit-reference-note', selected: line.edge.id === selectedEdgeId }">
        <line :x1="line.x1" :y1="line.y1" :x2="line.x2" :y2="line.y2" class="canvas-board__line" />
        <line
          v-if="!disabled"
          :x1="line.x1" :y1="line.y1" :x2="line.x2" :y2="line.y2" class="canvas-board__line-hit"
          @pointerdown.stop
          @click.stop="emit('select-edge', line.edge.id)"
        />
      </g>
    </svg>
    <button
      v-for="box in visibleNodes"
      :key="box.node.id"
      :id="`canvas-board-node-${box.node.id}`"
      type="button"
      class="canvas-board__node"
      :class="[{ frame: box.node.kind === 'group-frame', note: box.node.kind === 'plain-text-note' }]"
      :style="{ left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px` }"
      :aria-pressed="selectedNodeId === box.node.id"
      :aria-describedby="keyboardHelpId"
      :tabindex="firstNode === box.node.id ? 0 : -1"
      :disabled="disabled"
      @pointerdown.stop="begin($event, box.node)"
      @focus="nodeFocus = box.node.id"
      @click="!gesture && emit('select-node', box.node.id)"
      @keydown="arrow($event, box.node)"
      @keydown.home.end.page-up.page-down="focusVisible($event, box.node)"
    >
      <span class="canvas-board__kind">{{ labels[box.node.kind] }}</span>
      <span class="canvas-board__description">{{ description(box.node) }}</span>
    </button>
    <p v-if="nodes.length === 0" class="canvas-board__empty">Add a note or reference to begin.</p>
    <p v-else-if="visibleNodes.length === 0" class="canvas-board__empty">No nodes in view. Pan or choose a node in the outline.</p>
  </section>
  </div>
</template>

<style scoped>
.canvas-board-group { min-width: 0; }
.canvas-board__help { color: var(--fsus-color-text-muted); font-size: .875rem; }
.canvas-board {
  position: relative;
  min-block-size: 24rem;
  block-size: min(60vh, 42rem);
  overflow: hidden;
  border: 1px solid var(--fsus-border);
  border-radius: var(--fsus-radius-panel);
  background: radial-gradient(circle, var(--fsus-border) 1px, transparent 1px) 0 0 / 1.25rem 1.25rem, var(--fsus-page);
  color: var(--fsus-ink);
  cursor: grab;
  touch-action: none;
}

.canvas-board.panning { cursor: grabbing; }
.canvas-board__edges { position: absolute; inset: 0; z-index: 1; pointer-events: none; }
.canvas-board__line { stroke: var(--fsus-color-text-muted); stroke-width: 1.5; }
.explicit .canvas-board__line { stroke-dasharray: 5 3; }
.selected .canvas-board__line { stroke: var(--fsus-color-action-primary); stroke-width: 3; }

.canvas-board__line-hit {
  stroke: transparent;
  stroke-width: 12;
  pointer-events: stroke;
  cursor: pointer;
}

.canvas-board__node {
  position: absolute;
  z-index: 2;
  display: flex;
  min-block-size: 0;
  flex-direction: column;
  align-items: flex-start;
  overflow: hidden;
  gap: .3rem;
  border: 1px solid var(--fsus-border);
  border-radius: var(--fsus-radius-panel);
  padding: .4rem;
  background: var(--fsus-paper);
  color: inherit;
  font: inherit;
  text-align: start;
  cursor: grab;
}

.canvas-board__node.frame {
  z-index: 0;
  border-style: dashed;
  background: transparent;
}

.canvas-board__node.note { border-inline-start-width: .2rem; }
.canvas-board__node[aria-pressed="true"] { border-color: var(--fsus-color-action-primary); }
.canvas-board__node:active { cursor: grabbing; }
.canvas-board__node:disabled { cursor: default; }
.canvas-board__node:focus-visible, .canvas-board:focus-visible {
  outline: 2px solid var(--fsus-color-focus-ring, var(--fsus-color-action-primary));
  outline-offset: -2px;
}

.canvas-board__kind { color: var(--fsus-color-text-muted); font-size: .75rem; }
.canvas-board__description { overflow-wrap: anywhere; white-space: pre-line; }

.canvas-board__empty {
  position: relative;
  z-index: 3;
  margin: .75rem;
  color: var(--fsus-color-text-muted);
  pointer-events: none;
}

@media (forced-colors: active) {
  .canvas-board__line { stroke: CanvasText; }
  .selected .canvas-board__line { stroke: Highlight; }
  .canvas-board__node[aria-pressed="true"] { border-color: Highlight; }
}
</style>
