<template>
    <div
        class="comment-moderation-primary-filters"
        role="search"
        aria-label="评论审核筛选"
    >
        <FsusUiSegmentedControl
            :model-value="filters.status"
            :items="statusItems"
            class="comment-moderation-status-tabs"
            aria-label="评论审核状态筛选"
            @update:model-value="onStatusChange"
        />

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
import { computed } from 'vue';

import type { CommentModerationStatus } from '@/api/authoring';
import {
    commentModerationStatusOptions as statusOptions,
    type CommentModerationFilters
} from '@/composables/useCommentModerationQueue';
import { Search } from '@/fsusui/icons';
import { FsusUiSegmentedControl, type FsusUiSegmentedControlValue } from '@/fsusui/segmentedControl';

const props = defineProps<{
    filters: CommentModerationFilters;
    loading: boolean;
}>();
const emit = defineEmits<{
    search: [];
    'update:status': [value: CommentModerationStatus];
    'update:keyword': [value: string];
}>();

const statusItems = computed(() => statusOptions.map((option) => ({ ...option, disabled: props.loading })));

const onStatusChange = (value: FsusUiSegmentedControlValue): void =>
{
    const nextStatus = statusOptions.find((option) => option.value === value)?.value;
    if (nextStatus !== undefined && nextStatus !== props.filters.status)
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
}
</style>
