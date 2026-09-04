<template>
    <div class="account-page asset-library-page account-motion-enter w-full">
        <FsusUiTaskPageHeader
            title="资产库"
            class="account-task-page-header"
        />

        <FsusUiSettingsSection
            class="mb-12"
            title="资产库存"
            description="资产库独立承载列表、文章引用重建、孤儿资产清理和物理删除。"
            id="asset-library-title"
        >
            <template #title>
                资产库存
                <span class="text-[var(--fsusblog-text-primary)] tabular-nums">{{ assets.length }}</span>
            </template>
            <template #actions>
                <div class="flex flex-wrap items-center justify-end gap-2">
                    <ElButton
                        :icon="Refresh"
                        :loading="loading"
                        @click="loadAssets"
                    >刷新</ElButton>
                    <ElButton
                        type="danger"
                        :icon="Delete"
                        :loading="processing"
                        @click="confirmCleanupOrphans"
                    >清理孤儿资产</ElButton>
                </div>
            </template>
        </FsusUiSettingsSection>

        <section class="admin-data-surface">
            <div class="admin-data-surface__toolbar admin-data-surface__toolbar--stacked">
                <div class="admin-data-surface__toolbar-row">
                    <div class="text-[11px] font-bold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">资产列表</div>
                    <div class="flex flex-wrap items-center gap-2">
                        <ElInput
                            v-model="keyword"
                            class="asset-filter-input"
                            clearable
                            placeholder="搜索 URL / SHA"
                            aria-label="搜索资产"
                            :prefix-icon="Search"
                        />
                        <ElCheckbox v-model="orphanOnly">仅孤儿资产</ElCheckbox>
                    </div>
                </div>

                <ElForm
                    class="admin-data-surface__action-row asset-reindex-form"
                    inline
                    @submit.prevent="reindexCurrentArticle"
                >
                    <ElFormItem
                        class="asset-reindex-form__item"
                        label="文章 ID"
                    >
                        <ElInput
                            v-model="reindexArticleId"
                            class="article-id-input"
                            placeholder="输入文章 ID"
                        />
                    </ElFormItem>
                    <ElFormItem class="asset-reindex-form__item">
                        <ElButton
                            type="primary"
                            :icon="Refresh"
                            :loading="processing"
                            @click="reindexCurrentArticle"
                        >
                            重建文章引用
                        </ElButton>
                    </ElFormItem>
                </ElForm>
            </div>

            <div
                v-if="isAssetInitialLoading"
                class="px-4 py-6"
                aria-busy="true"
            >
                <ElSkeleton
                    :rows="6"
                    animated
                />
            </div>

            <ElResponsiveCollection
                v-else
                v-loading="loading"
                :items="sortedFilteredAssets"
                row-key="id"
                compact-query="(max-width: 767px)"
                aria-label="资产列表"
            >
                <template #card="{ item }">
                    <article
                        class="border-b border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)] px-4 py-5"
                        role="listitem"
                    >
                        <div class="flex flex-wrap items-start justify-between gap-3">
                            <div class="min-w-0">
                                <div class="text-[11px] font-bold tabular-nums text-[var(--fsusblog-text-muted)]">
                                    #{{ (item as AssetLibraryItemResponse).id }}
                                </div>
                                <a
                                    class="asset-url mt-2"
                                    :href="(item as AssetLibraryItemResponse).url"
                                    target="_blank"
                                    rel="noreferrer"
                                >
                                    {{ (item as AssetLibraryItemResponse).url }}
                                </a>
                                <p class="mt-2 break-all text-[11px] text-[var(--fsusblog-text-muted)]">
                                    {{ (item as AssetLibraryItemResponse).sha256 || '无 SHA256' }}
                                </p>
                            </div>
                            <ElTag :type="(item as AssetLibraryItemResponse).referenceCount > 0 ? 'success' : 'warning'">
                                引用 {{ (item as AssetLibraryItemResponse).referenceCount }}
                            </ElTag>
                        </div>

                        <dl class="mt-4 grid gap-3 text-xs sm:grid-cols-2">
                            <div>
                                <dt class="font-bold text-[var(--fsusblog-text-muted)]">来源文章</dt>
                                <dd class="mt-1 tabular-nums text-[var(--fsusblog-text-primary)]">
                                    {{ (item as AssetLibraryItemResponse).sourceArticleId ?? '-' }}
                                </dd>
                            </div>
                            <div>
                                <dt class="font-bold text-[var(--fsusblog-text-muted)]">更新时间</dt>
                                <dd class="mt-1 text-[var(--fsusblog-text-primary)]">
                                    <time :datetime="(item as AssetLibraryItemResponse).updatedAt">
                                        {{ formatTime((item as AssetLibraryItemResponse).updatedAt) }}
                                    </time>
                                </dd>
                            </div>
                        </dl>

                        <div class="mt-4 flex justify-end">
                            <ElButton
                                type="danger"
                                :disabled="processing"
                                @click="confirmDeleteAsset(item as AssetLibraryItemResponse)"
                            >
                                删除文件
                            </ElButton>
                        </div>
                    </article>
                </template>

                <template #empty>
                    <AdminInlineEmptyState
                        :title="assetEmptyTitle"
                        :content="assetEmptyDescription"
                    >
                        <template #actions>
                            <ElButton
                                v-if="hasAssetFilters"
                                link
                                type="primary"
                                @click="resetAssetFilters"
                            >清除筛选</ElButton>
                            <ElButton
                                v-else
                                link
                                type="primary"
                                :loading="loading"
                                @click="loadAssets"
                            >刷新资产库</ElButton>
                        </template>
                    </AdminInlineEmptyState>
                </template>

                <template #table>
                    <div class="asset-table-v2-frame">
                        <ElAutoResizer>
                            <template #default="{ height, width }">
                                <ElTableV2
                                    :columns="assetTableColumns"
                                    :data="sortedFilteredAssets"
                                    :width="width"
                                    :height="height"
                                    :row-height="72"
                                    row-key="id"
                                    :sort-state="assetSortState"
                                    @column-sort="handleAssetColumnSort"
                                >
                                    <template #cell="{ rowData, column }">
                                        <span
                                            v-if="column.key === 'id'"
                                            class="tabular-nums"
                                        >
                                            {{ (rowData as AssetLibraryItemResponse).id }}
                                        </span>

                                        <div
                                            v-else-if="column.key === 'file'"
                                            class="min-w-0"
                                        >
                                            <a
                                                class="asset-url"
                                                :href="(rowData as AssetLibraryItemResponse).url"
                                                target="_blank"
                                                rel="noreferrer"
                                            >
                                                {{ (rowData as AssetLibraryItemResponse).url }}
                                            </a>
                                            <p class="mt-1 text-[11px] text-[var(--fsusblog-text-muted)]">
                                                {{ (rowData as AssetLibraryItemResponse).sha256 || '无 SHA256' }}
                                            </p>
                                        </div>

                                        <ElTag
                                            v-else-if="column.key === 'referenceCount'"
                                            :type="(rowData as AssetLibraryItemResponse).referenceCount > 0 ? 'success' : 'warning'"
                                        >
                                            {{ (rowData as AssetLibraryItemResponse).referenceCount }}
                                        </ElTag>

                                        <span
                                            v-else-if="column.key === 'sourceArticleId'"
                                            class="tabular-nums"
                                        >
                                            {{ (rowData as AssetLibraryItemResponse).sourceArticleId ?? '-' }}
                                        </span>

                                        <time
                                            v-else-if="column.key === 'updatedAt'"
                                            :datetime="(rowData as AssetLibraryItemResponse).updatedAt"
                                        >
                                            {{ formatTime((rowData as AssetLibraryItemResponse).updatedAt) }}
                                        </time>

                                        <ElButton
                                            v-else-if="column.key === 'actions'"
                                            link
                                            type="danger"
                                            :disabled="processing"
                                            @click="confirmDeleteAsset(rowData as AssetLibraryItemResponse)"
                                        >
                                            删除文件
                                        </ElButton>
                                    </template>

                                    <template #empty>
                                        <AdminInlineEmptyState
                                            :title="assetEmptyTitle"
                                            :content="assetEmptyDescription"
                                        >
                                            <template #actions>
                                                <ElButton
                                                    v-if="hasAssetFilters"
                                                    link
                                                    type="primary"
                                                    @click="resetAssetFilters"
                                                >清除筛选</ElButton>
                                                <ElButton
                                                    v-else
                                                    link
                                                    type="primary"
                                                    :loading="loading"
                                                    @click="loadAssets"
                                                >刷新资产库</ElButton>
                                            </template>
                                        </AdminInlineEmptyState>
                                    </template>
                                </ElTableV2>
                            </template>
                        </ElAutoResizer>
                    </div>
                </template>
            </ElResponsiveCollection>
        </section>
    </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from 'vue';

import {
    cleanupOrphanAssets,
    listAssetLibrary,
    reindexArticleAssets,
    type AssetLibraryItemResponse
} from '@/api/authoring';
import { deleteImage } from '@/api/system';
import AdminInlineEmptyState from '@/components/admin/AdminInlineEmptyState.vue';
import { FsusUiTaskPageHeader, FsusUiSettingsSection } from "@/fsusui";
import { confirmDanger, toast } from '@/fsusui/feedback';
import { Delete, Refresh, Search } from '@/fsusui/icons';
import { showErrorToast, showWarningToast } from '@/utils/errorPresentation';

type AssetTableSortOrder = 'asc' | 'desc';
interface TableV2Column<T> {
    key: string;
    dataKey?: keyof T | string;
    title?: string;
    width: number;
    align?: 'left' | 'center' | 'right';
    fixed?: true | 'left' | 'right';
    sortable?: boolean;
}

const assets = shallowRef<AssetLibraryItemResponse[]>([]);
const loading = ref(false);
const hasLoadedAssets = ref(false);
const processing = ref(false);
const keyword = ref('');
const orphanOnly = ref(false);
const reindexArticleId = ref('');
const assetSortBy = ref<{ key: 'referenceCount'; order: AssetTableSortOrder; } | null>(null);

const assetTableColumns: TableV2Column<AssetLibraryItemResponse>[] = [
    { key: 'id', dataKey: 'id', title: 'ID', width: 96, align: 'center' },
    { key: 'file', dataKey: 'url', title: '文件', width: 420 },
    { key: 'referenceCount', dataKey: 'referenceCount', title: '引用', width: 120, align: 'center', sortable: true },
    { key: 'sourceArticleId', dataKey: 'sourceArticleId', title: '来源文章', width: 130, align: 'center' },
    { key: 'updatedAt', dataKey: 'updatedAt', title: '更新时间', width: 190 },
    { key: 'actions', title: '管理', width: 150, align: 'right', fixed: 'right' }
];

const showMessageBoxError = (error: unknown): void =>
{
    showErrorToast(error, '确认对话框打开失败');
};

const filteredAssets = computed(() =>
{
    const text = keyword.value.trim().toLowerCase();
    return assets.value.filter((asset) =>
    {
        if (orphanOnly.value && asset.referenceCount > 0)
        {
            return false;
        }

        return !text || asset.url.toLowerCase().includes(text) || (asset.sha256 ?? '').toLowerCase().includes(text);
    });
});
const assetSortState = computed<Record<string, AssetTableSortOrder>>(() =>
{
    const state: Record<string, AssetTableSortOrder> = {};
    if (assetSortBy.value)
    {
        state[assetSortBy.value.key] = assetSortBy.value.order;
    }
    return state;
});
const sortedFilteredAssets = computed(() =>
{
    const rows = [...filteredAssets.value];
    const sort = assetSortBy.value;
    if (!sort)
    {
        return rows;
    }

    return rows.sort((left, right) =>
    {
        const direction = sort.order === 'asc' ? 1 : -1;
        return (left.referenceCount - right.referenceCount) * direction;
    });
});
const hasAssetFilters = computed(() => keyword.value.trim() !== '' || orphanOnly.value);
const isAssetInitialLoading = computed(() => loading.value && !hasLoadedAssets.value);
const assetEmptyTitle = computed(() => hasAssetFilters.value ? '没有匹配的资产' : '资产库暂无文件');
const assetEmptyDescription = computed(() =>
    hasAssetFilters.value
        ? '调整 URL、SHA 或孤儿资产筛选后再查看。'
        : '上传图片或重建文章引用后，可在这里查看文件与引用关系。'
);

const resetAssetFilters = (): void =>
{
    keyword.value = '';
    orphanOnly.value = false;
};

const handleAssetColumnSort = ({ key, order }: { key: string | number | symbol; order?: AssetTableSortOrder; }): void =>
{
    if (key !== 'referenceCount')
    {
        return;
    }

    assetSortBy.value = {
        key: 'referenceCount',
        order: order ?? 'asc'
    };
};

const loadAssets = async (): Promise<void> =>
{
    loading.value = true;
    try
    {
        assets.value = await listAssetLibrary();
    }
    catch (error)
    {
        showErrorToast(error, '资产库同步失败');
    }
    finally
    {
        loading.value = false;
        hasLoadedAssets.value = true;
    }
};

const parseArticleId = (): number | null =>
{
    const parsed = Number.parseInt(reindexArticleId.value.trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const reindexCurrentArticle = async (): Promise<void> =>
{
    const articleId = parseArticleId();
    if (!articleId)
    {
        showWarningToast('请输入有效文章 ID', '请输入有效文章 ID');
        return;
    }

    processing.value = true;
    try
    {
        await reindexArticleAssets(articleId);
        toast.success('文章资产引用已重建');
        await loadAssets();
    }
    catch (error)
    {
        showErrorToast(error, '资产引用重建失败');
    }
    finally
    {
        processing.value = false;
    }
};

const confirmCleanupOrphans = async (): Promise<void> =>
{
    const result = await confirmDanger('确认清理所有引用计数为 0 的孤儿资产？该操作会删除服务器文件。', '清理孤儿资产', {
        confirmButtonText: '确认清理',
        cancelButtonText: '取消'
    });

    switch (result.kind)
    {
        case 'confirmed':
            break;
        case 'cancelled':
            return;
        case 'error':
            showMessageBoxError(result.error);
            return;
    }

    processing.value = true;
    try
    {
        const deleted = await cleanupOrphanAssets();
        toast.success(`已清理 ${deleted} 个孤儿资产`);
        await loadAssets();
    }
    catch (error)
    {
        showErrorToast(error, '孤儿资产清理失败');
    }
    finally
    {
        processing.value = false;
    }
};

const confirmDeleteAsset = async (asset: AssetLibraryItemResponse): Promise<void> =>
{
    const warning = asset.referenceCount > 0
        ? `该文件仍有 ${asset.referenceCount} 个引用。确认删除服务器文件？`
        : '确认删除该孤儿文件？';
    const result = await confirmDanger(warning, '删除服务器文件', {
        confirmButtonText: '确认删除',
        cancelButtonText: '取消'
    });

    switch (result.kind)
    {
        case 'confirmed':
            break;
        case 'cancelled':
            return;
        case 'error':
            showMessageBoxError(result.error);
            return;
    }

    processing.value = true;
    try
    {
        await deleteImage(asset.id);
        toast.success('服务器文件已删除');
        await loadAssets();
    }
    catch (error)
    {
        showErrorToast(error, '服务器文件删除失败');
    }
    finally
    {
        processing.value = false;
    }
};

const formatTime = (input: string): string =>
{
    const date = new Date(input);
    if (Number.isNaN(date.getTime()))
    {
        return input;
    }
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};

onMounted(() =>
{
    void loadAssets();
});
</script>

<style scoped>
.asset-filter-input
 {
    width: min(18rem, 100%);
}

.article-id-input
 {
    width: 12rem;
}

.asset-table-v2-frame
 {
    height: clamp(360px, 58vh, 620px);
    border-bottom: 1px solid var(--fsusblog-panel-border);
}

.asset-url
 {
    display: inline-block;
    max-width: 100%;
    overflow-wrap: anywhere;
    color: var(--fsusblog-color-primary);
    font-size: 14px;
    font-weight: 700;
}

.tabular-nums
 {
    font-variant-numeric: tabular-nums;
}

.asset-reindex-form__item
 {
    margin-bottom: 0;
}
</style>
