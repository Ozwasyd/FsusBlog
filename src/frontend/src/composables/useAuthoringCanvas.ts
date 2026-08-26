/**
 * Authoring Canvas Composable (#2489)
 *
 * Coordinates authoritative document state, operations journal, undo/redo,
 * reference projections, spatial virtualization, and structured outline parity.
 */

import { computed, ref, shallowRef, watch } from 'vue';
import {
    AUTHORING_CANVAS_BUDGETS,
    type AuthoringCanvasDocument,
    type AuthoringCanvasEdge,
    type AuthoringCanvasEdgeType,
    type AuthoringCanvasGroupFrameNode,
    type AuthoringCanvasNode,
    type AuthoringCanvasReferenceProjection,
    type AuthoringCanvasViewport
} from '@/contracts/authoringCanvas';
import {
    authoringCanvasOperationEngine,
    type AuthoringCanvasCommand,
    type AuthoringCanvasJournalEntry,
    MAX_JOURNAL_ENTRIES
} from '@/services/authoringCanvasOperations';
import {
    authoringCanvasResolver
} from '@/services/authoringCanvasResolver';
import {
    AuthoringCanvasSpatialIndex
} from '@/services/authoringCanvasSpatialIndex';
import {
    authoringCanvasStorage
} from '@/services/authoringCanvasStorage';

export interface OutlineItem {
    id: string;
    kind: 'node' | 'frame' | 'edge';
    type: string;
    title: string;
    status?: string;
    snippet?: string;
    selected: boolean;
    memberCount?: number;
    parentFrameId?: string;
}

export function useAuthoringCanvas() {
    const document = ref<AuthoringCanvasDocument | null>(null);
    const loading = ref(false);
    const saving = ref(false);
    const error = ref<string | null>(null);

    const viewport = ref<AuthoringCanvasViewport>({ x: 0, y: 0, zoom: 1 });
    const containerDimensions = ref<{ width: number; height: number }>({ width: 1200, height: 800 });

    const selectedNodeIds = ref<Set<string>>(new Set());
    const selectedEdgeIds = ref<Set<string>>(new Set());

    const projections = shallowRef<Map<string, AuthoringCanvasReferenceProjection>>(new Map());
    const journal = ref<AuthoringCanvasJournalEntry[]>([]);
    const redoStack = ref<AuthoringCanvasJournalEntry[]>([]);

    const activeViewMode = ref<'canvas' | 'outline'>('canvas');
    const spatialIndex = new AuthoringCanvasSpatialIndex();

    // Re-index nodes when document nodes change
    watch(
        () => document.value?.nodes,
        (nodes) => {
            if (!nodes) {
                spatialIndex.clear();
                return;
            }
            spatialIndex.indexNodes(Object.values(nodes));
        },
        { deep: false }
    );

    // Sync viewport from loaded document
    watch(
        () => document.value?.viewport,
        (vp) => {
            if (vp) {
                viewport.value = { ...vp };
            }
        },
        { immediate: true }
    );

    const canUndo = computed(() => journal.value.length > 0);
    const canRedo = computed(() => redoStack.value.length > 0);

    const visibleNodeIds = computed<string[]>(() => {
        if (!document.value) return [];
        return spatialIndex.queryVisibleNodeIds(viewport.value, containerDimensions.value, 300);
    });

    const visibleNodes = computed<AuthoringCanvasNode[]>(() => {
        if (!document.value) return [];
        const nodeMap = document.value.nodes;
        return visibleNodeIds.value.map((id) => nodeMap[id]).filter((n): n is AuthoringCanvasNode => Boolean(n));
    });

    const visibleEdgeIds = computed<string[]>(() => {
        if (!document.value) return [];
        const visibleSet = new Set(visibleNodeIds.value);
        return spatialIndex.queryVisibleEdgeIds(Object.values(document.value.edges), visibleSet);
    });

    const visibleEdges = computed<AuthoringCanvasEdge[]>(() => {
        if (!document.value) return [];
        const edgeMap = document.value.edges;
        return visibleEdgeIds.value.map((id) => edgeMap[id]).filter((e): e is AuthoringCanvasEdge => Boolean(e));
    });

    const outlineItems = computed<OutlineItem[]>(() => {
        if (!document.value) return [];
        const items: OutlineItem[] = [];
        const nodes = document.value.nodes;
        const edges = document.value.edges;

        // Group frames first
        for (const nodeId of document.value.nodeIds) {
            const node = nodes[nodeId];
            if (!node) continue;
            if (node.type === 'group-frame') {
                const frame = node as AuthoringCanvasGroupFrameNode;
                items.push({
                    id: frame.id,
                    kind: 'frame',
                    type: frame.type,
                    title: `Frame: ${frame.label}`,
                    memberCount: frame.memberNodeIds.length,
                    selected: selectedNodeIds.value.has(frame.id)
                });
            }
        }

        // Other nodes
        for (const nodeId of document.value.nodeIds) {
            const node = nodes[nodeId];
            if (!node || node.type === 'group-frame') continue;

            let title = `Node: ${node.id}`;
            let status: string | undefined;
            let snippet: string | undefined;

            if (node.type === 'article-reference' || node.type === 'heading-reference' || node.type === 'block-reference') {
                const proj = projections.value.get(node.id);
                title = proj?.title || `Article #${node.targetArticleId}`;
                status = proj?.status || 'resolving';
                snippet = proj?.snippet;
            } else if (node.type === 'plain-text-note') {
                title = node.text ? `Note: ${node.text.slice(0, 30)}...` : 'Empty Note';
                snippet = node.text;
            }

            items.push({
                id: node.id,
                kind: 'node',
                type: node.type,
                title,
                status,
                snippet,
                selected: selectedNodeIds.value.has(node.id)
            });
        }

        // Edges
        for (const edgeId of document.value.edgeIds) {
            const edge = edges[edgeId];
            if (!edge) continue;
            items.push({
                id: edge.id,
                kind: 'edge',
                type: edge.type,
                title: `Edge: ${edge.label || edge.type} (${edge.sourceNodeId} -> ${edge.targetNodeId})`,
                selected: selectedEdgeIds.value.has(edge.id)
            });
        }

        return items;
    });

    async function loadCanvas(canvasId: string, context?: { userId: string; siteId: string }): Promise<void> {
        loading.value = true;
        error.value = null;
        try {
            const doc = await authoringCanvasStorage.getCanvas(canvasId, context);
            if (!doc) {
                error.value = 'Canvas document not found';
                return;
            }
            document.value = doc;
            viewport.value = { ...doc.viewport };
            selectedNodeIds.value.clear();
            selectedEdgeIds.value.clear();
            journal.value = [];
            redoStack.value = [];
            await refreshProjections();
        } catch (err: unknown) {
            error.value = err instanceof Error ? err.message : String(err);
        } finally {
            loading.value = false;
        }
    }

    async function createCanvas(title: string, context: { userId: string; siteId: string }): Promise<AuthoringCanvasDocument | null> {
        loading.value = true;
        error.value = null;
        try {
            const doc = await authoringCanvasStorage.createCanvas({
                userId: context.userId,
                siteId: context.siteId,
                title
            });
            document.value = doc;
            viewport.value = { ...doc.viewport };
            journal.value = [];
            redoStack.value = [];
            return doc;
        } catch (err: unknown) {
            error.value = err instanceof Error ? err.message : String(err);
            return null;
        } finally {
            loading.value = false;
        }
    }

    async function refreshProjections(): Promise<void> {
        if (!document.value) return;
        const context = {
            userId: document.value.userId,
            siteId: document.value.siteId,
            canvasId: document.value.id,
            canvasRevision: document.value.revision
        };
        const nodeArray = Object.values(document.value.nodes);
        const map = await authoringCanvasResolver.resolveReferences(nodeArray, context);
        projections.value = map;
    }

    function applyOperation(command: AuthoringCanvasCommand): void {
        if (!document.value) return;

        const { updatedDoc, journalEntry } = authoringCanvasOperationEngine.applyCommand(
            document.value,
            command,
            { expectedRevision: document.value.revision }
        );

        document.value = updatedDoc;

        // Push to journal and trim to budget
        journal.value.push(journalEntry);
        if (journal.value.length > MAX_JOURNAL_ENTRIES) {
            journal.value.shift();
        }

        // Branching history: clears redo stack
        redoStack.value = [];

        // Save asynchronously to authoritative storage
        void persistCurrentDocument();
        void refreshProjections();
    }

    async function persistCurrentDocument(): Promise<void> {
        if (!document.value) return;
        saving.value = true;
        try {
            const baseRevision = document.value.revision - 1;
            await authoringCanvasStorage.updateCanvas(
                document.value.id,
                baseRevision,
                {
                    title: document.value.title,
                    viewport: document.value.viewport,
                    nodeIds: document.value.nodeIds,
                    nodes: document.value.nodes,
                    edgeIds: document.value.edgeIds,
                    edges: document.value.edges
                },
                { userId: document.value.userId, siteId: document.value.siteId }
            );
        } catch (err: unknown) {
            console.error('[Authoring Canvas] Persist error:', err);
        } finally {
            saving.value = false;
        }
    }

    function undo(): void {
        if (!document.value || journal.value.length === 0) return;
        const entry = journal.value.pop();
        if (!entry) return;

        const { updatedDoc } = authoringCanvasOperationEngine.applyCommand(
            document.value,
            entry.inverseCommand,
            { expectedRevision: document.value.revision }
        );

        document.value = updatedDoc;
        redoStack.value.push(entry);
        void persistCurrentDocument();
        void refreshProjections();
    }

    function redo(): void {
        if (!document.value || redoStack.value.length === 0) return;
        const entry = redoStack.value.pop();
        if (!entry) return;

        const { updatedDoc, journalEntry } = authoringCanvasOperationEngine.applyCommand(
            document.value,
            entry.command,
            { expectedRevision: document.value.revision }
        );

        document.value = updatedDoc;
        journal.value.push(journalEntry);
        void persistCurrentDocument();
        void refreshProjections();
    }

    function addArticleReference(targetArticleId: number | string, x: number = 100, y: number = 100): void {
        const id = `node-art-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        applyOperation({
            type: 'create-node',
            node: {
                id,
                type: 'article-reference',
                x,
                y,
                width: 280,
                height: 140,
                targetArticleId
            }
        });
    }

    function addHeadingReference(targetArticleId: number | string, targetHeadingId: string, x: number = 100, y: number = 100): void {
        const id = `node-head-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        applyOperation({
            type: 'create-node',
            node: {
                id,
                type: 'heading-reference',
                x,
                y,
                width: 280,
                height: 140,
                targetArticleId,
                targetHeadingId
            }
        });
    }

    function addBlockReference(targetArticleId: number | string, targetBlockId: string, x: number = 100, y: number = 100): void {
        const id = `node-blk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        applyOperation({
            type: 'create-node',
            node: {
                id,
                type: 'block-reference',
                x,
                y,
                width: 280,
                height: 140,
                targetArticleId,
                targetBlockId
            }
        });
    }

    function addPlainTextNote(text: string, x: number = 150, y: number = 150): void {
        const id = `node-note-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        applyOperation({
            type: 'create-node',
            node: {
                id,
                type: 'plain-text-note',
                x,
                y,
                width: 240,
                height: 140,
                text
            }
        });
    }

    function addGroupFrame(memberNodeIds: string[], label: string = 'Group Frame'): void {
        const id = `frame-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        applyOperation({
            type: 'group-nodes',
            frameId: id,
            memberNodeIds,
            label
        });
    }

    function connectNodes(
        sourceNodeId: string,
        targetNodeId: string,
        edgeType: AuthoringCanvasEdgeType = 'visual-only',
        label?: string
    ): void {
        const id = `edge-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        applyOperation({
            type: 'create-edge',
            edge: {
                id,
                type: edgeType,
                sourceNodeId,
                targetNodeId,
                label
            }
        });
    }

    function moveNode(nodeId: string, x: number, y: number): void {
        applyOperation({ type: 'move-node', nodeId, x, y });
    }

    function batchMoveNodes(moves: Array<{ nodeId: string; x: number; y: number }>): void {
        applyOperation({ type: 'batch-move-nodes', moves });
    }

    function resizeNode(nodeId: string, width: number, height: number): void {
        applyOperation({ type: 'resize-node', nodeId, width, height });
    }

    function editNote(nodeId: string, text: string): void {
        applyOperation({ type: 'edit-note', nodeId, text });
    }

    function deleteNode(nodeId: string): void {
        applyOperation({ type: 'delete-node', nodeId });
        selectedNodeIds.value.delete(nodeId);
    }

    function deleteEdge(edgeId: string): void {
        applyOperation({ type: 'delete-edge', edgeId });
        selectedEdgeIds.value.delete(edgeId);
    }

    function deleteSelected(): void {
        if (!document.value) return;
        const commands: AuthoringCanvasCommand[] = [];

        for (const edgeId of selectedEdgeIds.value) {
            commands.push({ type: 'delete-edge', edgeId });
        }
        for (const nodeId of selectedNodeIds.value) {
            commands.push({ type: 'delete-node', nodeId });
        }

        if (commands.length > 0) {
            applyOperation({ type: 'batch', commands });
            selectedNodeIds.value.clear();
            selectedEdgeIds.value.clear();
        }
    }

    function pinReference(nodeId: string, pinnedRevision: number | string): void {
        applyOperation({ type: 'pin-reference', nodeId, pinnedRevision });
    }

    function unpinReference(nodeId: string): void {
        applyOperation({ type: 'unpin-reference', nodeId });
    }

    function setZoom(zoom: number): void {
        const clampedZoom = Math.max(
            AUTHORING_CANVAS_BUDGETS.MIN_ZOOM,
            Math.min(AUTHORING_CANVAS_BUDGETS.MAX_ZOOM, zoom)
        );
        viewport.value.zoom = clampedZoom;
        if (document.value) {
            document.value.viewport.zoom = clampedZoom;
        }
    }

    function panBy(dx: number, dy: number): void {
        viewport.value.x += dx;
        viewport.value.y += dy;
        if (document.value) {
            document.value.viewport.x = viewport.value.x;
            document.value.viewport.y = viewport.value.y;
        }
    }

    function resetViewport(): void {
        viewport.value = { x: 0, y: 0, zoom: 1 };
        if (document.value) {
            document.value.viewport = { x: 0, y: 0, zoom: 1 };
        }
    }

    function selectNode(nodeId: string, multi: boolean = false): void {
        if (!multi) {
            selectedNodeIds.value.clear();
            selectedEdgeIds.value.clear();
        }
        if (selectedNodeIds.value.has(nodeId)) {
            if (multi) selectedNodeIds.value.delete(nodeId);
        } else {
            selectedNodeIds.value.add(nodeId);
        }
    }

    function selectEdge(edgeId: string, multi: boolean = false): void {
        if (!multi) {
            selectedNodeIds.value.clear();
            selectedEdgeIds.value.clear();
        }
        if (selectedEdgeIds.value.has(edgeId)) {
            if (multi) selectedEdgeIds.value.delete(edgeId);
        } else {
            selectedEdgeIds.value.add(edgeId);
        }
    }

    function clearSelection(): void {
        selectedNodeIds.value.clear();
        selectedEdgeIds.value.clear();
    }

    return {
        document,
        loading,
        saving,
        error,
        viewport,
        containerDimensions,
        selectedNodeIds,
        selectedEdgeIds,
        projections,
        journal,
        redoStack,
        activeViewMode,
        canUndo,
        canRedo,
        visibleNodeIds,
        visibleNodes,
        visibleEdgeIds,
        visibleEdges,
        outlineItems,
        loadCanvas,
        createCanvas,
        applyOperation,
        addArticleReference,
        addHeadingReference,
        addBlockReference,
        addPlainTextNote,
        addGroupFrame,
        connectNodes,
        moveNode,
        batchMoveNodes,
        resizeNode,
        editNote,
        deleteNode,
        deleteEdge,
        deleteSelected,
        pinReference,
        unpinReference,
        undo,
        redo,
        setZoom,
        panBy,
        resetViewport,
        selectNode,
        selectEdge,
        clearSelection,
        refreshProjections
    };
}
