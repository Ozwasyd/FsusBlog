<script setup lang="ts">
import { t, type MessageKey } from '../siteLocale'
import { computed, onMounted, onScopeDispose, ref, shallowRef, useId, watch } from 'vue'
import type { CanvasGeometry, CanvasGraphEdge, CanvasNode, CanvasViewport } from '../../../Contracts/canvas-graph'
import {
  commitCanvasGesture,
  createCanvasGesture,
  projectCanvasNode,
  queryVisibleCanvasEdges,
  queryVisibleCanvasNodes,
  rovingCanvasNodeIndex,
  stepCanvasArrow,
  stepCanvasGesture,
  type CanvasGesture,
} from './canvasViewport'

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

const board = ref<HTMLElement>()
const keyboardHelpId = useId()
const size = shallowRef({ width: 0, height: 0 })
const position = shallowRef<{ x: number; y: number }>()
const nodesById = computed(() => new Map(props.nodes.map(node => [node.id, node])))
const labels: Record<CanvasNode['kind'], MessageKey> = {
  'article-reference': 'author.properties.articleReference',
  'heading-reference': 'author.canvasBoard.headingReference',
  'block-reference': 'author.canvasBoard.blockReference',
  'plain-text-note': 'author.canvas.note',
  'group-frame': 'author.canvas.frame',
}

const gesture = shallowRef<CanvasGesture>()
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

// Move one transient node without recomputing the authoritative viewport query at every frame.
const idleProjection = computed(() =>
  queryVisibleCanvasNodes(props.nodes, nodesById.value, props.viewport, size.value, props.selectedNodeId),
)

const visibleNodes = computed(() => {
  const drag = gesture.value
  if (!drag || !position.value) return idleProjection.value
  if (drag.kind === 'pan') {
    return queryVisibleCanvasNodes(props.nodes, nodesById.value, viewport.value, size.value, props.selectedNodeId)
  }
  return idleProjection.value.map(box =>
    box.node.id === drag.id ? projectCanvasNode(box.node, viewport.value, geometry(box.node)) : box,
  )
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

const visibleEdges = computed(() =>
  queryVisibleCanvasEdges(props.edges, visibleNodes.value, nodesById.value, viewport.value, geometry),
)

function description(node: CanvasNode): string {
  if (node.kind === 'plain-text-note') return node.text.slice(0, 240)
  if (node.kind === 'group-frame') return node.text
  const destination = node.kind === 'article-reference' ? t('author.canvasBoard.article', { article: node.articleId })
    : t('author.canvasBoard.anchor', { article: node.articleId, anchor: node.anchor })
  return node.pinnedRevision === null ? destination : t('author.canvasBoard.revision', { destination, revision: node.pinnedRevision.toString() })
}

function begin(event: PointerEvent, node?: CanvasNode) {
  if (props.disabled || !event.isPrimary || event.button !== 0 || !board.value || gesture.value) return
  gesture.value = createCanvasGesture(event.pointerId, event.clientX, event.clientY, props.viewport, node)
  board.value.setPointerCapture(event.pointerId)
  if (node) {
    if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus({ preventScroll: true })
    emit('select-node', node.id)
  } else {
    board.value.focus({ preventScroll: true })
  }
}

function move(event: PointerEvent) {
  const drag = gesture.value
  if (!drag || drag.pointer !== event.pointerId) return
  pending = stepCanvasGesture(drag, event.clientX, event.clientY)
  if (!pending || frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    if (gesture.value === drag) position.value = pending
  })
}

function finish(event: PointerEvent) {
  const drag = gesture.value
  if (!drag || drag.pointer !== event.pointerId) return
  const committed = commitCanvasGesture(drag, event.clientX, event.clientY)
  stopGesture()
  if (!committed || props.disabled) return
  if (committed.kind === 'node') emit('move-node', committed.id, committed.geometry)
  else emit('viewport', committed.viewport)
}

function cancel(event: PointerEvent) {
  if (gesture.value?.pointer === event.pointerId) stopGesture()
}

function arrow(event: KeyboardEvent, node?: CanvasNode) {
  if (props.disabled || event.altKey || event.ctrlKey || event.metaKey) return
  if (!node && event.target !== board.value) return
  if (node && props.selectedNodeId !== node.id) return
  const stepped = stepCanvasArrow(
    event.key,
    event.shiftKey,
    node ? { kind: 'node', node } : { kind: 'viewport', viewport: props.viewport },
  )
  if (!stepped) return
  event.preventDefault()
  if (stepped.kind === 'node') emit('move-node', stepped.id, stepped.geometry)
  else emit('viewport', stepped.viewport)
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
  const destination = rovingCanvasNodeIndex(event.key, index, list.length)
  const next = destination === undefined ? undefined : list[destination]
  if (!next) return
  event.preventDefault()
  const selector = `#canvas-board-node-${next.node.id}`
  board.value.querySelector<HTMLButtonElement>(selector)?.focus({ preventScroll: true })
}
</script>

<template>
  <div class="canvas-board-group">
  <p :id="keyboardHelpId" class="canvas-board__help">
    {{ t('author.canvasBoard.keyboardHelp') }}
  </p>
  <section
    ref="board" class="canvas-board" role="region" :aria-label="t('author.canvasBoard.viewport')" tabindex="0" :aria-describedby="keyboardHelpId"
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
      <span class="canvas-board__kind">{{ t(labels[box.node.kind]) }}</span>
      <span class="canvas-board__description">{{ description(box.node) }}</span>
    </button>
    <p v-if="nodes.length === 0" class="canvas-board__empty">{{ t('author.canvasBoard.empty') }}</p>
    <p v-else-if="visibleNodes.length === 0" class="canvas-board__empty">{{ t('author.canvasBoard.outside') }}</p>
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
