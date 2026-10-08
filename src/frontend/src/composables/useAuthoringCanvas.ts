/**
 * Authoring Canvas Composable (#2489)
 *
 * Coordinates authoritative document state, operations journal, undo/redo,
 * reference projections, spatial virtualization, and structured outline parity.
 */
import { computed, getCurrentScope, inject, onScopeDispose, ref, shallowRef, watch, type InjectionKey } from 'vue';

import { useI18nText } from '@/composables/useI18nText';
import { AUTHORING_CANVAS_BUDGETS, type AuthoringCanvasDocument, type AuthoringCanvasEdge, type AuthoringCanvasEdgeType, type AuthoringCanvasNode, type AuthoringCanvasReferenceProjection, type AuthoringCanvasViewport } from '@/contracts/authoringCanvas';
import { authoringCanvasOperationEngine, type AuthoringCanvasCommand, MAX_JOURNAL_ENTRIES } from '@/services/authoringCanvasOperations';
import { type AuthoringCanvasProjectionReader } from '@/services/authoringCanvasResolver';
import { AuthoringCanvasSpatialIndex } from '@/services/authoringCanvasSpatialIndex';
import { type AuthoringCanvasStorage, type CanvasOwnerContext } from '@/services/authoringCanvasStorage';
function canvasLabelOrEmpty(value: string | undefined): string
{
    if (value)
    {
        return value;
    }
    return '';
}
export interface OutlineItem
{
    id: string;
    kind: 'node' | 'frame' | 'edge';
    type: string;
    title: string;
    status?: string;
    snippet?: string;
    selected: boolean;
    memberCount?: number;
    canOpen?: boolean;
    parentFrameId?: string;
}
export interface CanvasOperationReceipt
{
    canvasId: string;
    revision: number;
    requestId: string;
    journalId: string;
    undoDepth: number;
    redoDepth: number;
    receiptDigest: string;
    canvasContentDigest: string;
}
export interface PendingCanvasTransition
{
    canvasId: string;
    expectedRevision: number;
    requestId: string;
    mode: 'apply' | 'undo' | 'redo';
    command?: AuthoringCanvasCommand;
}
export interface AuthoringCanvasSession
{
    readonly ownerContext: CanvasOwnerContext;
    readonly storage: AuthoringCanvasStorage;
    readonly projections: AuthoringCanvasProjectionReader;
    pendingWrite?(): Omit<PendingCanvasTransition, 'command'> | null;
    retryPending?(): Promise<{
        document: AuthoringCanvasDocument;
        receipt: CanvasOperationReceipt;
    }>;
    history(canvasId: string, expectedRevision: number, documentDigest: string): Promise<{
        canvasId: string;
        revision: number;
        canvasContentDigest: string;
        historyDigest: string;
        undoDepth: number;
        redoDepth: number;
    }>;
    apply(canvasId: string, expectedRevision: number, requestId: string, command: AuthoringCanvasCommand): Promise<{
        document: AuthoringCanvasDocument;
        receipt: CanvasOperationReceipt;
    }>;
    undo(canvasId: string, expectedRevision: number, requestId: string): Promise<{
        document: AuthoringCanvasDocument;
        receipt: CanvasOperationReceipt;
    }>;
    redo(canvasId: string, expectedRevision: number, requestId: string): Promise<{
        document: AuthoringCanvasDocument;
        receipt: CanvasOperationReceipt;
    }>;
}
export const authoringCanvasSessionKey: InjectionKey<AuthoringCanvasSession> = Symbol('authoring-canvas-session');
export function useAuthoringCanvas(providedSession?: AuthoringCanvasSession)
{
    const { t } = useI18nText();
    const session = providedSession ?? inject(authoringCanvasSessionKey, undefined);
    const document = ref<AuthoringCanvasDocument | null>(null);
    let generation = 0;
    if (getCurrentScope())
    {
        onScopeDispose(() =>
        {
            generation++;
        });
    }
    let commitQueue = Promise.resolve();
    const undoDepth = ref(0);
    const redoDepth = ref(0);
    const pendingTransition = shallowRef<PendingCanvasTransition | null>(session?.pendingWrite?.() ?? null);
    function requireSession(): AuthoringCanvasSession
    {
        if (!session)
        {
            throw new Error('canvas_authenticated_transport_unavailable');
        }
        return session;
    }
    const loading = ref(false);
    const saving = ref(false);
    const error = ref<string | null>(null);
    const viewport = ref<AuthoringCanvasViewport>({ x: 0, y: 0, zoom: 1 });
    const containerDimensions = ref<{
        width: number;
        height: number;
    }>({ width: 1200, height: 800 });
    const selectedNodeIds = ref<Set<string>>(new Set());
    const selectedEdgeIds = ref<Set<string>>(new Set());
    const projections = shallowRef<Map<string, AuthoringCanvasReferenceProjection>>(new Map());
    const journal = ref<CanvasOperationReceipt[]>([]);
    const redoStack = ref<CanvasOperationReceipt[]>([]);
    const activeViewMode = ref<'canvas' | 'outline'>('canvas');
    const spatialIndex = new AuthoringCanvasSpatialIndex();
    // Re-index nodes when document nodes change
    watch(() => document.value?.nodes, (nodes) =>
    {
        if (!nodes)
        {
            spatialIndex.clear();
            return;
        }
        spatialIndex.indexNodes(Object.values(nodes));
    }, { deep: false, flush: 'sync' });
    // Sync viewport from loaded document
    watch(() => document.value?.viewport, (vp) =>
    {
        if (vp)
        {
            viewport.value = { ...vp };
        }
    }, { immediate: true });
    const canUndo = computed(() => undoDepth.value > 0 && !saving.value && !pendingTransition.value);
    const canRedo = computed(() => redoDepth.value > 0 && !saving.value && !pendingTransition.value);
    const visibleNodeIds = computed<string[]>(() =>
    {
        if (!document.value)
        {
            return [];
        }
        return spatialIndex.queryVisibleNodeIds(viewport.value, containerDimensions.value, 300);
    });
    const visibleNodes = computed<AuthoringCanvasNode[]>(() =>
    {
        if (!document.value)
        {
            return [];
        }
        const nodeMap = document.value.nodes;
        return visibleNodeIds.value.map((id) => nodeMap[id]).filter((n): n is AuthoringCanvasNode => Boolean(n));
    });
    const visibleEdgeIds = computed<string[]>(() =>
    {
        if (!document.value)
        {
            return [];
        }
        const visibleSet = new Set(visibleNodeIds.value);
        return spatialIndex.queryVisibleEdgeIds(Object.values(document.value.edges), visibleSet);
    });
    const visibleEdges = computed<AuthoringCanvasEdge[]>(() =>
    {
        if (!document.value)
        {
            return [];
        }
        const edgeMap = document.value.edges;
        return visibleEdgeIds.value.map((id) => edgeMap[id]).filter((e): e is AuthoringCanvasEdge => Boolean(e));
    });
    const outlineItems = computed<OutlineItem[]>(() =>
    {
        if (!document.value)
        {
            return [];
        }
        const items: OutlineItem[] = [];
        const nodes = document.value.nodes;
        const edges = document.value.edges;
        // Group frames first
        for (const nodeId of document.value.nodeIds)
        {
            const node = nodes[nodeId];
            if (!node)
            {
                continue;
            }
            if (node.type === 'group-frame')
            {
                const frame = node;
                items.push({
                    id: frame.id,
                    kind: 'frame',
                    type: frame.type,
                    title: `${t('admin.canvas.frame')}: ${frame.label}`,
                    memberCount: frame.memberNodeIds.length,
                    selected: selectedNodeIds.value.has(frame.id)
                });
            }
        }
        // Other nodes
        for (const nodeId of document.value.nodeIds)
        {
            const node = nodes[nodeId];
            if (!node || node.type === 'group-frame')
            {
                continue;
            }
            let title = `${t('admin.canvas.reference')}: ${node.id}`;
            let status: string | undefined;
            let snippet: string | undefined;
            if (node.type === 'article-reference' || node.type === 'heading-reference' || node.type === 'block-reference')
            {
                const proj = projections.value.get(node.id);
                if (proj?.status === 'permission-denied')
                {
                    title = t('admin.canvas.denied');
                }
                else
                {
                    const resolvedTitle = proj?.title;
                    if (resolvedTitle)
                    {
                        title = resolvedTitle;
                    }
                    else
                    {
                        title = `${t('admin.canvas.article')} #${node.targetArticleId}`;
                    }
                }
                const resolvedStatus = proj?.status;
                if (resolvedStatus)
                {
                    status = resolvedStatus;
                }
                else
                {
                    status = 'resolving';
                }
                snippet = proj?.snippet;
            }
            else if (node.type === 'plain-text-note')
            {
                title = node.text ? `${t('admin.canvas.note')}: ${node.text.slice(0, 30)}` : t('admin.canvas.empty');
                snippet = node.text;
            }
            items.push({
                id: node.id,
                kind: 'node',
                type: node.type,
                title,
                status,
                snippet,
                canOpen: Boolean(projections.value.get(node.id)?.openIntent),
                selected: selectedNodeIds.value.has(node.id)
            });
        }
        // Edges
        for (const edgeId of document.value.edgeIds)
        {
            const edge = edges[edgeId];
            if (!edge)
            {
                continue;
            }
            items.push({
                id: edge.id,
                kind: 'edge',
                type: edge.type,
                title: `${t(edge.type === 'visual-only' ? 'admin.canvas.connectVisual' : 'admin.canvas.connectReference')}: ${canvasLabelOrEmpty(edge.label)} (${edge.sourceNodeId} → ${edge.targetNodeId})`,
                selected: selectedEdgeIds.value.has(edge.id)
            });
        }
        return items;
    });
    async function loadCanvas(canvasId: string): Promise<void>
    {
        const token = ++generation;
        loading.value = true;
        error.value = null;
        document.value = null;
        projections.value = new Map();
        saving.value = false;
        undoDepth.value = 0;
        redoDepth.value = 0;
        try
        {
            const active = requireSession();
            pendingTransition.value = active.pendingWrite?.() ?? pendingTransition.value;
            const doc = await active.storage.getCanvas(canvasId, active.ownerContext);
            if (token !== generation)
            {
                return;
            }
            if (!doc)
            {
                throw new Error('canvas_unavailable');
            }
            const history = await active.history(doc.id, doc.revision, doc.contentDigest);
            if (token !== generation)
            {
                return;
            }
            if (history.canvasId !== doc.id || history.revision !== doc.revision
                || history.canvasContentDigest !== doc.contentDigest || !history.historyDigest
                || !Number.isSafeInteger(history.undoDepth) || history.undoDepth < 0
                || !Number.isSafeInteger(history.redoDepth) || history.redoDepth < 0)
            {
                throw new Error('canvas_history_binding_mismatch');
            }
            document.value = doc;
            undoDepth.value = history.undoDepth;
            redoDepth.value = history.redoDepth;
            viewport.value = { ...doc.viewport };
            selectedNodeIds.value.clear();
            selectedEdgeIds.value.clear();
            journal.value = [];
            redoStack.value = [];
            await refreshProjections();
        }
        catch (err: unknown)
        {
            if (token === generation)
            {
                error.value = err instanceof Error ? err.message : String(err);
            }
        }
        finally
        {
            if (token === generation)
            {
                loading.value = false;
            }
        }
    }
    async function createCanvas(title: string): Promise<AuthoringCanvasDocument | null>
    {
        const token = ++generation;
        loading.value = true;
        error.value = null;
        document.value = null;
        projections.value = new Map();
        saving.value = false;
        undoDepth.value = 0;
        redoDepth.value = 0;
        try
        {
            const active = requireSession();
            const doc = await active.storage.createCanvas({ ...active.ownerContext, title });
            if (token !== generation)
            {
                return null;
            }
            document.value = doc;
            viewport.value = { ...doc.viewport };
            journal.value = [];
            redoStack.value = [];
            return doc;
        }
        catch (err: unknown)
        {
            if (token === generation)
            {
                error.value = err instanceof Error ? err.message : String(err);
            }
            return null;
        }
        finally
        {
            if (token === generation)
            {
                loading.value = false;
            }
        }
    }
    async function refreshProjections(): Promise<void>
    {
        const doc = document.value;
        if (!doc)
        {
            return;
        }
        const token = generation;
        const active = requireSession();
        const map = await active.projections.resolveReferences(Object.values(doc.nodes), {
            ...active.ownerContext, canvasId: doc.id, canvasRevision: doc.revision, documentDigest: doc.contentDigest
        });
        if (token !== generation || document.value?.id !== doc.id || document.value?.revision !== doc.revision
            || document.value?.contentDigest !== doc.contentDigest)
        {
            return;
        }
        projections.value = map;
    }
    async function executeTransition(pending: PendingCanvasTransition, token: number, recovering: boolean): Promise<void>
    {
        const active = requireSession();
        saving.value = true;
        error.value = null;
        let responseReceived = false;
        try
        {
            const result = recovering && active.pendingWrite?.()?.requestId === pending.requestId && active.retryPending
                ? await active.retryPending()
                : pending.mode === 'apply' && pending.command
                    ? await active.apply(pending.canvasId, pending.expectedRevision, pending.requestId, pending.command)
                    : pending.mode === 'undo' ? await active.undo(pending.canvasId, pending.expectedRevision, pending.requestId)
                        : pending.mode === 'redo' ? await active.redo(pending.canvasId, pending.expectedRevision, pending.requestId)
                            : (() =>
                            {
                                throw new Error('canvas_pending_payload_unavailable');
                            })();
            responseReceived = true;
            const { document: next, receipt } = result;
            if (next.id !== pending.canvasId || next.userId !== active.ownerContext.userId
                || next.siteId !== active.ownerContext.siteId || next.revision !== pending.expectedRevision + 1
                || receipt.canvasId !== pending.canvasId || receipt.requestId !== pending.requestId
                || receipt.revision !== next.revision || receipt.canvasContentDigest !== next.contentDigest
                || !receipt.receiptDigest || !Number.isSafeInteger(receipt.undoDepth) || receipt.undoDepth < 0
                || !Number.isSafeInteger(receipt.redoDepth) || receipt.redoDepth < 0)
            {
                throw new Error('canvas_operation_receipt_mismatch');
            }
            pendingTransition.value = null;
            if (token !== generation || document.value?.id !== pending.canvasId)
            {
                return;
            }
            document.value = next;
            selectedNodeIds.value = new Set([...selectedNodeIds.value].filter(id => Object.hasOwn(next.nodes, id)));
            selectedEdgeIds.value = new Set([...selectedEdgeIds.value].filter(id => Object.hasOwn(next.edges, id)));
            projections.value = new Map();
            viewport.value = { ...next.viewport };
            undoDepth.value = receipt.undoDepth;
            redoDepth.value = receipt.redoDepth;
            journal.value = [...journal.value, receipt].slice(-MAX_JOURNAL_ENTRIES);
            // Acknowledgment precedes independent read refresh: refresh failure cannot replay the write.
            await refreshProjections();
        }
        catch (err: unknown)
        {
            if (!responseReceived)
            {
                if (active.pendingWrite)
                {
                    if (active.pendingWrite() === null)
                    {
                        pendingTransition.value = null;
                    }
                }
            }
            if (token === generation)
            {
                if (document.value)
                {
                    viewport.value = { ...document.value.viewport };
                }
                error.value = err instanceof Error ? err.message : String(err);
            }
        }
        finally
        {
            if (token === generation)
            {
                saving.value = false;
            }
        }
    }
    function enqueueTransition(mode: 'apply' | 'undo' | 'redo', command?: AuthoringCanvasCommand): void
    {
        const token = generation;
        const canvasId = document.value?.id;
        if (!canvasId || pendingTransition.value)
        {
            return;
        }
        const frozenCommand = command ? structuredClone(command) : undefined;
        commitQueue = commitQueue.then(async () =>
        {
            if (token !== generation || document.value?.id !== canvasId || pendingTransition.value)
            {
                return;
            }
            const doc = document.value;
            // Rejected local previews never create a pending server write.
            if (frozenCommand)
            {
                authoringCanvasOperationEngine.applyCommand(doc, frozenCommand, { expectedRevision: doc.revision });
            }
            const pending: PendingCanvasTransition = { canvasId, expectedRevision: doc.revision,
                requestId: crypto.randomUUID(), mode, ...(frozenCommand ? { command: frozenCommand } : {}) };
            pendingTransition.value = pending;
            await executeTransition(pending, token, false);
        }).catch((err: unknown) =>
        {
            if (token === generation)
            {
                error.value = err instanceof Error ? err.message : String(err);
            }
        });
    }
    async function retryPendingOperation(): Promise<void>
    {
        const pending = pendingTransition.value ?? session?.pendingWrite?.();
        if (!pending || saving.value)
        {
            return;
        }
        pendingTransition.value = pending;
        await executeTransition(pending, generation, true);
    }
    function applyOperation(command: AuthoringCanvasCommand): void
    {
        enqueueTransition('apply', command);
    }
    function undo(): void
    {
        if (canUndo.value)
        {
            enqueueTransition('undo');
        }
    }
    function redo(): void
    {
        if (canRedo.value)
        {
            enqueueTransition('redo');
        }
    }
    function addArticleReference(targetArticleId: number | string, x = 100, y = 100): void
    {
        const id = crypto.randomUUID();
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
    function addHeadingReference(targetArticleId: number | string, targetHeadingId: string, x = 100, y = 100): void
    {
        const id = crypto.randomUUID();
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
    function addBlockReference(targetArticleId: number | string, targetBlockId: string, x = 100, y = 100): void
    {
        const id = crypto.randomUUID();
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
    function addPlainTextNote(text: string, x = 150, y = 150): void
    {
        const id = crypto.randomUUID();
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
    function addGroupFrame(memberNodeIds: string[], label = 'Group Frame'): void
    {
        const id = crypto.randomUUID();
        applyOperation({
            type: 'group-nodes',
            frameId: id,
            memberNodeIds,
            label
        });
    }
    function connectNodes(sourceNodeId: string, targetNodeId: string, edgeType: AuthoringCanvasEdgeType = 'visual-only', label?: string): void
    {
        const id = crypto.randomUUID();
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
    function moveNode(nodeId: string, x: number, y: number): void
    {
        applyOperation({ type: 'move-node', nodeId, x, y });
    }
    function batchMoveNodes(moves: {
        nodeId: string;
        x: number;
        y: number;
    }[]): void
    {
        applyOperation({ type: 'batch-move-nodes', moves });
    }
    function resizeNode(nodeId: string, width: number, height: number): void
    {
        applyOperation({ type: 'resize-node', nodeId, width, height });
    }
    function editNote(nodeId: string, text: string): void
    {
        applyOperation({ type: 'edit-note', nodeId, text });
    }
    function deleteNode(nodeId: string): void
    {
        applyOperation({ type: 'delete-node', nodeId });
    }
    function deleteEdge(edgeId: string): void
    {
        applyOperation({ type: 'delete-edge', edgeId });
    }
    function deleteSelected(): void
    {
        if (!document.value)
        {
            return;
        }
        const commands: AuthoringCanvasCommand[] = [
            ...[...selectedEdgeIds.value].map((edgeId): AuthoringCanvasCommand => ({ type: 'delete-edge', edgeId })),
            ...[...selectedNodeIds.value].map((nodeId): AuthoringCanvasCommand => ({ type: 'delete-node', nodeId }))
        ];
        if (commands.length > 0)
        {
            applyOperation({ type: 'batch', commands });
        }
    }
    function pinReference(nodeId: string, pinnedRevision: number | string): void
    {
        applyOperation({ type: 'pin-reference', nodeId, pinnedRevision });
    }
    function unpinReference(nodeId: string): void
    {
        applyOperation({ type: 'unpin-reference', nodeId });
    }
    function setZoom(zoom: number): void
    {
        if (!Number.isFinite(zoom))
        {
            return;
        }
        const clampedZoom = Math.max(AUTHORING_CANVAS_BUDGETS.MIN_ZOOM, Math.min(AUTHORING_CANVAS_BUDGETS.MAX_ZOOM, zoom));
        viewport.value.zoom = clampedZoom;
        applyOperation({ type: 'set-viewport', viewport: { ...viewport.value } });
    }
    function panBy(dx: number, dy: number): void
    {
        if (!Number.isFinite(dx) || !Number.isFinite(dy))
        {
            return;
        }
        viewport.value.x += dx;
        viewport.value.y += dy;
        applyOperation({ type: 'set-viewport', viewport: { ...viewport.value } });
    }
    function resetViewport(): void
    {
        viewport.value = { x: 0, y: 0, zoom: 1 };
        applyOperation({ type: 'set-viewport', viewport: { ...viewport.value } });
    }
    function selectNode(nodeId: string, multi = false): void
    {
        if (!multi)
        {
            selectedNodeIds.value.clear();
            selectedEdgeIds.value.clear();
        }
        if (selectedNodeIds.value.has(nodeId))
        {
            if (multi)
            {
                selectedNodeIds.value.delete(nodeId);
            }
        }
        else
        {
            selectedNodeIds.value.add(nodeId);
        }
    }
    function selectEdge(edgeId: string, multi = false): void
    {
        if (!multi)
        {
            selectedNodeIds.value.clear();
            selectedEdgeIds.value.clear();
        }
        if (selectedEdgeIds.value.has(edgeId))
        {
            if (multi)
            {
                selectedEdgeIds.value.delete(edgeId);
            }
        }
        else
        {
            selectedEdgeIds.value.add(edgeId);
        }
    }
    function clearSelection(): void
    {
        selectedNodeIds.value.clear();
        selectedEdgeIds.value.clear();
    }
    return {
        document,
        loading,
        saving,
        pendingTransition,
        retryPendingOperation,
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
