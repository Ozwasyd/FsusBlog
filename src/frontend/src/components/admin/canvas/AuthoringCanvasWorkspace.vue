<template>
    <div class="authoring-canvas-workspace" role="main" aria-label="Authoring Canvas Workspace" @keydown="handleGlobalKeydown">
        <!-- Top Toolbar -->
        <AuthoringCanvasToolbar
            :zoom="canvas.viewport.value.zoom"
            :can-undo="canvas.canUndo.value"
            :can-redo="canvas.canRedo.value"
            :has-selection="hasSelection"
            :view-mode="canvas.activeViewMode.value"
            @add-note="handleAddNote"
            @add-reference="handleAddReference"
            @add-frame="handleAddFrame"
            @undo="canvas.undo"
            @redo="canvas.redo"
            @delete-selected="canvas.deleteSelected"
            @zoom-in="canvas.setZoom(canvas.viewport.value.zoom + 0.15)"
            @zoom-out="canvas.setZoom(canvas.viewport.value.zoom - 0.15)"
            @reset-zoom="canvas.resetViewport"
            @toggle-view-mode="toggleViewMode"
            @export-package="openExportDialog"
            @import-package="openImportDialog"
        />

        <!-- Main Content Area -->
        <div class="workspace-body">
            <!-- Canvas Viewport -->
            <div
                v-show="canvas.activeViewMode.value === 'canvas'"
                ref="viewportRef"
                class="canvas-viewport"
                tabindex="0"
                role="region"
                aria-label="Interactive Canvas Viewport"
                @mousedown="handleMouseDown"
                @wheel.prevent="handleWheel"
            >
                <div
                    class="canvas-world"
                    :style="{
                        transform: `translate(${canvas.viewport.value.x}px, ${canvas.viewport.value.y}px) scale(${canvas.viewport.value.zoom})`,
                        transformOrigin: '0 0'
                    }"
                >
                    <!-- SVG Edges Layer -->
                    <svg class="canvas-edges-svg" width="20000" height="20000" style="position: absolute; top: -10000px; left: -10000px; pointer-events: none;">
                        <defs>
                            <marker
                                id="edge-arrow"
                                markerWidth="10"
                                markerHeight="7"
                                refX="9"
                                refY="3.5"
                                orient="auto"
                            >
                                <polygon points="0 0, 10 3.5, 0 7" fill="#94a3b8" />
                            </marker>
                        </defs>
                        <g transform="translate(10000, 10000)">
                            <AuthoringCanvasEdgeRenderer
                                v-for="edge in canvas.visibleEdges.value"
                                :key="edge.id"
                                :edge="edge"
                                :source-node="canvas.document.value?.nodes[edge.sourceNodeId]"
                                :target-node="canvas.document.value?.nodes[edge.targetNodeId]"
                                :selected="canvas.selectedEdgeIds.value.has(edge.id)"
                                @select="handleSelectEdge"
                                @delete="canvas.deleteEdge"
                                @convert-to-link="handleConvertToLink"
                            />
                        </g>
                    </svg>

                    <!-- Virtualized Node Cards Layer -->
                    <AuthoringCanvasNodeCard
                        v-for="node in canvas.visibleNodes.value"
                        :key="node.id"
                        :node="node"
                        :projection="canvas.projections.value.get(node.id)"
                        :selected="canvas.selectedNodeIds.value.has(node.id)"
                        @select="handleSelectNode"
                        @delete="canvas.deleteNode"
                        @edit-text="canvas.editNote"
                        @pin="canvas.pinReference"
                        @unpin="canvas.unpinReference"
                        @open-source="handleOpenSource"
                    />
                </div>
            </div>

            <!-- Structured Outline View -->
            <div
                v-show="canvas.activeViewMode.value === 'outline'"
                class="outline-container"
            >
                <AuthoringCanvasOutlineView
                    :items="canvas.outlineItems.value"
                    @select-item="handleOutlineSelect"
                    @delete-item="handleOutlineDelete"
                    @open-source="handleOutlineOpenSource"
                />
            </div>
        </div>

        <!-- Edge To Link Dialog -->
        <AuthoringCanvasEdgeToLinkDialog
            :visible="edgeToLinkDialogVisible"
            :plan="currentLinkPlan"
            @cancel="edgeToLinkDialogVisible = false"
            @confirm="handleConfirmLinkConversion"
        />

        <!-- Portable Package Dialog -->
        <AuthoringCanvasPackageDialog
            :visible="packageDialogVisible"
            :mode="packageDialogMode"
            :export-content="exportedPackageJson"
            @close="packageDialogVisible = false"
            @execute-import="handleExecuteImport"
        />
    </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import type {
    AuthoringCanvasEdge,
    AuthoringCanvasOpenIntent
} from '@/contracts/authoringCanvas';
import type { OutlineItem } from '@/composables/useAuthoringCanvas';
import { useAuthoringCanvas } from '@/composables/useAuthoringCanvas';
import {
    planEdgeToLinkConversion,
    type EdgeToLinkPlan
} from '@/services/authoringCanvasEdgeToLink';
import {
    executeCanvasPackageImport,
    exportAuthoringCanvasPackage,
    type AuthoringCanvasImportPlan,
    type UnresolvedDecisionAction
} from '@/services/authoringCanvasPackage';
import AuthoringCanvasEdgeRenderer from './AuthoringCanvasEdgeRenderer.vue';
import AuthoringCanvasEdgeToLinkDialog from './AuthoringCanvasEdgeToLinkDialog.vue';
import AuthoringCanvasNodeCard from './AuthoringCanvasNodeCard.vue';
import AuthoringCanvasOutlineView from './AuthoringCanvasOutlineView.vue';
import AuthoringCanvasPackageDialog from './AuthoringCanvasPackageDialog.vue';
import AuthoringCanvasToolbar from './AuthoringCanvasToolbar.vue';

const props = defineProps<{
    canvasId?: string;
    userId?: string;
    siteId?: string;
}>();

const router = useRouter();
const canvas = useAuthoringCanvas();
const viewportRef = ref<HTMLElement | null>(null);

const hasSelection = computed(
    () => canvas.selectedNodeIds.value.size > 0 || canvas.selectedEdgeIds.value.size > 0
);

// Edge-to-Link Dialog State
const edgeToLinkDialogVisible = ref(false);
const currentLinkPlan = ref<EdgeToLinkPlan | null>(null);

// Package Dialog State
const packageDialogVisible = ref(false);
const packageDialogMode = ref<'export' | 'import'>('export');
const exportedPackageJson = ref('');

onMounted(async () => {
    const uid = props.userId || 'current-user';
    const sid = props.siteId || 'site-default';

    if (props.canvasId) {
        await canvas.loadCanvas(props.canvasId, { userId: uid, siteId: sid });
    } else {
        await canvas.createCanvas('Research Canvas', { userId: uid, siteId: sid });
    }
});

function toggleViewMode() {
    canvas.activeViewMode.value = canvas.activeViewMode.value === 'canvas' ? 'outline' : 'canvas';
}

function handleAddNote() {
    canvas.addPlainTextNote('New research note', 150, 150);
}

function handleAddReference() {
    // Prompt or add default reference
    canvas.addArticleReference(1, 200, 200);
}

function handleAddFrame() {
    const selected = Array.from(canvas.selectedNodeIds.value);
    canvas.addGroupFrame(selected, 'New Frame');
}

function handleSelectNode(nodeId: string, event: MouseEvent) {
    canvas.selectNode(nodeId, event.shiftKey || event.ctrlKey || event.metaKey);
}

function handleSelectEdge(edgeId: string, event: MouseEvent) {
    canvas.selectEdge(edgeId, event.shiftKey || event.ctrlKey || event.metaKey);
}

function handleOpenSource(intent: AuthoringCanvasOpenIntent) {
    if (intent.route) {
        void router.push(intent.route);
    }
}

function handleOutlineSelect(item: OutlineItem) {
    if (item.kind === 'edge') {
        canvas.selectEdge(item.id);
    } else {
        canvas.selectNode(item.id);
    }
}

function handleOutlineDelete(item: OutlineItem) {
    if (item.kind === 'edge') {
        canvas.deleteEdge(item.id);
    } else {
        canvas.deleteNode(item.id);
    }
}

function handleOutlineOpenSource(nodeId: string) {
    const proj = canvas.projections.value.get(nodeId);
    if (proj?.openIntent) {
        handleOpenSource(proj.openIntent);
    }
}

function handleConvertToLink(edge: AuthoringCanvasEdge) {
    if (!canvas.document.value) return;
    const targetProj = canvas.projections.value.get(edge.targetNodeId);
    const plan = planEdgeToLinkConversion(
        edge,
        canvas.document.value.nodes,
        targetProj?.title || 'Article'
    );
    currentLinkPlan.value = plan;
    edgeToLinkDialogVisible.value = true;
}

function handleConfirmLinkConversion(plan: EdgeToLinkPlan) {
    edgeToLinkDialogVisible.value = false;
    if (plan.generatedMarkdownLink) {
        void navigator.clipboard?.writeText(plan.generatedMarkdownLink);
    }
}

function openExportDialog() {
    if (!canvas.document.value) return;
    const pkg = exportAuthoringCanvasPackage(canvas.document.value, canvas.projections.value);
    exportedPackageJson.value = JSON.stringify(pkg, null, 2);
    packageDialogMode.value = 'export';
    packageDialogVisible.value = true;
}

function openImportDialog() {
    packageDialogMode.value = 'import';
    packageDialogVisible.value = true;
}

async function handleExecuteImport(
    plan: AuthoringCanvasImportPlan,
    decisions: Record<string, { action: UnresolvedDecisionAction }>
) {
    const uid = props.userId || 'current-user';
    const sid = props.siteId || 'site-default';

    const importedDoc = await executeCanvasPackageImport(plan, decisions, {
        userId: uid,
        siteId: sid
    });

    canvas.document.value = importedDoc;
    canvas.viewport.value = { ...importedDoc.viewport };
    await canvas.refreshProjections();
    packageDialogVisible.value = false;
}

// Mouse pan & zoom handlers
let isPanning = false;
let startX = 0;
let startY = 0;

function handleMouseDown(e: MouseEvent) {
    if (e.target === viewportRef.value || (e.target as HTMLElement)?.classList.contains('canvas-world')) {
        isPanning = true;
        startX = e.clientX - canvas.viewport.value.x;
        startY = e.clientY - canvas.viewport.value.y;

        const onMouseMove = (ev: MouseEvent) => {
            if (!isPanning) return;
            canvas.viewport.value.x = ev.clientX - startX;
            canvas.viewport.value.y = ev.clientY - startY;
        };

        const onMouseUp = () => {
            isPanning = false;
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
        };

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
    }
}

function handleWheel(e: WheelEvent) {
    const delta = e.deltaY < 0 ? 0.1 : -0.1;
    canvas.setZoom(canvas.viewport.value.zoom + delta);
}

function handleGlobalKeydown(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
            canvas.redo();
        } else {
            canvas.undo();
        }
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
        e.preventDefault();
        canvas.redo();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
        const activeTag = (document.activeElement as HTMLElement)?.tagName;
        if (activeTag !== 'INPUT' && activeTag !== 'TEXTAREA') {
            canvas.deleteSelected();
        }
    }
}
</script>

<style scoped>
.authoring-canvas-workspace {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    overflow: hidden;
    position: relative;
    background: var(--fsus-bg-color, #f8fafc);
}

.workspace-body {
    display: flex;
    flex: 1;
    overflow: hidden;
    position: relative;
}

.canvas-viewport {
    flex: 1;
    height: 100%;
    position: relative;
    overflow: hidden;
    outline: none;
    cursor: grab;
    background-image: radial-gradient(#cbd5e1 1px, transparent 1px);
    background-size: 20px 20px;
}

.canvas-viewport:active {
    cursor: grabbing;
}

.canvas-world {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: auto;
}

.outline-container {
    flex: 1;
    height: 100%;
    max-width: 600px;
    margin: 0 auto;
}

@media (prefers-reduced-motion: reduce) {
    * {
        transition: none !important;
        animation: none !important;
    }
}
</style>
