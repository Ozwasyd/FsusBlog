<template>
    <g
        class="canvas-edge-group"
        :class="[`edge-${edge.type}`, { selected }]"
        role="button"
        :aria-label="ariaEdgeLabel"
        :tabindex="0"
        @click.stop="$emit('select', edge.id, $event)"
        @keydown.delete.stop="$emit('delete', edge.id)"
    >
        <!-- Line background for easier clicking -->
        <path
            :d="pathData"
            class="edge-hit-area"
            stroke="transparent"
            stroke-width="16"
            fill="none"
        />

        <!-- Rendered Line -->
        <path
            :d="pathData"
            class="edge-line"
            :class="{ 'is-explicit': edge.type === 'explicit-reference-note' }"
            fill="none"
            :stroke="selected ? '#2563eb' : (edge.type === 'explicit-reference-note' ? '#0284c7' : '#94a3b8')"
            :stroke-width="selected ? 3 : 2"
            :stroke-dasharray="edge.type === 'visual-only' ? '6 4' : 'none'"
            marker-end="url(#edge-arrow)"
        />

        <!-- Edge Label / Action Badge -->
        <g v-if="edge.label || edge.type === 'explicit-reference-note'" :transform="`translate(${midPoint.x}, ${midPoint.y})`">
            <rect
                class="edge-label-bg"
                x="-40"
                y="-12"
                width="80"
                height="24"
                rx="12"
                :fill="selected ? '#dbeafe' : '#f8fafc'"
                stroke="#cbd5e1"
                stroke-width="1"
            />
            <text
                class="edge-label-text"
                x="0"
                y="4"
                text-anchor="middle"
                font-size="10"
                fill="#475569"
            >
                {{ edge.label || 'Ref Note' }}
            </text>
        </g>
    </g>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type {
    AuthoringCanvasEdge,
    AuthoringCanvasNode
} from '@/contracts/authoringCanvas';

const props = defineProps<{
    edge: AuthoringCanvasEdge;
    sourceNode?: AuthoringCanvasNode;
    targetNode?: AuthoringCanvasNode;
    selected: boolean;
}>();

defineEmits<{
    (e: 'select', id: string, event: MouseEvent): void;
    (e: 'delete', id: string): void;
    (e: 'convert-to-link', edge: AuthoringCanvasEdge): void;
}>();

const sourceCenter = computed(() => {
    if (!props.sourceNode) return { x: 0, y: 0 };
    return {
        x: props.sourceNode.x + props.sourceNode.width / 2,
        y: props.sourceNode.y + props.sourceNode.height / 2
    };
});

const targetCenter = computed(() => {
    if (!props.targetNode) return { x: 0, y: 0 };
    return {
        x: props.targetNode.x + props.targetNode.width / 2,
        y: props.targetNode.y + props.targetNode.height / 2
    };
});

const midPoint = computed(() => ({
    x: (sourceCenter.value.x + targetCenter.value.x) / 2,
    y: (sourceCenter.value.y + targetCenter.value.y) / 2
}));

const pathData = computed(() => {
    const s = sourceCenter.value;
    const t = targetCenter.value;
    const dx = t.x - s.x;
    const dy = t.y - s.y;
    const cx1 = s.x + dx * 0.4;
    const cy1 = s.y;
    const cx2 = s.x + dx * 0.6;
    const cy2 = t.y;
    return `M ${s.x} ${s.y} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${t.x} ${t.y}`;
});

const ariaEdgeLabel = computed(() =>
    `Edge: ${props.edge.type} from ${props.edge.sourceNodeId} to ${props.edge.targetNodeId}`
);
</script>

<style scoped>
.canvas-edge-group {
    cursor: pointer;
}

.edge-hit-area {
    pointer-events: stroke;
}

.edge-line {
    transition: stroke 0.15s ease, stroke-width 0.15s ease;
}

.edge-label-text {
    font-weight: 500;
    pointer-events: none;
}
</style>
