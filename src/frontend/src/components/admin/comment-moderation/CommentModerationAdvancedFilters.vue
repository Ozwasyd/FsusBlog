<template>
    <div>
        <button
            ref="triggerRef"
            type="button"
            class="comment-advanced-trigger"
            :aria-expanded="visible"
            aria-controls="comment-advanced-filter-panel"
            :disabled="loading"
            @click="visible = true"
        >
            高级筛选
            <span
                v-if="activeCount > 0"
                class="comment-advanced-trigger__count"
                :aria-label="`${activeCount} 个高级筛选已启用`"
            >{{ activeCount }}</span>
        </button>

        <ElDrawer
            v-model="visible"
            class="comment-advanced-drawer"
            title="高级筛选"
            size="min(100vw, 400px)"
            append-to-body
            @opened="focusPanel"
            @closed="restoreTriggerFocus"
        >
            <div
                id="comment-advanced-filter-panel"
                ref="panelRef"
                class="comment-advanced-panel"
                tabindex="-1"
            >
                <div class="comment-advanced-panel__fields">
                    <ElInput
                        :model-value="filters.article"
                        name="commentModerationArticle"
                        aria-label="按文章筛选评论"
                        placeholder="文章 ID / 标题"
                        clearable
                        :disabled="loading"
                        @update:model-value="emit('update:article', String($event))"
                    />
                    <ElInput
                        :model-value="filters.user"
                        name="commentModerationUser"
                        aria-label="按用户筛选评论"
                        placeholder="用户 ID / 昵称"
                        clearable
                        :disabled="loading"
                        @update:model-value="emit('update:user', String($event))"
                    />
                    <ElSelect
                        :model-value="filters.hitReason"
                        name="commentModerationHitReason"
                        aria-label="按命中原因筛选评论"
                        placeholder="命中原因"
                        clearable
                        :disabled="loading || hitReasonOptions.length === 0"
                        @update:model-value="emit('update:hitReason', String($event ?? ''))"
                    >
                        <ElOption
                            v-for="option in hitReasonOptions"
                            :key="option.value"
                            :label="option.label"
                            :value="option.value"
                        />
                    </ElSelect>
                    <ElSelect
                        :model-value="filters.blockedRegion"
                        name="commentModerationBlockedRegion"
                        aria-label="按屏蔽地区筛选评论"
                        placeholder="屏蔽地区"
                        clearable
                        :disabled="loading || blockedRegionOptions.length === 0"
                        @update:model-value="emit('update:blockedRegion', String($event ?? ''))"
                    >
                        <ElOption
                            v-for="option in blockedRegionOptions"
                            :key="option.value"
                            :label="option.label"
                            :value="option.value"
                        />
                    </ElSelect>
                    <ElSelect
                        :model-value="filters.modelLabel"
                        name="commentModerationModelLabel"
                        aria-label="按模型标签筛选评论"
                        placeholder="模型标签"
                        clearable
                        :disabled="loading || modelLabelOptions.length === 0"
                        @update:model-value="emit('update:modelLabel', String($event ?? ''))"
                    >
                        <ElOption
                            v-for="option in modelLabelOptions"
                            :key="option.value"
                            :label="option.label"
                            :value="option.value"
                        />
                    </ElSelect>
                    <ElSelect
                        :model-value="filters.modelProvider"
                        name="commentModerationModelRuntime"
                        aria-label="按模型运行时筛选评论"
                        placeholder="模型运行时"
                        clearable
                        :disabled="loading || modelRuntimeOptions.length === 0"
                        @update:model-value="emit('update:modelRuntime', String($event ?? ''))"
                    >
                        <ElOption
                            v-for="option in modelRuntimeOptions"
                            :key="option.value"
                            :label="option.label"
                            :value="option.value"
                        />
                    </ElSelect>
                    <ElDatePicker
                        :model-value="filters.dateRange ?? undefined"
                        type="daterange"
                        value-format="YYYY-MM-DD"
                        start-placeholder="开始日期"
                        end-placeholder="结束日期"
                        aria-label="按时间范围筛选评论"
                        :disabled="loading"
                        @update:model-value="onDateRangeChange"
                    />
                </div>

                <div
                    v-if="advancedFilters.length > 0"
                    class="comment-advanced-panel__active"
                    aria-label="已启用的高级筛选"
                >
                    <button
                        v-for="filter in advancedFilters"
                        :key="filter.key"
                        type="button"
                        class="comment-advanced-panel__active-item"
                        @click="emit('remove-filter', filter.key)"
                    >移除 {{ filter.label }}</button>
                </div>
            </div>

            <template #footer>
                <div class="comment-advanced-panel__footer">
                    <ElButton
                        class="comment-advanced-panel__footer-action"
                        :disabled="loading || activeCount === 0"
                        @click="emit('clear')"
                    >清除全部</ElButton>
                    <ElButton
                        class="comment-advanced-panel__footer-action"
                        type="primary"
                        :loading="loading"
                        @click="apply"
                    >查看结果</ElButton>
                </div>
            </template>
        </ElDrawer>
    </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';

import type {
    CommentModerationFilterKey,
    CommentModerationFilters
} from '@/composables/useCommentModerationQueue';

type FilterOption = Readonly<{ value: string; label: string; }>;
const advancedKeys = new Set<CommentModerationFilterKey>([
    'article',
    'user',
    'hitReason',
    'blockedRegion',
    'modelLabel',
    'modelProvider',
    'dateRange'
]);
const props = defineProps<{
    filters: CommentModerationFilters;
    loading: boolean;
    hitReasonOptions: readonly FilterOption[];
    blockedRegionOptions: readonly FilterOption[];
    modelLabelOptions: readonly FilterOption[];
    modelRuntimeOptions: readonly FilterOption[];
    activeFilters: readonly Readonly<{ key: CommentModerationFilterKey; label: string; }>[];
}>();
const emit = defineEmits<{
    apply: [];
    clear: [];
    'remove-filter': [key: CommentModerationFilterKey];
    'update:article': [value: string];
    'update:user': [value: string];
    'update:hitReason': [value: string];
    'update:blockedRegion': [value: string];
    'update:modelLabel': [value: string];
    'update:modelRuntime': [value: string];
    'update:dateRange': [value: [string, string] | null];
}>();
const visible = ref(false);
const triggerRef = ref<HTMLButtonElement | null>(null);
const panelRef = ref<HTMLElement | null>(null);
const advancedFilters = computed(() => props.activeFilters.filter(({ key }) => advancedKeys.has(key)));
const activeCount = computed(() => advancedFilters.value.length);

function onDateRangeChange(value: unknown): void
{
    const range = Array.isArray(value)
        && value.length === 2
        && typeof value[0] === 'string'
        && typeof value[1] === 'string'
        ? [value[0], value[1]] as [string, string]
        : null;
    emit('update:dateRange', range);
}

function focusPanel(): void
{
    void nextTick(() => panelRef.value?.focus());
}

function restoreTriggerFocus(): void
{
    triggerRef.value?.focus();
}

function apply(): void
{
    emit('apply');
    visible.value = false;
}
</script>

<style scoped>
.comment-advanced-trigger
 {
    display: inline-flex;
    min-height: 44px;
    align-items: center;
    justify-content: center;
    gap: var(--fsus-space-2);
    padding-inline: var(--fsus-space-4);
    border: 1px solid var(--fsusblog-panel-border);
    border-radius: var(--fsus-radius-control);
    background: var(--fsusblog-page-bg);
    color: var(--fsusblog-text-secondary);
    cursor: pointer;
    font: inherit;
    font-size: 14px;
    font-weight: 700;
}

.comment-advanced-trigger:focus-visible
 {
    box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);
    outline: none;
}

.comment-advanced-trigger__count
 {
    min-width: 20px;
    padding-inline: var(--fsus-space-1);
    border-radius: var(--fsus-radius-control-small);
    background: var(--fsusblog-text-primary);
    color: var(--fsusblog-page-bg);
    font-size: 12px;
    line-height: 20px;
    text-align: center;
}

.comment-advanced-panel:focus
 {
    outline: none;
}

.comment-advanced-panel__fields
 {
    display: grid;
    gap: var(--fsus-space-4);
}

.comment-advanced-panel__active
 {
    display: grid;
    gap: var(--fsus-space-2);
    margin-top: var(--fsus-space-5);
    padding-top: var(--fsus-space-4);
    border-top: 1px solid var(--fsusblog-panel-border);
}

.comment-advanced-panel__active-item
 {
    min-height: 40px;
    padding: var(--fsus-space-2) var(--fsus-space-3);
    border: 0;
    background: transparent;
    color: var(--fsusblog-text-secondary);
    cursor: pointer;
    text-align: left;
}

.comment-advanced-panel__footer
 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--fsus-space-2);
}

.comment-advanced-panel__footer-action
 {
    min-height: 44px;
}
</style>
