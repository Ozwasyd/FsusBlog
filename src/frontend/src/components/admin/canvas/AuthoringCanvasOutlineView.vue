<template>
    <section
        ref="outlineRoot"
        class="canvas-outline-view"
        role="region"
        :aria-label="t('admin.canvas.outline')"
    >
        <div class="outline-header">
            <h3 class="outline-title">{{ t('admin.canvas.outline') }}</h3>
            <span class="outline-count">{{ items.length }}</span>
        </div>

        <ElPagination
            v-if="items.length > pageSize"
            v-model:current-page="page"
            :page-size="pageSize"
            :total="items.length"
            responsive="auto"
            layout="prev, pager, next"
        />
        <ul
            ref="outlineList"
            class="outline-list"
            role="list"
        >
            <li
                v-for="item in pageItems"
                :key="item.id"
                :data-outline-id="item.id"
                class="outline-item"
                :class="[
                    `kind-${item.kind}`,
                    { selected: item.selected }
                ]"
                role="listitem"
                :tabindex="0"
                :aria-current="item.selected ? true : undefined"
                :aria-label="item.title"
                @click="$emit('select-item', item)"
                @keydown.delete.self.prevent="$emit('delete-item', item)"
                @keydown.enter.self.prevent="$emit('select-item', item)"
            >
                <div class="item-main">
                    <span class="item-title">{{ item.title }}</span>
                    <span
                        v-if="item.status"
                        class="item-status-chip"
                    >{{ statusLabel(item.status) }}</span>
                </div>

                <div
                    v-if="item.snippet"
                    class="item-snippet"
                >
                    {{ item.snippet }}
                </div>

                <div class="item-actions">
                    <ElButton
                        v-if="item.kind === 'node' && isRef(item) && item.canOpen"
                        native-type="button"
                        class="outline-action-btn"
                        :title="t('admin.canvas.source')"
                        :aria-label="t('admin.canvas.source')"
                        @click.stop="$emit('open-source', item.id)"
                    >
                        {{ t('admin.canvas.source') }}
                    </ElButton>
                    <ElButton
                        native-type="button"
                        class="outline-action-btn danger"
                        :title="t('common.actions.delete')"
                        :aria-label="t('common.actions.delete')"
                        @click.stop="$emit('delete-item', item)"
                    >
                        {{ t('common.actions.delete') }}
                    </ElButton>
                </div>
            </li>

            <li
                v-if="items.length === 0"
                class="outline-empty"
            >
                {{ t('admin.canvas.empty') }}
            </li>
        </ul>
    </section>
</template>

<script setup lang="ts">
import { ElButton, ElPagination } from '@ozwasyd/element-plus';
import { computed, nextTick, ref, watch } from 'vue';

import type { OutlineItem } from '@/composables/useAuthoringCanvas';
import { useI18nText } from '@/composables/useI18nText';
const props = defineProps<{
    items: OutlineItem[];
}>();
const pageSize = 100;
const page = ref(1);
const outlineRoot = ref<HTMLElement>();
const outlineList = ref<HTMLElement>();
const pageItems = computed(() => props.items.slice((page.value - 1) * pageSize, page.value * pageSize));
watch(() => [props.items[0]?.id, props.items.length, props.items.findIndex(item => item.selected)] as const,
      ([firstId, count, selectedIndex], previous) =>
      {
          if (selectedIndex >= 0)
          {
              page.value = Math.floor(selectedIndex / pageSize) + 1;
          }
          else if (previous && firstId !== previous[0])
          {
              page.value = 1;
          }
          else
          {
              page.value = Math.min(page.value, Math.max(1, Math.ceil(count / pageSize)));
          }
      }, { immediate: true });
watch([page, () => props.items], async ([currentPage], previous) =>
{
    const active = document.activeElement;
    const restoreRowFocus = active instanceof HTMLElement && active.closest('.outline-item')
        && outlineRoot.value?.contains(active);
    await nextTick();
    if (previous && currentPage !== previous[0] && outlineList.value)
    {
        outlineList.value.scrollTop = 0;
    }
    const selectedRow = outlineList.value?.querySelector<HTMLElement>('.outline-item.selected');
    if (restoreRowFocus)
    {
        const focusTarget = selectedRow ?? (!active.isConnected
            ? outlineList.value?.querySelector<HTMLElement>('.outline-item') : undefined);
        focusTarget?.focus({ preventScroll: true });
    }
    selectedRow?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
}, { immediate: true });
defineEmits<{
    (e: 'select-item', item: OutlineItem): void;
    (e: 'delete-item', item: OutlineItem): void;
    (e: 'open-source', nodeId: string): void;
}>();
function isRef(item: OutlineItem): boolean
{
    return item.type === 'article-reference' || item.type === 'heading-reference' || item.type === 'block-reference';
}
const { t } = useI18nText();
function statusLabel(status: string): string
{
    switch (status)
    {
        case 'current': return t('admin.canvas.current');
        case 'pinned-current': return t('admin.canvas.pinned');
        case 'target-updated':
        case 'pinned-stale':
        case 'source-stale': return t('admin.canvas.stale');
        case 'permission-denied': return t('admin.canvas.denied');
        case 'missing':
        case 'deleted':
        case 'archived':
        case 'heading-missing':
        case 'block-missing': return t('admin.canvas.missing');
        case 'resolving': return t('common.loading.status');
        default: return t('admin.canvas.unavailable');
    }
}
</script>



<style scoped>
.canvas-outline-view
 {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--el-bg-color-overlay);
    border-left: 1px solid var(--el-border-color);
    overflow: hidden;
    padding: var(--fsus-space-4);
    box-sizing: border-box;
}

.outline-header
 {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--fsus-space-3);
    padding-bottom: var(--fsus-space-2);
    border-bottom: 1px solid var(--el-border-color);
}

.outline-title
 {
    margin: 0;
    font-size: var(--el-font-size-base);
    font-weight: 600;
    color: var(--el-text-color-primary);
}

.outline-count
 {
    font-size: var(--el-font-size-base);
    color: var(--el-text-color-secondary);
}

.outline-list
 {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    scroll-behavior: auto;
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--fsus-space-2);
}

.outline-item
 {
    display: flex;
    flex-direction: column;
    gap: var(--fsus-space-1);
    padding: var(--fsus-space-3) var(--fsus-space-3);
    background: var(--el-fill-color-light);
    border: 1px solid var(--el-border-color);
    border-radius: var(--fsus-radius-panel);
    cursor: pointer;
    transition: background-color var(--fsus-motion-control) var(--fsus-motion-standard), border-color var(--fsus-motion-control) var(--fsus-motion-standard);
}

.outline-item:hover
 {
    background: var(--el-fill-color);
    border-color: var(--el-border-color);
}

.outline-item.selected
 {
    background: var(--el-color-primary-light-9);
    border-color: var(--fsus-scholarly-blue);
}

.item-main
 {
    display: flex;
    align-items: center;
    gap: var(--fsus-space-2);
}

.item-icon
 {
    font-size: var(--el-font-size-base);
}

.item-title
 {
    font-size: var(--el-font-size-base);
    font-weight: 500;
    color: var(--el-text-color-primary);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.item-status-chip
 {
    font-size: var(--el-font-size-base);
    padding: 0 var(--fsus-space-2);
    border-radius: var(--fsus-radius-pill);
    background: var(--el-border-color);
    color: var(--el-text-color-secondary);
    font-weight: 500;
}

.item-snippet
 {
    font-size: var(--el-font-size-base);
    color: var(--el-text-color-secondary);
    line-height: 1.3;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.item-actions
 {
    display: flex;
    align-items: center;
    gap: var(--fsus-space-2);
    margin-top: var(--fsus-space-1);
}



.outline-empty
 {
    font-size: var(--el-font-size-base);
    color: var(--el-border-color);
    text-align: center;
    padding: var(--fsus-space-8) var(--fsus-space-4);
}

@media (prefers-reduced-motion: reduce)
 {
    .outline-item
 {
        transition: none;
    }
}
</style>
