<template>
    <div
        class="authoring-canvas-workspace"
        role="region"
        :aria-label="t('admin.canvas.title')"
        @keydown="handleGlobalKeydown"
    >
        <p
            v-if="canvas.loading.value"
            role="status"
        >{{ t('common.loading.status') }}</p>
        <p
            v-if="canvas.error.value"
            role="alert"
        >{{ t('admin.canvas.unavailable') }}</p>
        <!-- Top Toolbar -->
        <AuthoringCanvasToolbar
            :zoom="canvas.viewport.value.zoom"
            :disabled="!canvas.document.value || canvas.loading.value || canvas.saving.value || linkCommitting || Boolean(pendingLinkWrite) || Boolean(canvas.pendingTransition.value)"
            :can-undo="canvas.canUndo.value"
            :can-redo="canvas.canRedo.value"
            :has-selection="hasSelection"
            :can-connect="canConnect"
            :can-convert="Boolean(selectedExplicitEdge)"
            :view-mode="canvas.activeViewMode.value"
            @connect-visual="connectSelected(false)"
            @connect-reference="connectSelected(true)"
            @convert-selected="selectedExplicitEdge && handleConvertToLink(selectedExplicitEdge)"
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

        <div
            v-if="pendingLinkWrite"
            role="status"
        >
            {{ t('admin.canvas.retryPending') }}
            <ElButton
                :disabled="linkCommitting"
                @click="executePendingLinkWrite"
            >{{ t('admin.canvas.retry') }}</ElButton>
        </div>
        <div
            v-if="canvas.pendingTransition.value"
            role="status"
        >
            {{ t('admin.canvas.retryPending') }}
            <ElButton
                :disabled="canvas.saving.value"
                @click="canvas.retryPendingOperation"
            >{{ t('admin.canvas.retry') }}</ElButton>
        </div>
        <section
            v-if="linkHistorySource !== undefined"
            :aria-label="t('admin.canvas.articleHistory')"
        >
            <h3>{{ t('admin.canvas.articleHistory') }}</h3>
            <p
                v-if="linkHistoryLoading"
                role="status"
            >{{ t('common.loading.status') }}</p>
            <template v-else-if="linkHistory">
                <p
                    v-if="String(linkHistory.historyArticleRevision) === '0'"
                    role="status"
                >{{ t('admin.canvas.empty') }}</p>
                <p
                    v-else-if="!linkHistoryAligned"
                    role="status"
                >{{ t('admin.canvas.articleHistoryConflict') }}</p>
                <ElButton
                    :disabled="!linkHistoryAligned || !linkHistory.undoEntries.length || linkCommitting || Boolean(pendingLinkWrite)"
                    @click="changeLinkHistory('undo')"
                >{{ t('admin.canvas.articleUndo') }}</ElButton>
                <ElButton
                    :disabled="!linkHistoryAligned || !linkHistory.redoEntries.length || linkCommitting || Boolean(pendingLinkWrite)"
                    @click="changeLinkHistory('redo')"
                >{{ t('admin.canvas.articleRedo') }}</ElButton>
                <ElButton
                    :disabled="linkCommitting || linkHistoryLoading"
                    @click="refreshLinkHistory"
                >{{ t('admin.canvas.refreshHistory') }}</ElButton>
            </template>
        </section>
        <!-- Main Content Area -->
        <div class="workspace-body">
            <!-- Canvas Viewport -->
            <div
                v-show="canvas.activeViewMode.value === 'canvas'"
                ref="viewportRef"
                class="canvas-viewport"
                tabindex="0"
                role="region"
                :aria-label="t('admin.canvas.canvas')"
                @pointerdown="handlePointerDown"
                @pointermove="handlePointerMove"
                @pointerup="finishPan"
                @pointercancel="finishPan"
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
                    <svg
                        class="canvas-edges-svg"
                        width="20000"
                        height="20000"
                        style="position: absolute; top: -10000px; left: -10000px; pointer-events: none;"
                    >
                        <defs>
                            <marker
                                id="edge-arrow"
                                markerWidth="10"
                                markerHeight="7"
                                refX="9"
                                refY="3.5"
                                orient="auto"
                            >
                                <polygon
                                    points="0 0, 10 3.5, 0 7"
                                    fill="var(--el-border-color)"
                                />
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
                        @move="canvas.moveNode"
                        @resize="canvas.resizeNode"
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

        <FsusDialog
            v-model="referenceDialogVisible"
            :title="t('admin.canvas.reference')"
            :width="fsusDialogWidths.compact"
        >
            <ElSelect
                v-model="referenceKind"
                :aria-label="t('admin.canvas.reference')"
            >
                <ElOption
                    value="article-reference"
                    :label="t('admin.canvas.article')"
                />
                <ElOption
                    value="heading-reference"
                    :label="t('admin.canvas.heading')"
                />
                <ElOption
                    value="block-reference"
                    :label="t('admin.canvas.block')"
                />
            </ElSelect>
            <ElInput
                v-if="referenceKind !== 'article-reference'"
                v-model="referenceIdentity"
                :maxlength="64"
                :aria-label="t(referenceKind === 'heading-reference' ? 'admin.canvas.heading' : 'admin.canvas.block')"
            />
            <ElInput
                v-model="referenceArticleId"
                :aria-label="t('admin.canvas.articleId')"
                inputmode="numeric"
            />
            <template #footer><ElButton
                :disabled="!validReference"
                @click="addReferenceFromInput"
            >{{ t('common.actions.confirm') }}</ElButton></template>
        </FsusDialog>
        <!-- Edge To Link Dialog -->
        <AuthoringCanvasEdgeToLinkDialog
            :visible="edgeToLinkDialogVisible"
            :plan="currentLinkPlan"
            :can-commit="canCommitLink"
            @cancel="edgeToLinkDialogVisible = false"
            @confirm="handleConfirmLinkConversion"
        />

        <!-- Portable Package Dialog -->
        <AuthoringCanvasPackageDialog
            :visible="packageDialogVisible"
            :mode="packageDialogMode"
            :export-content="exportedPackageJson"
            @close="packageDialogVisible = false"
        />
    </div>
</template>

<script setup lang="ts">
import { ElButton, ElInput, ElSelect, ElOption } from '@ozwasyd/element-plus';
import { computed, onMounted, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { useRouter } from 'vue-router';

import FsusDialog from '@/components/ui/FsusDialog.vue';
import type { AuthoringCanvasSession, OutlineItem } from '@/composables/useAuthoringCanvas';
import { useAuthoringCanvas } from '@/composables/useAuthoringCanvas';
import { useI18nText } from '@/composables/useI18nText';
import type { AuthoringCanvasEdge, AuthoringCanvasOpenIntent } from '@/contracts/authoringCanvas';
import { AUTHORING_CANVAS_BUDGETS } from '@/contracts/authoringCanvas';
import { fsusDialogWidths } from '@/fsusui/dialog';
import { planEdgeToLinkConversion, type EdgeToLinkTransaction, type EdgeToLinkHistory, type EdgeToLinkReceipt, type EdgeToLinkPendingWrite, type EdgeToLinkPlan } from '@/services/authoringCanvasEdgeToLink';
import { exportAuthoringCanvasPackage } from '@/services/authoringCanvasPackage';

import AuthoringCanvasEdgeRenderer from './AuthoringCanvasEdgeRenderer.vue';
import AuthoringCanvasEdgeToLinkDialog from './AuthoringCanvasEdgeToLinkDialog.vue';
import AuthoringCanvasNodeCard from './AuthoringCanvasNodeCard.vue';
import AuthoringCanvasOutlineView from './AuthoringCanvasOutlineView.vue';
import AuthoringCanvasPackageDialog from './AuthoringCanvasPackageDialog.vue';
import AuthoringCanvasToolbar from './AuthoringCanvasToolbar.vue';
const props = defineProps<{
    canvasId?: string;
    session: AuthoringCanvasSession;
    newCanvasTitle?: string;
    linkTransaction?: EdgeToLinkTransaction;
}>();
const router = useRouter();
const canvas = useAuthoringCanvas(props.session);
const { t } = useI18nText();
const viewportRef = ref<HTMLElement | null>(null);
const referenceDialogVisible = ref(false);
const referenceArticleId = ref('');
const referenceKind = ref<'article-reference' | 'heading-reference' | 'block-reference'>('article-reference');
const referenceIdentity = ref('');
const validReference = computed(() => validArticleId.value && (referenceKind.value === 'article-reference'
    || /^[a-z][a-z0-9-]{0,63}$/u.test(referenceIdentity.value)));
const validArticleId = computed(() => /^[1-9]\d{0,9}$/u.test(referenceArticleId.value)
    && Number(referenceArticleId.value) <= 2147483647);
function addReferenceFromInput()
{
    if (!validReference.value)
    {
        return;
    }
    if (referenceKind.value === 'heading-reference')
    {
        canvas.addHeadingReference(referenceArticleId.value, referenceIdentity.value, 200, 200);
    }
    else if (referenceKind.value === 'block-reference')
    {
        canvas.addBlockReference(referenceArticleId.value, referenceIdentity.value, 200, 200);
    }
    else
    {
        canvas.addArticleReference(referenceArticleId.value, 200, 200);
    }
    referenceDialogVisible.value = false;
}
const hasSelection = computed(() => canvas.selectedNodeIds.value.size > 0 || canvas.selectedEdgeIds.value.size > 0);
const canConnect = computed(() => canvas.selectedNodeIds.value.size === 2);
const selectedExplicitEdge = computed(() =>
{
    if (canvas.selectedEdgeIds.value.size !== 1)
    {
        return undefined;
    }
    const id = [...canvas.selectedEdgeIds.value][0];
    const edge = canvas.document.value?.edges[id];
    return edge?.type === 'explicit-reference-note' ? edge : undefined;
});
function connectSelected(reference: boolean)
{
    if (!canConnect.value)
    {
        return;
    }
    const [source, target] = [...canvas.selectedNodeIds.value];
    canvas.connectNodes(source, target, reference ? 'explicit-reference-note' : 'visual-only');
}
// Edge-to-Link Dialog State
const edgeToLinkDialogVisible = ref(false);
const currentLinkPlan = ref<EdgeToLinkPlan | null>(null);
const currentLinkBinding = ref<{
    canvasId: string;
    revision: number;
    digest: string;
}>();
// Package Dialog State
const packageDialogVisible = ref(false);
const packageDialogMode = ref<'export' | 'import'>('export');
const exportedPackageJson = ref('');
let resizeObserver: ResizeObserver | undefined;
onMounted(async () =>
{
    if (viewportRef.value)
    {
        resizeObserver = new ResizeObserver(entries =>
        {
            const size = entries[0]?.contentRect;
            if (size)
            {
                canvas.containerDimensions.value = { width: size.width, height: size.height };
            }
        });
        resizeObserver.observe(viewportRef.value);
    }
    if (props.canvasId)
    {
        await canvas.loadCanvas(props.canvasId);
    }
    else if (props.newCanvasTitle)
    {
        const created = await canvas.createCanvas(props.newCanvasTitle);
        if (created)
        {
            void router.replace({ name: 'ManageAuthoringCanvasDocument', params: { id: created.id } });
        }
    }
});
function toggleViewMode()
{
    canvas.activeViewMode.value = canvas.activeViewMode.value === 'canvas' ? 'outline' : 'canvas';
}
function handleAddNote()
{
    canvas.addPlainTextNote(t('admin.canvas.note'), 150, 150);
}
function handleAddReference()
{
    referenceDialogVisible.value = true;
}
function handleAddFrame()
{
    const selected = Array.from(canvas.selectedNodeIds.value);
    canvas.addGroupFrame(selected, t('admin.canvas.frame'));
}
function handleSelectNode(nodeId: string, event: MouseEvent | KeyboardEvent)
{
    canvas.selectNode(nodeId, event.shiftKey || event.ctrlKey || event.metaKey);
}
function handleSelectEdge(edgeId: string, event: MouseEvent | KeyboardEvent)
{
    canvas.selectEdge(edgeId, event.shiftKey || event.ctrlKey || event.metaKey);
}
function handleOpenSource(intent: AuthoringCanvasOpenIntent)
{
    if (intent.route)
    {
        void router.push(intent.route);
    }
}
function handleOutlineSelect(item: OutlineItem)
{
    if (item.kind === 'edge')
    {
        canvas.selectEdge(item.id);
    }
    else
    {
        canvas.selectNode(item.id);
    }
}
function handleOutlineDelete(item: OutlineItem)
{
    if (item.kind === 'edge')
    {
        canvas.deleteEdge(item.id);
    }
    else
    {
        canvas.deleteNode(item.id);
    }
}
function handleOutlineOpenSource(nodeId: string)
{
    const proj = canvas.projections.value.get(nodeId);
    if (proj?.openIntent)
    {
        handleOpenSource(proj.openIntent);
    }
}
function linkTitleOrDefault(value: string | undefined): string
{
    if (value)
    {
        return value;
    }
    return t('admin.canvas.article');
}
function handleConvertToLink(edge: AuthoringCanvasEdge)
{
    if (!canvas.document.value || pendingLinkWrite.value || linkCommitting.value)
    {
        return;
    }
    const document = canvas.document.value;
    currentLinkBinding.value = { canvasId: document.id, revision: document.revision, digest: document.contentDigest };
    const targetProj = canvas.projections.value.get(edge.targetNodeId);
    const plan = planEdgeToLinkConversion(edge, canvas.document.value.nodes, linkTitleOrDefault(targetProj?.title));
    currentLinkPlan.value = plan;
    edgeToLinkDialogVisible.value = true;
}
type PendingLinkWrite = EdgeToLinkPendingWrite;
const linkCommitting = ref(false);
const pendingLinkWrite = shallowRef<PendingLinkWrite | null>(props.linkTransaction?.pendingWrite?.() ?? null);
const linkHistory = shallowRef<EdgeToLinkHistory | null>(null);
const linkHistoryLoading = ref(false);
const linkHistorySource = ref<number | string>();
let linkHistoryGeneration = 0;
onMounted(() =>
{
    const pending = pendingLinkWrite.value;
    if (!pending)
    {
        return;
    }
    linkHistorySource.value = pending.request.sourceArticleId;
    if (pending.kind === 'commit')
    {
        currentLinkPlan.value = { ...pending.request.plan };
        currentLinkBinding.value = { canvasId: pending.request.canvasId,
                                     revision: pending.request.canvasRevision, digest: pending.request.canvasContentDigest };
    }
    void refreshLinkHistory();
});
const canCommitLink = computed(() =>
{
    if (pendingLinkWrite.value?.kind === 'commit')
    {
        return !linkCommitting.value;
    }
    const plan = currentLinkPlan.value;
    const document = canvas.document.value;
    const binding = currentLinkBinding.value;
    if (!document)
    {
        return false;
    }
    if (!binding)
    {
        return false;
    }
    if (document.id !== binding.canvasId || document.revision !== binding.revision
        || document.contentDigest !== binding.digest || !plan || !Object.hasOwn(document.edges, plan.edgeId))
    {
        return false;
    }
    if (!props.linkTransaction || !plan.valid || !plan.sourceArticleId || !plan.targetArticleId
        || canvas.saving.value || canvas.pendingTransition.value || linkCommitting.value || pendingLinkWrite.value)
    {
        return false;
    }
    const source = canvas.projections.value.get(plan.sourceNodeId);
    const target = canvas.projections.value.get(plan.targetNodeId);
    return source?.targetRevision !== undefined && target?.targetRevision !== undefined
        && (source.status === 'current' || source.status === 'pinned-current')
        && (target.status === 'current' || target.status === 'pinned-current')
        && Boolean(source.openIntent && target.openIntent);
});
const linkHistoryAligned = computed(() =>
{
    const value = linkHistory.value;
    if (!value)
    {
        return false;
    }
    return String(value.sourceArticleId) === String(linkHistorySource.value)
        && String(value.historyArticleRevision) === String(value.articleRevision);
});
function isHistoryArray(value: unknown): boolean
{
    return Array.isArray(value);
}
async function refreshLinkHistory()
{
    const sourceArticleId = linkHistorySource.value;
    const token = ++linkHistoryGeneration;
    linkHistory.value = null;
    if (!props.linkTransaction || sourceArticleId === undefined)
    {
        return;
    }
    linkHistoryLoading.value = true;
    try
    {
        const value = await props.linkTransaction.history(sourceArticleId);
        if (token !== linkHistoryGeneration)
        {
            return;
        }
        if (String(value.sourceArticleId) !== String(sourceArticleId)
            || !/^[1-9][0-9]*$/u.test(String(value.articleRevision))
            || !/^(?:0|[1-9][0-9]*)$/u.test(String(value.historyArticleRevision))
            || !isHistoryArray(value.undoEntries) || !isHistoryArray(value.redoEntries)
            || (String(value.historyArticleRevision) === '0' && (value.undoEntries.length || value.redoEntries.length))
            || [...value.undoEntries, ...value.redoEntries].some(entry => !entry.journalId)
            || new Set([...value.undoEntries, ...value.redoEntries].map(entry => entry.journalId)).size
                !== value.undoEntries.length + value.redoEntries.length)
        {
            throw new Error('canvas_link_history_mismatch');
        }
        linkHistory.value = value;
    }
    catch
    {
        if (token === linkHistoryGeneration)
        {
            canvas.error.value = t('admin.canvas.unavailable');
        }
    }
    finally
    {
        if (token === linkHistoryGeneration)
        {
            linkHistoryLoading.value = false;
        }
    }
}
watch(() => currentLinkPlan.value?.sourceArticleId, source =>
{
    if (source !== undefined)
    {
        linkHistorySource.value = source;
        void refreshLinkHistory();
    }
});
function checkLinkReceipt(receipt: EdgeToLinkReceipt, pending: PendingLinkWrite)
{
    const request = pending.request;
    if (receipt.requestId !== request.requestId || String(receipt.sourceArticleId) !== String(request.sourceArticleId)
        || String(receipt.previousArticleRevision) !== String(request.expectedArticleRevision)
        || !/^[1-9][0-9]*$/u.test(String(receipt.articleRevision))
        || String(receipt.articleRevision) === String(request.expectedArticleRevision))
    {
        throw new Error('canvas_link_receipt_mismatch');
    }
}
async function executePendingLinkWrite()
{
    const pending = pendingLinkWrite.value;
    const transaction = props.linkTransaction;
    if (!pending || !transaction || linkCommitting.value)
    {
        return;
    }
    linkCommitting.value = true;
    let responseReceived = false;
    try
    {
        const receipt = transaction.pendingWrite?.()?.request.requestId === pending.request.requestId && transaction.retryPending
            ? await transaction.retryPending() : pending.kind === 'commit' ? await transaction.commit(pending.request)
                : pending.kind === 'undo' ? await transaction.undo(pending.request) : await transaction.redo(pending.request);
        responseReceived = true;
        checkLinkReceipt(receipt, pending);
        pendingLinkWrite.value = null;
        canvas.error.value = null;
        edgeToLinkDialogVisible.value = false;
        linkHistorySource.value = pending.request.sourceArticleId;
        // The write is acknowledged before separate projection/history refreshes.
        await refreshLinkHistory();
        await canvas.refreshProjections();
    }
    catch
    {
        // The transport clears its slot only for a definitive refusal or verified acknowledgment.
        if (!responseReceived)
        {
            if (transaction.pendingWrite)
            {
                if (transaction.pendingWrite() === null)
                {
                    pendingLinkWrite.value = null;
                }
            }
        }
        canvas.error.value = t(pendingLinkWrite.value ? 'admin.canvas.retryPending' : 'admin.canvas.unavailable');
    }
    finally
    {
        linkCommitting.value = false;
    }
}
async function handleConfirmLinkConversion(plan: EdgeToLinkPlan)
{
    if (pendingLinkWrite.value?.kind === 'commit')
    {
        await executePendingLinkWrite();
        return;
    }
    const doc = canvas.document.value;
    const source = canvas.projections.value.get(plan.sourceNodeId);
    const target = canvas.projections.value.get(plan.targetNodeId);
    if (!canCommitLink.value || !doc || !source || !target || source.targetRevision === undefined
        || target.targetRevision === undefined || plan.sourceArticleId === undefined || plan.targetArticleId === undefined)
    {
        return;
    }
    pendingLinkWrite.value = { kind: 'commit', request: structuredClone({ requestId: crypto.randomUUID(),
                                                                          canvasId: doc.id, canvasRevision: doc.revision, canvasContentDigest: doc.contentDigest,
                                                                          sourceArticleId: plan.sourceArticleId, expectedArticleRevision: source.targetRevision,
                                                                          targetArticleId: plan.targetArticleId, expectedTargetRevision: target.targetRevision, plan: { ...plan } }) };
    await executePendingLinkWrite();
}
async function changeLinkHistory(kind: 'undo' | 'redo')
{
    const history = linkHistory.value;
    if (!history || !linkHistoryAligned.value || pendingLinkWrite.value || linkCommitting.value || canvas.saving.value)
    {
        return;
    }
    const top = (kind === 'undo' ? history.undoEntries : history.redoEntries).at(-1);
    if (!top)
    {
        return;
    }
    pendingLinkWrite.value = { kind, request: { requestId: crypto.randomUUID(), sourceArticleId: history.sourceArticleId,
                                                expectedArticleRevision: history.articleRevision, targetJournalId: top.journalId } };
    await executePendingLinkWrite();
}
function openExportDialog()
{
    if (!canvas.document.value)
    {
        return;
    }
    const pkg = exportAuthoringCanvasPackage(canvas.document.value, canvas.projections.value);
    exportedPackageJson.value = JSON.stringify(pkg, null, 2);
    packageDialogMode.value = 'export';
    packageDialogVisible.value = true;
}
function openImportDialog()
{
    packageDialogMode.value = 'import';
    packageDialogVisible.value = true;
}
// Pointer capture keeps touch/mouse drag listeners owned by this viewport.
let pointerId: number | undefined;
let startX = 0;
let startY = 0;
function handlePointerDown(e: PointerEvent)
{
    if (e.button !== 0 || !canvas.document.value || canvas.saving.value || pendingLinkWrite.value || canvas.pendingTransition.value)
    {
        return;
    }
    if (e.target !== viewportRef.value && !(e.target as HTMLElement)?.classList.contains('canvas-world'))
    {
        return;
    }
    pointerId = e.pointerId;
    startX = e.clientX - canvas.viewport.value.x;
    startY = e.clientY - canvas.viewport.value.y;
    viewportRef.value?.setPointerCapture(e.pointerId);
}
function handlePointerMove(e: PointerEvent)
{
    if (e.pointerId !== pointerId)
    {
        return;
    }
    canvas.viewport.value = { ...canvas.viewport.value, x: e.clientX - startX, y: e.clientY - startY };
}
function finishPan(e: PointerEvent)
{
    if (e.pointerId !== pointerId)
    {
        return;
    }
    pointerId = undefined;
    if (viewportRef.value?.hasPointerCapture(e.pointerId))
    {
        viewportRef.value.releasePointerCapture(e.pointerId);
    }
    if (e.type === 'pointercancel')
    {
        if (canvas.document.value)
        {
            canvas.viewport.value = { ...canvas.document.value.viewport };
        }
    }
    else
    {
        canvas.applyOperation({ type: 'set-viewport', viewport: { ...canvas.viewport.value } });
    }
}
let zoomTimer: ReturnType<typeof setTimeout> | undefined;
function handleWheel(e: WheelEvent)
{
    if (!canvas.document.value || canvas.saving.value || pendingLinkWrite.value || canvas.pendingTransition.value)
    {
        return;
    }
    const delta = e.deltaY < 0 ? 0.1 : -0.1;
    canvas.viewport.value.zoom = Math.min(AUTHORING_CANVAS_BUDGETS.MAX_ZOOM, Math.max(AUTHORING_CANVAS_BUDGETS.MIN_ZOOM, canvas.viewport.value.zoom + delta));
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => canvas.applyOperation({ type: 'set-viewport', viewport: { ...canvas.viewport.value } }), 120);
}
onBeforeUnmount(() =>
{
    linkHistoryGeneration++;
    resizeObserver?.disconnect();
    clearTimeout(zoomTimer);
    pointerId = undefined;
});
watch(() => canvas.document.value?.id, () =>
{
    clearTimeout(zoomTimer);
    pointerId = undefined;
});
function handleGlobalKeydown(e: KeyboardEvent)
{
    const target = e.target instanceof HTMLElement ? e.target : null;
    if (target?.isContentEditable || target?.closest('input, textarea, button, select, [role="textbox"], [role="combobox"]'))
    {
        return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'z')
    {
        e.preventDefault();
        if (e.shiftKey)
        {
            canvas.redo();
        }
        else
        {
            canvas.undo();
        }
    }
    else if ((e.ctrlKey || e.metaKey) && e.key === 'y')
    {
        e.preventDefault();
        canvas.redo();
    }
    else if (e.key === 'Delete' || e.key === 'Backspace')
    {
        const activeTag = (document.activeElement as HTMLElement)?.tagName;
        if (activeTag !== 'INPUT' && activeTag !== 'TEXTAREA')
        {
            canvas.deleteSelected();
        }
    }
}
</script>



<style scoped>
.authoring-canvas-workspace
 {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    overflow: hidden;
    position: relative;
    background: var(--el-bg-color);
}

.workspace-body
 {
    display: flex;
    flex: 1;
    overflow: hidden;
    position: relative;
}

.canvas-viewport
 {
    flex: 1;
    height: 100%;
    position: relative;
    overflow: hidden;
    outline: revert;
    cursor: grab;
    touch-action: none;

}

.canvas-viewport:active
 {
    cursor: grabbing;
}

.canvas-world
 {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: auto;
}

.outline-container
 {
    flex: 1;
    height: 100%;
    max-width: 600px;
    margin: 0 auto;
}

</style>
