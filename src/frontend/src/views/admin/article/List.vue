<template>
    <div class="account-page article-list-wrapper account-motion-enter w-full">
        <FsusUiTaskPageHeader
            title="文章管理"
            class="account-task-page-header"
            density="compact"
        />

        <CollectionWorkbench
            title="文章列表"
            title-id="article-list-title"
            :meta="articleListResultText"
            :state="articleWorkbenchState"
            :busy="isBusy"
        >
            <template #primary-filter>
                <ElForm
                    class="article-list-toolbar-form"
                    :model="queryParam"
                    @submit.prevent="handleSearch"
                >
                    <ElFormItem class="article-list-toolbar-item !m-0">
                        <div class="article-list-toolbar-search">
                            <ElInput
                                v-model="queryParam.keyword"
                                name="articleKeyword"
                                aria-label="搜索文章标题"
                                placeholder="搜索文章标题"
                                clearable
                                :disabled="isBusy"
                                @clear="handleSearch"
                                @keyup.enter="handleSearch"
                            >
                                <template #prefix>
                                    <span class="text-[var(--fsusblog-text-muted)]">
                                        <ElIcon aria-hidden="true"><Search /></ElIcon>
                                    </span>
                                </template>
                            </ElInput>
                        </div>
                    </ElFormItem>

                    <ElFormItem class="article-list-toolbar-item !m-0">
                        <div class="article-list-toolbar-select">
                            <ElSelect
                                v-model="queryParam.categoryId"
                                clearable
                                filterable
                                placeholder="按分类筛选"
                                aria-label="按分类筛选文章"
                                :disabled="isBusy"
                                @update:model-value="handleCategoryFilterChange"
                            >
                                <ElOption
                                    v-for="item in categories"
                                    :key="item.id"
                                    :label="item.name"
                                    :value="item.id"
                                />
                            </ElSelect>
                        </div>
                    </ElFormItem>

                    <ElFormItem class="article-list-toolbar-item !m-0">
                        <div class="article-list-toolbar-select">
                            <ElSelect
                                v-model="queryParam.tagId"
                                clearable
                                filterable
                                placeholder="按标签筛选"
                                aria-label="按标签筛选文章"
                                :disabled="isBusy"
                                @update:model-value="handleTagFilterChange"
                            >
                                <ElOption
                                    v-for="item in tags"
                                    :key="item.id"
                                    :label="`# ${item.name}`"
                                    :value="item.id"
                                />
                            </ElSelect>
                        </div>
                    </ElFormItem>

                    <ElFormItem class="article-list-toolbar-item article-list-status-filter !m-0">
                        <FsusUiSegmentedControl
                            :model-value="selectedStatusFilter"
                            :items="segmentedStatusFilters"
                            aria-label="文章状态筛选"
                            @update:model-value="handleStatusFilterChange"
                        />
                    </ElFormItem>

                    <ElFormItem class="article-list-toolbar-item article-list-toolbar-buttons !m-0">
                        <DocumentExportHost
                            :articles="articleListView"
                            :disabled="isBusy"
                        />
                        <ElButton
                            type="primary"
                            :loading="isBusy"
                            @click="handleSearch"
                        >搜索</ElButton>
                        <ElButton
                            @click="resetQuery"
                            :disabled="isBusy"
                        >重置</ElButton>
                        <ElButton
                            class="article-list-write-button"
                            type="primary"
                            :icon="Plus"
                            @click="goToWriteArticle"
                        >
                            写新文章
                        </ElButton>
                    </ElFormItem>
                </ElForm>

                <div
                    v-if="activeFilterChips.length > 0"
                    class="mt-2 flex flex-wrap items-center gap-2"
                    aria-label="当前筛选条件"
                >
                    <ElTag
                        v-for="chip in activeFilterChips"
                        :key="chip.key"
                        closable
                        type="info"
                        @close="removeFilter(chip.key)"
                    >
                        {{ chip.label }}
                    </ElTag>
                </div>
            </template>

            <template #loading>
                <div
                    class="px-4 py-6"
                    aria-busy="true"
                ><ElSkeleton
                    :rows="6"
                    animated
                /></div>
            </template>

            <template #results>
                <p
                    v-if="rowMotion.summary.value"
                    class="sr-only blog-motion-summary-enter"
                    role="status"
                    aria-live="polite"
                >
                    {{ rowMotion.summary.value }}
                </p>
                <ElResponsiveCollection
                    v-loading="loading"
                    :items="articleListView"
                    :row-key="getArticleRowKey"
                    compact-query="(max-width: 767px)"
                    aria-label="文章列表"
                >
                    <template #card="{ item }">
                        <AdminArticleCompactCard
                            :row="item as ArticleListViewItem"
                            :class="articleRowMotionClass((item as ArticleListViewItem).id)"
                            @edit="handleEdit"
                            @view="handleViewArticle"
                            @move-to-trash="handleMoveToTrash"
                        />
                    </template>

                    <template #table>
                        <ElTable
                            class="article-list-table"
                            :data="articleListView"
                            :row-key="getArticleRowKey"
                            :row-class-name="articleTableRowClassName"
                        >
                            <ElTableColumn
                                prop="id"
                                label="ID"
                                width="96"
                                align="center"
                            >
                                <template #default="{ row }: { row: ArticleListViewItem }">
                                    <span class="article-id-cell tabular-nums">{{ row.id }}</span>
                                </template>
                            </ElTableColumn>

                            <ElTableColumn
                                label="内容概要"
                                min-width="320"
                            >
                                <template #default="{ row }: { row: ArticleListViewItem }">
                                    <div class="flex min-w-0 items-start gap-4 py-1">
                                        <div
                                            v-if="row.coverImageUrl"
                                            class="article-cover-thumb"
                                            aria-hidden="true"
                                        >
                                            <img
                                                :src="row.coverImageUrl"
                                                alt=""
                                                loading="lazy"
                                            >
                                        </div>
                                        <div class="min-w-0 flex-1">
                                            <ElLink
                                                type="primary"
                                                @click="handleEdit(row.id)"
                                            >
                                                {{ row.title }}
                                            </ElLink>
                                            <div class="flex flex-wrap items-center gap-x-6 gap-y-2 mt-2 text-[12px] text-[var(--fsusblog-text-muted)]">
                                                <span class="flex items-center gap-1 tabular-nums">
                                                    <ElIcon aria-hidden="true"><View /></ElIcon> {{ row.views }} 阅读
                                                </span>
                                                <span class="flex items-center gap-1 tabular-nums">
                                                    <ElIcon aria-hidden="true"><Calendar /></ElIcon>
                                                    <span>{{ row.statusTimeLabel }}</span>
                                                    <SemanticTime
                                                        :value="row.statusTimeValue"
                                                        :text="row.statusTimeText"
                                                    />
                                                </span>
                                            </div>
                                        </div>
                                    </div>
                                </template>
                            </ElTableColumn>

                            <ElTableColumn
                                label="分类"
                                width="130"
                                align="center"
                            >
                                <template #default="{ row }: { row: ArticleListViewItem }">
                                    <ElTag size="small">
                                        {{ row.categoryName }}
                                    </ElTag>
                                </template>
                            </ElTableColumn>

                            <ElTableColumn
                                label="状态"
                                width="100"
                                align="center"
                            >
                                <template #default="{ row }: { row: ArticleListViewItem }">
                                    <ElTag
                                        size="small"
                                        :type="row.statusTagType"
                                    >
                                        {{ row.statusText }}
                                    </ElTag>
                                </template>
                            </ElTableColumn>

                            <ElTableColumn
                                label="标签"
                                min-width="180"
                            >
                                <template #default="{ row }: { row: ArticleListViewItem }">
                                    <div class="flex flex-wrap gap-2">
                                        <ElTag
                                            v-for="tag in row.tags"
                                            :key="tag.id"
                                            size="small"
                                            type="info"
                                        >
                                            {{ tag.name }}
                                        </ElTag>
                                    </div>
                                </template>
                            </ElTableColumn>

                            <ElTableColumn
                                label="管理"
                                width="160"
                                fixed="right"
                                align="right"
                            >
                                <template #default="{ row }: { row: ArticleListViewItem }">
                                    <div class="flex justify-end items-center gap-x-1 pr-2">
                                        <ElButton
                                            link
                                            type="primary"
                                            @click="handleEdit(row.id)"
                                        >{{ row.primaryActionLabel }}</ElButton>
                                        <ElDropdown>
                                            <ElButton
                                                link
                                                type="primary"
                                            >
                                                更多 <span class="ml-1 inline-flex"><ElIcon aria-hidden="true"><ArrowDown /></ElIcon></span>
                                            </ElButton>
                                            <template #dropdown>
                                                <ElDropdownMenu>
                                                    <ElDropdownItem
                                                        icon="Monitor"
                                                        @click="handleViewArticle(row)"
                                                    >{{ row.previewActionLabel }}</ElDropdownItem>
                                                    <ElDropdownItem
                                                        icon="Box"
                                                        @click="handleMoveToTrash(row)"
                                                    >移入回收站</ElDropdownItem>
                                                </ElDropdownMenu>
                                            </template>
                                        </ElDropdown>
                                    </div>
                                </template>
                            </ElTableColumn>
                        </ElTable>
                    </template>
                </ElResponsiveCollection>
            </template>

            <template #empty>
                <div
                    v-loading="loading"
                    class="article-list-empty-container"
                >
                    <AdminInlineEmptyState
                        class="article-list-empty-state"
                        title="没有找到匹配的文章"
                        description="调整筛选条件或新建文章。"
                    >
                        <template #actions>
                            <div class="article-list-empty-actions">
                                <ElButton
                                    class="article-list-empty-action"
                                    :disabled="isBusy"
                                    @click="resetQuery"
                                >清空筛选</ElButton>
                                <ElButton
                                    class="article-list-empty-action"
                                    type="primary"
                                    @click="goToWriteArticle"
                                >写新文章</ElButton>
                            </div>
                        </template>
                    </AdminInlineEmptyState>
                </div>
            </template>

            <template
                v-if="total > 0"
                #pagination
            >
                <div class="article-list-pagination flex w-full items-center justify-between">
                    <span class="text-[12px] text-[var(--fsusblog-text-muted)] font-medium tabular-nums">
                        {{ totalText }}
                    </span>
                    <ElPagination
                        v-model:current-page="queryParam.page"
                        v-model:page-size="queryParam.size"
                        :page-sizes="pageSizeOptions"
                        :layout="isCompactPagination ? 'prev, pager, next' : 'sizes, prev, pager, next'"
                        :total="total"
                        :disabled="isBusy"
                        @size-change="handlePageSizeChange"
                        @current-change="handlePageChange"
                    />
                </div>
            </template>
        </CollectionWorkbench>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import { ArticlePublishStatus, type ArticleListItemResponse } from '@/api/article';
import AdminInlineEmptyState from '@/components/admin/AdminInlineEmptyState.vue';
import AdminArticleCompactCard from '@/components/admin/article/AdminArticleCompactCard.vue';
import CollectionWorkbench from '@/components/admin/CollectionWorkbench.vue';
import SemanticTime from '@/components/ui/SemanticTime.vue';
import { useAdminArticleList } from '@/composables/useAdminArticleList';
import { useMediaQuery } from '@/composables/useMediaQuery';
import { FsusUiTaskPageHeader } from '@/fsusui';
import { Search, View, Calendar, Plus, ArrowDown } from '@/fsusui/icons';
import {
    FsusUiSegmentedControl,
    type FsusUiSegmentedControlItem,
    type FsusUiSegmentedControlValue
} from '@/fsusui/segmentedControl';

import DocumentExportHost from './DocumentExportHost.vue';

const ALL_ARTICLES = 'all' as const satisfies FsusUiSegmentedControlValue;

type ArticleListViewItem = ArticleListItemResponse & {
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
const {
    router,
    loading,
    isBusy,
    articleListView,
    categories,
    tags,
    total,
    totalText,
    pageSizeOptions,
    statusFilters,
    activeFilterChips,
    rowMotion,
    queryParam,
    setStatusFilter,
    setCategoryFilter,
    setTagFilter,
    removeFilter,
    handlePageSizeChange,
    handlePageChange,
    handleSearch,
    resetQuery,
    handleEdit,
    handleMoreCommand
} = useAdminArticleList();

const getArticleRowKey = (row: unknown): string => String((row as ArticleListViewItem).id);
const articleRowMotionClass = (id: number): string => rowMotion.classFor(id);
const articleTableRowClassName = ({ row }: { row: ArticleListViewItem; }): string => articleRowMotionClass(row.id);
const isCompactPagination = useMediaQuery('(max-width: 767px)');
const articleListResultText = computed(() => `文章列表 · ${total.value} 条结果`);
const hasArticleRows = computed(() => articleListView.value.length > 0);
const articleWorkbenchState = computed(() => loading.value && !hasArticleRows.value
    ? 'loading'
    : hasArticleRows.value
        ? 'ready'
        : 'empty');
const selectedStatusFilter = computed<FsusUiSegmentedControlValue>(
    () => queryParam.status ?? ALL_ARTICLES
);
const segmentedStatusFilters = computed<FsusUiSegmentedControlItem[]>(() =>
    statusFilters.map((item) => ({
        label: item.label,
        value: item.value ?? ALL_ARTICLES,
        disabled: isBusy.value
    }))
);
const toArticleStatusFilter = (
    value: FsusUiSegmentedControlValue
): ArticlePublishStatus | undefined =>
{
    switch (value)
    {
        case ArticlePublishStatus.Draft:
        case ArticlePublishStatus.Scheduled:
        case ArticlePublishStatus.Published:
        case ArticlePublishStatus.Archived:
            return value;
        default:
            return undefined;
    }
};
const handleStatusFilterChange = (value: FsusUiSegmentedControlValue): void =>
{
    setStatusFilter(toArticleStatusFilter(value));
};
const normalizeFilterId = (value: string | number | undefined): number | undefined =>
{
    if (typeof value === 'number' && Number.isFinite(value) && value > 0)
    {
        return value;
    }
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};
const handleCategoryFilterChange = (value: string | number | undefined): void =>
{
    setCategoryFilter(normalizeFilterId(value));
};
const handleTagFilterChange = (value: string | number | undefined): void =>
{
    setTagFilter(normalizeFilterId(value));
};
const goToWriteArticle = async (): Promise<void> =>
{
    await router.push({ path: '/user/manage/article/write' });
};
const handleViewArticle = (row: ArticleListViewItem): void => handleMoreCommand('view', row);
const handleMoveToTrash = (row: ArticleListViewItem): void => handleMoreCommand('delete', row);
</script>

<style scoped>

.article-list-toolbar-form
 {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: var(--fsus-space-3);
    width: 100%;
}

.article-list-toolbar-search
 {
    width: min(100%, 16rem);
}

.article-list-toolbar-select
 {
    width: min(100%, 13rem);
}

.article-list-status-filter
 {
    min-width: 17rem;
}

.article-list-toolbar-buttons
 {
    flex: 1 1 18rem;
    min-height: 2rem;
}

.article-list-toolbar-buttons > *
 {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fsus-space-3);
    width: 100%;
}

.article-list-toolbar-buttons > * + *
 {
    margin-left: 0;
}

.article-list-toolbar-buttons > button,
.article-list-toolbar-buttons > *
 {
    min-height: 3rem;
}

.article-list-write-button
 {
    margin-left: auto;
}

.tabular-nums
 {
    font-variant-numeric: tabular-nums;
}

.article-id-cell
 {
    display: inline-block;
    white-space: nowrap;
    word-break: keep-all;
}



.article-cover-thumb
 {
    display: grid;
    width: 4rem;
    height: 2.25rem;
    flex: 0 0 auto;
    place-items: center;
    overflow: hidden;
    border: 1px solid var(--fsusblog-panel-border);
    border-radius: var(--fsus-radius-control);
    background: var(--fsusblog-panel-bg);
    color: var(--fsusblog-text-muted);
    font-size: 1rem;
    font-weight: 700;
}

.article-cover-thumb img
 {
    width: 100%;
    height: 100%;
    object-fit: cover;
}

.article-list-empty-container
 {
    min-height: 10rem;
    border-top: 1px solid var(--fsusblog-panel-border);
    padding-block: var(--fsus-space-5) var(--fsus-space-6);
}

.article-list-empty-state
 {
    min-height: 7rem;
}

.article-list-empty-actions
 {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fsus-space-3);
    margin-top: var(--fsus-space-3);
}

.article-list-empty-action
 {
    min-width: 6.5rem;
}

@media (width <= 639px)
 {
    .article-list-empty-actions
 {
        gap: var(--fsus-space-2);
    }

    .article-list-empty-action
 {
        min-width: 6rem;
    }
}

@media (width <= 639px)
 {
    .article-list-toolbar-form,
    .article-list-toolbar-item,
    .article-list-toolbar-search,
    .article-list-toolbar-select,
    .article-list-status-filter
 {
        width: 100%;
    }

    .article-list-status-filter
 {
        min-width: 0;
    }

    .article-list-toolbar-buttons
 {
        flex: 1 1 100%;
    }

    .article-list-write-button
 {
        margin-left: 0;
    }

    .article-list-pagination
 {
        align-items: flex-start;
        flex-direction: column;
        gap: var(--fsus-space-4);
    }
}
</style>
