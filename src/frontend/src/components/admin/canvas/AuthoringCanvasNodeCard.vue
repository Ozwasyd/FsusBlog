<template>
    <div
        class="canvas-node-card"
        :class="[
            `node-${node.type}`,
            { selected, 'is-pinned': isPinned, 'is-stale': isStale }
        ]"
        :style="{
            transform: `translate(${node.x}px, ${node.y}px)`,
            width: `${node.width}px`,
            height: `${node.height}px`,
            minHeight: `${node.height}px`,
            zIndex: node.zIndex ?? (node.type === 'group-frame' ? 1 : 2)
        }"
        :tabindex="0"
        :role="node.type === 'group-frame' ? 'group' : 'article'"
        :aria-label="ariaNodeLabel"
        @click.stop="$emit('select', node.id, $event)"
        @keydown="handleGeometryKeyboard"
        @keydown.space.self.prevent.stop="$emit('select', node.id, $event)"
        @keydown.enter="handleEnterKeyboard"
        @keydown.delete.stop="handleDeleteKeyboard"
    >
        <!-- Group Frame Header -->
        <template v-if="node.type === 'group-frame'">
            <div class="frame-header">
                <span class="frame-title">{{ node.label || t('admin.canvas.frame') }}</span>
                <span class="frame-badge">{{ node.memberNodeIds?.length || 0 }}</span>
            </div>
        </template>

        <!-- Plain Text Note -->
        <template v-else-if="node.type === 'plain-text-note'">
            <div class="node-header note-header">
                <span class="node-kind-badge">{{ t('admin.canvas.note') }}</span>
                <ElButton
                    native-type="button"
                    class="node-action-btn delete-btn"
                    :title="t('common.actions.delete')"
                    :aria-label="t('common.actions.delete')"
                    @click.stop="$emit('delete', node.id)"
                >
                    ✕
                </ElButton>
            </div>
            <div class="note-body">
                <ElInput
                    type="textarea"
                    :rows="3"
                    ref="noteInput"
                    v-if="isEditing"
                    v-model="localText"
                    :maxlength="AUTHORING_CANVAS_BUDGETS.MAX_NOTE_TEXT_LENGTH"
                    class="note-textarea"
                    :aria-label="t('admin.canvas.editNote')"
                    @blur="handleSaveText"
                    @keydown.escape.stop="cancelEdit"
                ></ElInput>
                <div
                    v-else
                    class="note-text-display"
                    @dblclick="isEditing = true"
                >
                    {{ node.text || t('admin.canvas.editNote') }}
                </div>
            </div>
        </template>

        <!-- Reference Nodes (Article / Heading / Block) -->
        <template v-else>
            <div class="node-header ref-header">
                <span class="node-kind-badge">{{ refKindLabel }}</span>
                <span
                    class="node-status-badge"
                    :class="statusClass"
                >{{ statusLabel }}</span>
                <ElButton
                    native-type="button"
                    class="node-action-btn delete-btn"
                    :title="t('common.actions.delete')"
                    :aria-label="t('common.actions.delete')"
                    @click.stop="$emit('delete', node.id)"
                >
                    ✕
                </ElButton>
            </div>

            <div class="node-body ref-body">
                <h4 class="ref-title">{{ displayTitle }}</h4>
                <p
                    v-if="projection?.snippet"
                    class="ref-snippet"
                >{{ projection.snippet }}</p>

                <div class="ref-footer">
                    <ElButton
                        v-if="projection?.openIntent"
                        native-type="button"
                        class="ref-open-btn"
                        :title="t('admin.canvas.source')"
                        :aria-label="t('admin.canvas.source')"
                        @click.stop="$emit('open-source', projection.openIntent)"
                    >
                        {{ t('admin.canvas.source') }}
                    </ElButton>

                    <ElButton
                        :disabled="!isPinned && projection?.targetRevision === undefined"
                        native-type="button"
                        class="ref-pin-btn"
                        :class="{ active: isPinned }"
                        :title="t(isPinned ? 'admin.canvas.current' : 'admin.canvas.pinned')"
                        :aria-label="t(isPinned ? 'admin.canvas.current' : 'admin.canvas.pinned')"
                        @click.stop="handleTogglePin"
                    >
                        {{ t(isPinned ? 'admin.canvas.pinned' : 'admin.canvas.reference') }}
                    </ElButton>
                </div>
            </div>
        </template>
    </div>
</template>

<script setup lang="ts">
import { ElButton, ElInput } from '@ozwasyd/element-plus';
import { computed, nextTick, ref, watch } from 'vue';

import { useI18nText } from '@/composables/useI18nText';
import { AUTHORING_CANVAS_BUDGETS } from '@/contracts/authoringCanvas';
import type { AuthoringCanvasNode, AuthoringCanvasOpenIntent, AuthoringCanvasPlainTextNoteNode, AuthoringCanvasReferenceProjection } from '@/contracts/authoringCanvas';
const props = defineProps<{
    node: AuthoringCanvasNode;
    projection?: AuthoringCanvasReferenceProjection;
    selected: boolean;
}>();
const emit = defineEmits<{
    (e: 'select', id: string, event: MouseEvent | KeyboardEvent): void;
    (e: 'move', id: string, x: number, y: number): void;
    (e: 'resize', id: string, width: number, height: number): void;
    (e: 'delete', id: string): void;
    (e: 'edit-text', id: string, text: string): void;
    (e: 'pin', id: string, revision: number | string): void;
    (e: 'unpin', id: string): void;
    (e: 'open-source', intent: AuthoringCanvasOpenIntent): void;
}>();
const isEditing = ref(false);
const noteInput = ref<{
    focus(): void;
}>();
watch(isEditing, async (editing) =>
{
    if (editing)
    {
        await nextTick();
        noteInput.value?.focus();
    }
});
const localText = ref((props.node as AuthoringCanvasPlainTextNoteNode).text || '');
const refKindLabel = computed(() =>
{
    switch (props.node.type)
    {
        case 'heading-reference':
            return t('admin.canvas.heading');
        case 'block-reference':
            return t('admin.canvas.block');
        default:
            return t('admin.canvas.article');
    }
});
const isPinned = computed(() =>
{
    if (props.node.type === 'article-reference' || props.node.type === 'heading-reference' || props.node.type === 'block-reference')
    {
        const refNode = props.node;
        return refNode.pinnedTargetRevision !== undefined;
    }
    return false;
});
const isStale = computed(() => props.projection?.status === 'pinned-stale' || props.projection?.status === 'source-stale');
const statusLabel = computed(() =>
{
    const s = props.projection?.status;
    switch (s)
    {
        case 'current':
            return t('admin.canvas.current');
        case 'pinned-current':
            return t('admin.canvas.pinned');
        case 'pinned-stale':
        case 'target-updated':
        case 'source-stale':
            return t('admin.canvas.stale');
        case 'missing':
            return t('admin.canvas.missing');
        case 'archived':
            return t('admin.canvas.missing');
        case 'permission-denied':
            return t('admin.canvas.denied');
        case 'heading-missing':
            return t('admin.canvas.missing');
        case 'block-missing':
            return t('admin.canvas.missing');
        default:
            return t('admin.canvas.unavailable');
    }
});
const statusClass = computed(() =>
{
    const s = props.projection?.status;
    if (s === 'current' || s === 'pinned-current')
    {
        return 'status-success';
    }
    if (s === 'pinned-stale')
    {
        return 'status-warning';
    }
    return 'status-danger';
});
const displayTitle = computed(() =>
{
    if (props.projection?.status === 'permission-denied')
    {
        return t('admin.canvas.denied');
    }
    if (props.projection?.title)
    {
        return props.projection.title;
    }
    if ('targetArticleId' in props.node)
    {
        return `${t('admin.canvas.article')} #${props.node.targetArticleId}`;
    }
    return props.node.id;
});
const ariaNodeLabel = computed(() =>
{
    if (props.node.type === 'group-frame')
    {
        return `${t('admin.canvas.frame')}: ${props.node.label || t('admin.canvas.empty')}`;
    }
    if (props.node.type === 'plain-text-note')
    {
        return `${t('admin.canvas.note')}: ${props.node.text?.slice(0, 30) || t('admin.canvas.empty')}`;
    }
    return `${t('admin.canvas.reference')}: ${displayTitle.value} (${statusLabel.value})`;
});
function handleSaveText()
{
    if (!isEditing.value)
    {
        return;
    }
    isEditing.value = false;
    emit('edit-text', props.node.id, localText.value);
}
function handleTogglePin()
{
    if (isPinned.value)
    {
        emit('unpin', props.node.id);
    }
    else
    {
        const targetRev = props.projection?.targetRevision;
        if (targetRev !== undefined)
        {
            emit('pin', props.node.id, targetRev);
        }
    }
}
const { t } = useI18nText();
function cancelEdit()
{
    localText.value = props.node.type === 'plain-text-note' ? props.node.text : '';
    isEditing.value = false;
}
function handleGeometryKeyboard(event: KeyboardEvent)
{
    if (event.target !== event.currentTarget || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key))
    {
        return;
    }
    event.preventDefault();
    const step = event.shiftKey ? 10 : 1;
    const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
    const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
    if (event.altKey)
    {
        emit('resize', props.node.id, Math.max(AUTHORING_CANVAS_BUDGETS.MIN_NODE_EXTENT, props.node.width + dx), Math.max(AUTHORING_CANVAS_BUDGETS.MIN_NODE_EXTENT, props.node.height + dy));
    }
    else
    {
        emit('move', props.node.id, props.node.x + dx, props.node.y + dy);
    }
}
function handleEnterKeyboard(event: KeyboardEvent)
{
    if (event.target !== event.currentTarget || props.node.type !== 'plain-text-note')
    {
        return;
    }
    event.preventDefault();
    isEditing.value = true;
}
function handleDeleteKeyboard(event: KeyboardEvent)
{
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.isContentEditable || target?.closest('input,textarea'))
    {
        return;
    }
    emit('delete', props.node.id);
}
watch(() => props.node, node =>
{
    if (!isEditing.value && node.type === 'plain-text-note')
    {
        localText.value = node.text;
    }
});
</script>



<style scoped>
.canvas-node-card
 {
    position: absolute;
    top: 0;
    left: 0;
    box-sizing: border-box;
    background: var(--el-bg-color-overlay);
    border: 1px solid var(--el-border-color);
    border-radius: var(--fsus-radius-panel);
    box-shadow: none;
    display: flex;
    flex-direction: column;
    padding: var(--fsus-space-3);
    font-size: var(--el-font-size-base);
    cursor: default;
    overflow: auto;
    transition: box-shadow var(--fsus-motion-control) var(--fsus-motion-standard), border-color var(--fsus-motion-control) var(--fsus-motion-standard);
}

.canvas-node-card.selected
 {
    border-color: var(--fsus-scholarly-blue);
    box-shadow: none;
}

.canvas-node-card.node-group-frame
 {
    background: var(--el-fill-color-light);
    border: 2px dashed var(--el-border-color);
    border-radius: var(--fsus-radius-panel);
}

.frame-header
 {
    display: flex;
    align-items: center;
    gap: var(--fsus-space-2);
    font-weight: 600;
    color: var(--el-text-color-secondary);
}

.frame-badge
 {
    margin-left: auto;
    font-size: var(--el-font-size-base);
    background: var(--el-border-color);
    padding: 0 var(--fsus-space-2);
    border-radius: var(--fsus-radius-pill);
}

.node-header
 {
    display: flex;
    align-items: center;
    gap: var(--fsus-space-2);
    margin-bottom: var(--fsus-space-2);
}

.node-kind-badge
 {
    font-size: var(--el-font-size-base);
    font-weight: 600;
    text-transform: uppercase;
    color: var(--el-text-color-secondary);
}

.node-status-badge
 {
    font-size: var(--el-font-size-base);
    padding: 1px 5px;
    border-radius: var(--fsus-radius-panel);
    font-weight: 500;
}

.status-success
 {
    background: var(--el-color-success-light-9);
    color: var(--el-color-success);
}

.status-warning
 {
    background: var(--el-color-warning-light-9);
    color: var(--el-color-warning);
}

.status-danger
 {
    background: var(--el-color-danger-light-9);
    color: var(--el-color-danger);
}



.ref-title
 {
    margin: 0 0 var(--fsus-space-1) 0;
    font-size: var(--el-font-size-base);
    font-weight: 600;
    color: var(--el-text-color-primary);
    line-height: 1.3;
}

.ref-snippet
 {
    margin: 0 0 var(--fsus-space-2) 0;
    font-size: var(--el-font-size-base);
    color: var(--el-text-color-secondary);
    line-height: 1.4;
}

.ref-footer
 {
    display: flex;
    align-items: center;
    gap: var(--fsus-space-2);
    margin-top: auto;
}




.note-text-display
 {
    min-height: 60px;
    white-space: pre-wrap;
    word-break: normal;
    overflow-wrap: anywhere;
    color: var(--el-text-color-primary);
    font-size: var(--el-font-size-base);
    line-height: 1.4;
}

@media (prefers-reduced-motion: reduce)
 {
    .canvas-node-card
 {
        transition: none;
    }
}
</style>
