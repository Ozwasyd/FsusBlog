<template>
    <article
        class="article-compact-card"
        role="listitem"
    >
        <div class="flex min-w-0 items-start gap-3">
            <div
                v-if="row.coverImageUrl"
                class="article-compact-cover"
                aria-hidden="true"
            >
                <img
                    :src="row.coverImageUrl"
                    alt=""
                    loading="lazy"
                >
            </div>
            <div class="min-w-0">
                <ElLink
                    type="primary"
                    class="article-compact-title"
                    @click="$emit('edit', row.id)"
                >
                    {{ row.title }}
                </ElLink>
                <div class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-[var(--fsusblog-text-muted)]">
                    <span class="inline-flex items-center gap-1 tabular-nums">
                        <ElIcon aria-hidden="true"><View /></ElIcon> {{ row.views }} 阅读
                    </span>
                    <span class="inline-flex items-center gap-1 tabular-nums">
                        {{ row.statusTimeLabel }}
                        <SemanticTime
                            :value="row.statusTimeValue"
                            :text="row.statusTimeText"
                        />
                    </span>
                </div>
            </div>
        </div>

        <div class="article-compact-tags">
            <ElTag
                size="small"
                class="article-compact-tag"
            >
                <span class="article-compact-tag-text">{{ row.categoryName }}</span>
            </ElTag>
            <ElTag
                size="small"
                :type="row.statusTagType"
                class="article-compact-tag"
            >
                {{ row.statusText }}
            </ElTag>
        </div>

        <div class="article-compact-actions">
            <ElButton
                text
                type="primary"
                @click="$emit('edit', row.id)"
            >{{ row.primaryActionLabel }}</ElButton>
            <ElDropdown>
                <ElButton
                    text
                    type="primary"
                >
                    更多 <span class="ml-1 inline-flex"><ElIcon aria-hidden="true"><ArrowDown /></ElIcon></span>
                </ElButton>
                <template #dropdown>
                    <ElDropdownMenu>
                        <ElDropdownItem
                            icon="Monitor"
                            @click="$emit('view', row)"
                        >{{ row.previewActionLabel }}</ElDropdownItem>
                        <ElDropdownItem
                            icon="Box"
                            @click="$emit('move-to-trash', row)"
                        >移入回收站</ElDropdownItem>
                    </ElDropdownMenu>
                </template>
            </ElDropdown>
        </div>
    </article>
</template>

<script setup lang="ts">
import { type ArticleListItemResponse } from '@/api/article';
import SemanticTime from '@/components/ui/SemanticTime.vue';
import { ArrowDown, View } from '@/fsusui/icons';

export type AdminArticleCompactCardRow = ArticleListItemResponse & {
    createdAtText: string;
    categoryName: string;
    statusText: string;
    statusTagType: 'success' | 'warning' | 'info' | 'danger';
    statusTimeLabel: string;
    statusTimeText: string;
    statusTimeValue: string;
    primaryActionLabel: string;
    previewActionLabel: string;
    publicPreviewAvailable: boolean;
};

defineProps<{
    row: AdminArticleCompactCardRow;
}>();

defineEmits<{
    (event: 'edit', id: number): void;
    (event: 'view', row: AdminArticleCompactCardRow): void;
    (event: 'move-to-trash', row: AdminArticleCompactCardRow): void;
}>();
</script>

<style scoped>
.article-compact-card
 {
    display: grid;
    gap: var(--fsus-space-4);
    padding: var(--fsus-space-5) var(--fsus-space-4);
    background: var(--fsusblog-page-bg);
}

.article-compact-title
 {
    max-width: 100%;
    min-width: 0;
    overflow-wrap: anywhere;
    text-align: left;
}

.article-compact-tags,
.article-compact-actions
 {
    display: flex;
    min-width: 0;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fsus-space-2);
}

.article-compact-cover
 {
    display: grid;
    width: 4.5rem;
    height: 3.375rem;
    flex: 0 0 auto;
    place-items: center;
    overflow: hidden;
    border: 1px solid var(--fsusblog-panel-border);
    border-radius: var(--fsus-radius-control);
    background: var(--fsusblog-panel-bg);
    color: var(--fsusblog-text-muted);
    font-weight: 700;
}

.article-compact-cover img
 {
    width: 100%;
    height: 100%;
    object-fit: cover;
}

.article-compact-tag
 {
    max-width: 100%;
}

.article-compact-tag-text
 {
    display: inline-block;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: middle;
}

.article-compact-actions
 {
    justify-content: flex-end;
}

.tabular-nums
 {
    font-variant-numeric: tabular-nums;
}
</style>
