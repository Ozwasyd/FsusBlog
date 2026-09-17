<template>
    <div
        class="comment-moderation-primary-filters"
        role="search"
        aria-label="评论审核筛选"
    >
        <div
            class="comment-moderation-status-tabs"
            role="radiogroup"
            aria-label="评论审核状态筛选"
        >
            <button
                v-for="option in statusOptions"
                :key="option.value"
                type="button"
                class="comment-moderation-status-tabs__item"
                :class="{ 'is-active': filters.status === option.value }"
                role="radio"
                :aria-checked="filters.status === option.value"
                :disabled="loading"
                @click="onStatusChange(option.value)"
            >
                {{ option.label }}
            </button>
        </div>

        <ElInput
            :model-value="filters.keyword"
            class="comment-moderation-primary-search"
            name="commentModerationKeyword"
            aria-label="搜索评论内容"
            placeholder="搜索内容、原因或 ID"
            clearable
            :disabled="loading"
            @update:model-value="emit('update:keyword', String($event))"
            @clear="emit('search')"
            @keyup.enter="emit('search')"
        >
            <template #prefix>
                <span class="text-[var(--fsusblog-text-muted)]"><ElIcon aria-hidden="true"><Search /></ElIcon></span>
            </template>
        </ElInput>

    </div>
</template>

<script setup lang="ts">
import type { CommentModerationStatus } from '@/api/authoring';
import {
    commentModerationStatusOptions as statusOptions,
    type CommentModerationFilters
} from '@/composables/useCommentModerationQueue';
import { Search } from '@/fsusui/icons';

const props = defineProps<{
    filters: CommentModerationFilters;
    loading: boolean;
}>();
const emit = defineEmits<{
    search: [];
    'update:status': [value: CommentModerationStatus];
    'update:keyword': [value: string];
}>();

const onStatusChange = (value: string | number | boolean): void =>
{
    const nextStatus = Number(value) as CommentModerationStatus;
    if (nextStatus !== props.filters.status)
    {
        emit('update:status', nextStatus);
    }
};
</script>

<style scoped>
.comment-moderation-primary-filters
 {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: var(--fsus-space-3);
}

.comment-moderation-primary-search
 {
    width: clamp(17.5rem, 28vw, 22.5rem);
    min-height: 44px;
}

.comment-moderation-status-tabs
 {
    display: inline-flex;
    min-height: 40px;
    align-items: center;
    overflow: hidden;
    border: 1px solid var(--fsusblog-panel-border);
    border-radius: var(--fsus-radius-control);
    background: var(--fsusblog-surface-bg);
}

.comment-moderation-status-tabs__item
 {
    min-height: 40px;
    padding: 0 var(--fsus-space-4);
    border: 0;
    border-right: 1px solid var(--fsusblog-panel-border);
    background: transparent;
    color: var(--fsusblog-text-muted);
    cursor: pointer;
    font: inherit;
    font-size: 14px;
    font-weight: 700;
}

.comment-moderation-status-tabs__item:last-child
 {
    border-right: 0;
}

.comment-moderation-status-tabs__item.is-active
 {
    background: var(--fsusblog-page-bg);
    box-shadow: inset 0 -2px 0 var(--fsusblog-color-primary);
    color: var(--fsusblog-text-primary);
}

.comment-moderation-status-tabs__item:focus-visible
 {
    box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);
    outline: none;
}

.comment-moderation-status-tabs__item:disabled
 {
    cursor: not-allowed;
    opacity: 0.55;
}

@media (width <= 767px)
 {
    .comment-moderation-primary-filters
 {
        align-items: stretch;
        flex-direction: column;
        gap: var(--fsus-space-2);
    }

    .comment-moderation-primary-search,
    .comment-moderation-status-tabs
 {
        width: 100%;
    }

    .comment-moderation-status-tabs__item
 {
        flex: 1 1 auto;
        padding-inline: var(--fsus-space-2);
    }
}
</style>
