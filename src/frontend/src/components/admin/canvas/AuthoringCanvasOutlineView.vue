<template>
    <section
        class="canvas-outline-view"
        role="region"
        aria-label="Structured Canvas Outline"
    >
        <div class="outline-header">
            <h3 class="outline-title">Canvas Outline</h3>
            <span class="outline-count">{{ items.length }} total items</span>
        </div>

        <ul class="outline-list" role="list">
            <li
                v-for="item in items"
                :key="item.id"
                class="outline-item"
                :class="[
                    `kind-${item.kind}`,
                    { selected: item.selected }
                ]"
                role="listitem"
                :tabindex="0"
                :aria-selected="item.selected"
                :aria-label="item.title"
                @click="$emit('select-item', item)"
                @keydown.delete.prevent="$emit('delete-item', item)"
                @keydown.enter.prevent="$emit('select-item', item)"
            >
                <div class="item-main">
                    <span class="item-icon">{{ getItemIcon(item) }}</span>
                    <span class="item-title">{{ item.title }}</span>
                    <span v-if="item.status" class="item-status-chip">{{ item.status }}</span>
                </div>

                <div v-if="item.snippet" class="item-snippet">
                    {{ item.snippet }}
                </div>

                <div class="item-actions">
                    <button
                        v-if="item.kind === 'node' && isRef(item)"
                        type="button"
                        class="outline-action-btn"
                        title="Open Source Article"
                        aria-label="Open Source Article"
                        @click.stop="$emit('open-source', item.id)"
                    >
                        ↗ Open
                    </button>
                    <button
                        type="button"
                        class="outline-action-btn danger"
                        title="Delete Item"
                        aria-label="Delete Item"
                        @click.stop="$emit('delete-item', item)"
                    >
                        🗑
                    </button>
                </div>
            </li>

            <li v-if="items.length === 0" class="outline-empty">
                No nodes or edges in canvas document.
            </li>
        </ul>
    </section>
</template>

<script setup lang="ts">
import type { OutlineItem } from '@/composables/useAuthoringCanvas';

defineProps<{
    items: OutlineItem[];
}>();

defineEmits<{
    (e: 'select-item', item: OutlineItem): void;
    (e: 'delete-item', item: OutlineItem): void;
    (e: 'open-source', nodeId: string): void;
}>();

function getItemIcon(item: OutlineItem): string {
    if (item.kind === 'frame') return '🔲';
    if (item.kind === 'edge') return '🔗';
    if (item.type === 'plain-text-note') return '📝';
    return '📄';
}

function isRef(item: OutlineItem): boolean {
    return item.type === 'article-reference' || item.type === 'heading-reference' || item.type === 'block-reference';
}
</script>

<style scoped>
.canvas-outline-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--fsus-bg-color-overlay, #ffffff);
    border-left: 1px solid var(--fsus-border-color, #e2e8f0);
    overflow-y: auto;
    padding: 16px;
    box-sizing: border-box;
}

.outline-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--fsus-border-color, #e2e8f0);
}

.outline-title {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    color: var(--fsus-text-color-primary, #1e293b);
}

.outline-count {
    font-size: 12px;
    color: var(--fsus-text-color-secondary, #64748b);
}

.outline-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.outline-item {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 10px 12px;
    background: var(--fsus-fill-color-light, #f8fafc);
    border: 1px solid var(--fsus-border-color, #e2e8f0);
    border-radius: 6px;
    cursor: pointer;
    transition: background-color 0.15s ease, border-color 0.15s ease;
}

.outline-item:hover {
    background: var(--fsus-fill-color, #f1f5f9);
    border-color: #cbd5e1;
}

.outline-item.selected {
    background: #eff6ff;
    border-color: #3b82f6;
}

.item-main {
    display: flex;
    align-items: center;
    gap: 8px;
}

.item-icon {
    font-size: 14px;
}

.item-title {
    font-size: 13px;
    font-weight: 500;
    color: var(--fsus-text-color-primary, #1e293b);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.item-status-chip {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 10px;
    background: #e2e8f0;
    color: #475569;
    font-weight: 500;
}

.item-snippet {
    font-size: 11px;
    color: var(--fsus-text-color-secondary, #64748b);
    line-height: 1.3;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.item-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 4px;
}

.outline-action-btn {
    border: 1px solid #cbd5e1;
    background: #ffffff;
    border-radius: 4px;
    padding: 2px 8px;
    font-size: 11px;
    cursor: pointer;
}

.outline-action-btn.danger:hover {
    background: #fee2e2;
    border-color: #fca5a5;
    color: #b91c1c;
}

.outline-empty {
    font-size: 13px;
    color: #94a3b8;
    text-align: center;
    padding: 32px 16px;
}
</style>
