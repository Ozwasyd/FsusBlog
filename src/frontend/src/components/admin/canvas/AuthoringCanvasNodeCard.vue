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
            height: node.type === 'group-frame' ? `${node.height}px` : 'auto',
            minHeight: `${node.height}px`,
            zIndex: node.zIndex ?? (node.type === 'group-frame' ? 1 : 2)
        }"
        :tabindex="0"
        :role="node.type === 'group-frame' ? 'group' : 'article'"
        :aria-label="ariaNodeLabel"
        @click.stop="$emit('select', node.id, $event)"
        @keydown.delete.stop="$emit('delete', node.id)"
    >
        <!-- Group Frame Header -->
        <template v-if="node.type === 'group-frame'">
            <div class="frame-header">
                <span class="frame-icon">🔲</span>
                <span class="frame-title">{{ node.label || 'Group Frame' }}</span>
                <span class="frame-badge">{{ node.memberNodeIds?.length || 0 }} items</span>
            </div>
        </template>

        <!-- Plain Text Note -->
        <template v-else-if="node.type === 'plain-text-note'">
            <div class="node-header note-header">
                <span class="node-icon">📝</span>
                <span class="node-kind-badge">Note</span>
                <button
                    type="button"
                    class="node-action-btn delete-btn"
                    title="Delete Note"
                    aria-label="Delete Note"
                    @click.stop="$emit('delete', node.id)"
                >
                    ✕
                </button>
            </div>
            <div class="note-body">
                <textarea
                    v-if="isEditing"
                    v-model="localText"
                    class="note-textarea"
                    aria-label="Edit Note Text"
                    @blur="handleSaveText"
                    @keydown.escape="isEditing = false"
                ></textarea>
                <div
                    v-else
                    class="note-text-display"
                    @dblclick="isEditing = true"
                >
                    {{ node.text || 'Double click to add note text...' }}
                </div>
            </div>
        </template>

        <!-- Reference Nodes (Article / Heading / Block) -->
        <template v-else>
            <div class="node-header ref-header">
                <span class="node-icon">📄</span>
                <span class="node-kind-badge">{{ refKindLabel }}</span>
                <span class="node-status-badge" :class="statusClass">{{ statusLabel }}</span>
                <button
                    type="button"
                    class="node-action-btn delete-btn"
                    title="Delete Reference"
                    aria-label="Delete Reference"
                    @click.stop="$emit('delete', node.id)"
                >
                    ✕
                </button>
            </div>

            <div class="node-body ref-body">
                <h4 class="ref-title">{{ displayTitle }}</h4>
                <p v-if="projection?.snippet" class="ref-snippet">{{ projection.snippet }}</p>

                <div class="ref-footer">
                    <button
                        v-if="projection?.openIntent"
                        type="button"
                        class="ref-open-btn"
                        title="Open Source Article"
                        aria-label="Open Source Article"
                        @click.stop="$emit('open-source', projection.openIntent)"
                    >
                        ↗ Open
                    </button>

                    <button
                        type="button"
                        class="ref-pin-btn"
                        :class="{ active: isPinned }"
                        :title="isPinned ? 'Unpin Target Revision' : 'Pin Target Revision'"
                        :aria-label="isPinned ? 'Unpin Target Revision' : 'Pin Target Revision'"
                        @click.stop="handleTogglePin"
                    >
                        {{ isPinned ? '📌 Pinned' : '📍 Pin Rev' }}
                    </button>
                </div>
            </div>
        </template>
    </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type {
    AuthoringCanvasArticleReferenceNode,
    AuthoringCanvasBlockReferenceNode,
    AuthoringCanvasHeadingReferenceNode,
    AuthoringCanvasNode,
    AuthoringCanvasOpenIntent,
    AuthoringCanvasPlainTextNoteNode,
    AuthoringCanvasReferenceProjection
} from '@/contracts/authoringCanvas';

const props = defineProps<{
    node: AuthoringCanvasNode;
    projection?: AuthoringCanvasReferenceProjection;
    selected: boolean;
}>();

const emit = defineEmits<{
    (e: 'select', id: string, event: MouseEvent): void;
    (e: 'delete', id: string): void;
    (e: 'edit-text', id: string, text: string): void;
    (e: 'pin', id: string, revision: number | string): void;
    (e: 'unpin', id: string): void;
    (e: 'open-source', intent: AuthoringCanvasOpenIntent): void;
}>();

const isEditing = ref(false);
const localText = ref((props.node as AuthoringCanvasPlainTextNoteNode).text || '');

const refKindLabel = computed(() => {
    switch (props.node.type) {
        case 'heading-reference':
            return 'Heading';
        case 'block-reference':
            return 'Block';
        default:
            return 'Article';
    }
});

const isPinned = computed(() => {
    if (props.node.type === 'article-reference' || props.node.type === 'heading-reference' || props.node.type === 'block-reference') {
        const refNode = props.node as AuthoringCanvasArticleReferenceNode | AuthoringCanvasHeadingReferenceNode | AuthoringCanvasBlockReferenceNode;
        return refNode.pinnedTargetRevision !== undefined;
    }
    return false;
});

const isStale = computed(() => props.projection?.status === 'pinned-stale' || props.projection?.status === 'source-stale');

const statusLabel = computed(() => {
    const s = props.projection?.status || 'current';
    switch (s) {
        case 'current':
            return 'Current';
        case 'pinned-current':
            return 'Pinned';
        case 'pinned-stale':
            return 'Stale Update Available';
        case 'missing':
            return 'Missing';
        case 'archived':
            return 'Archived';
        case 'permission-denied':
            return 'Private / Denied';
        case 'heading-missing':
            return 'Heading Not Found';
        case 'block-missing':
            return 'Block Not Found';
        default:
            return s;
    }
});

const statusClass = computed(() => {
    const s = props.projection?.status || 'current';
    if (s === 'current' || s === 'pinned-current') return 'status-success';
    if (s === 'pinned-stale') return 'status-warning';
    return 'status-danger';
});

const displayTitle = computed(() => {
    if (props.projection?.status === 'permission-denied') {
        return 'Private Reference (Access Denied)';
    }
    if (props.projection?.title) {
        return props.projection.title;
    }
    if ('targetArticleId' in props.node) {
        return `Article #${props.node.targetArticleId}`;
    }
    return props.node.id;
});

const ariaNodeLabel = computed(() => {
    if (props.node.type === 'group-frame') {
        return `Group Frame: ${props.node.label || 'Unnamed'}`;
    }
    if (props.node.type === 'plain-text-note') {
        return `Note: ${props.node.text?.slice(0, 30) || 'Empty'}`;
    }
    return `Reference: ${displayTitle.value} (${statusLabel.value})`;
});

function handleSaveText() {
    isEditing.value = false;
    emit('edit-text', props.node.id, localText.value);
}

function handleTogglePin() {
    if (isPinned.value) {
        emit('unpin', props.node.id);
    } else {
        const targetRev = props.projection?.targetRevision || 1;
        emit('pin', props.node.id, targetRev);
    }
}
</script>

<style scoped>
.canvas-node-card {
    position: absolute;
    top: 0;
    left: 0;
    box-sizing: border-box;
    background: var(--fsus-bg-color-overlay, #ffffff);
    border: 1px solid var(--fsus-border-color, #cbd5e1);
    border-radius: 8px;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
    display: flex;
    flex-direction: column;
    padding: 10px;
    font-size: 13px;
    cursor: default;
    transition: box-shadow 0.15s ease, border-color 0.15s ease;
}

.canvas-node-card.selected {
    border-color: var(--fsus-color-primary, #3b82f6);
    box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.35);
}

.canvas-node-card.node-group-frame {
    background: rgba(241, 245, 249, 0.45);
    border: 2px dashed #94a3b8;
    border-radius: 12px;
}

.frame-header {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
    color: #475569;
}

.frame-badge {
    margin-left: auto;
    font-size: 11px;
    background: #e2e8f0;
    padding: 2px 6px;
    border-radius: 10px;
}

.node-header {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 6px;
}

.node-kind-badge {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    color: #64748b;
}

.node-status-badge {
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 4px;
    font-weight: 500;
}

.status-success {
    background: #dcfce7;
    color: #15803d;
}

.status-warning {
    background: #fef9c3;
    color: #a16207;
}

.status-danger {
    background: #fee2e2;
    color: #b91c1c;
}

.node-action-btn {
    margin-left: auto;
    border: none;
    background: transparent;
    cursor: pointer;
    color: #94a3b8;
    font-size: 12px;
    border-radius: 4px;
    padding: 2px 4px;
}

.node-action-btn:hover {
    background: #fee2e2;
    color: #b91c1c;
}

.ref-title {
    margin: 0 0 4px 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--fsus-text-color-primary, #1e293b);
    line-height: 1.3;
}

.ref-snippet {
    margin: 0 0 8px 0;
    font-size: 12px;
    color: var(--fsus-text-color-secondary, #64748b);
    line-height: 1.4;
}

.ref-footer {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: auto;
}

.ref-open-btn,
.ref-pin-btn {
    border: 1px solid var(--fsus-border-color, #cbd5e1);
    background: #f8fafc;
    border-radius: 4px;
    padding: 2px 8px;
    font-size: 11px;
    cursor: pointer;
}

.ref-pin-btn.active {
    background: #eff6ff;
    border-color: #93c5fd;
    color: #1d4ed8;
}

.note-textarea {
    width: 100%;
    height: 80px;
    border: 1px solid #94a3b8;
    border-radius: 4px;
    padding: 6px;
    font-family: inherit;
    font-size: 12px;
    resize: none;
}

.note-text-display {
    min-height: 60px;
    white-space: pre-wrap;
    word-break: break-word;
    color: #334155;
    font-size: 12px;
    line-height: 1.4;
}
</style>
