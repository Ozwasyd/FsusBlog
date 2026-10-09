<template>
    <g
        class="canvas-edge-group"
        :class="[`edge-${edge.type}`, { selected }]"
        role="button"
        :aria-label="ariaEdgeLabel"
        :tabindex="0"
        :aria-pressed="selected"
        @click.stop="$emit('select', edge.id, $event)"
        @dblclick.stop="edge.type === 'explicit-reference-note' && $emit('convert-to-link', edge)"
        @keydown.enter.prevent="selected && edge.type === 'explicit-reference-note' ? $emit('convert-to-link', edge) : $emit('select', edge.id, $event)"
        @keydown.space.prevent="$emit('select', edge.id, $event)"
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
            :stroke="selected ? 'var(--fsus-scholarly-blue)' : (edge.type === 'explicit-reference-note' ? 'var(--fsus-scholarly-blue)' : 'var(--el-border-color)')"
            :stroke-width="selected ? 3 : 2"
            :stroke-dasharray="edge.type === 'visual-only' ? '6 4' : 'none'"
            marker-end="url(#edge-arrow)"
        />

        <!-- Edge Label / Action Badge -->
        <g
            v-if="edge.label || edge.type === 'explicit-reference-note'"
            :transform="`translate(${midPoint.x}, ${midPoint.y})`"
        >
            <rect
                class="edge-label-bg"
                x="-40"
                y="-12"
                width="80"
                height="24"
                rx="12"
                :fill="selected ? 'var(--el-color-primary-light-9)' : 'var(--el-bg-color-page)'"
                stroke="var(--el-border-color)"
                stroke-width="1"
            />
            <text
                x="0"
                y="4"
                text-anchor="middle"
                class="edge-label-text"
                fill="var(--el-text-color-secondary)"
            >
                {{ edge.label || t('admin.canvas.reference') }}
            </text>
        </g>
    </g>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { useI18nText } from '@/composables/useI18nText';
import type { AuthoringCanvasEdge, AuthoringCanvasNode } from '@/contracts/authoringCanvas';
const props = defineProps<{
    edge: AuthoringCanvasEdge;
    sourceNode?: AuthoringCanvasNode;
    targetNode?: AuthoringCanvasNode;
    selected: boolean;
}>();
defineEmits<{
    (e: 'select', id: string, event: MouseEvent | KeyboardEvent): void;
    (e: 'delete', id: string): void;
    (e: 'convert-to-link', edge: AuthoringCanvasEdge): void;
}>();
const sourceCenter = computed(() =>
{
    if (!props.sourceNode)
    {
        return { x: 0, y: 0 };
    }
    return {
        x: props.sourceNode.x + props.sourceNode.width / 2,
        y: props.sourceNode.y + props.sourceNode.height / 2
    };
});
const targetCenter = computed(() =>
{
    if (!props.targetNode)
    {
        return { x: 0, y: 0 };
    }
    return {
        x: props.targetNode.x + props.targetNode.width / 2,
        y: props.targetNode.y + props.targetNode.height / 2
    };
});
const midPoint = computed(() => ({
    x: (sourceCenter.value.x + targetCenter.value.x) / 2,
    y: (sourceCenter.value.y + targetCenter.value.y) / 2
}));
const pathData = computed(() =>
{
    const s = sourceCenter.value;
    const t = targetCenter.value;
    const dx = t.x - s.x;
    const cx1 = s.x + dx * 0.4;
    const cy1 = s.y;
    const cx2 = s.x + dx * 0.6;
    const cy2 = t.y;
    return `M ${s.x} ${s.y} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${t.x} ${t.y}`;
});
const ariaEdgeLabel = computed(() => `Edge: ${props.edge.type} from ${props.edge.sourceNodeId} to ${props.edge.targetNodeId}`);
const { t } = useI18nText();
</script>



<style scoped>
.canvas-edge-group
 {
    cursor: pointer;
}

.edge-hit-area
 {
    pointer-events: stroke;
}

.edge-line
 {
    transition: stroke var(--fsus-motion-control) var(--fsus-motion-standard), stroke-width var(--fsus-motion-control) var(--fsus-motion-standard);
}

.edge-label-text
 {
    font-weight: 500;
    font-size: var(--el-font-size-base);
    pointer-events: none;
}

@media (prefers-reduced-motion: reduce)
 {
    .edge-line
 {
        transition: none;
    }
}
</style>
