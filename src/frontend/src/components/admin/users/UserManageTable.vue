<template>
    <section class="admin-data-surface user-resource-surface">
        <div
            v-if="showInitialSkeleton"
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
            :items="tableRows"
            row-key="accountId"
            compact-query="(max-width: 767px)"
            aria-label="匿名账号列表"
            role="list"
        >
            <template #card="{ item: row }">
                <div
                    v-if="isTableRow(row)"
                    class="user-resource-list-item border-b border-[var(--fsusblog-panel-border)] px-4 py-3"
                    :class="rowMotionClass(row.accountId)"
                    role="listitem"
                >
                    <div class="user-resource-list-identity-row flex items-center gap-3">
                        <div class="shrink-0">
                            <ElAvatar :size="36">
                                {{ row.initials }}
                            </ElAvatar>
                        </div>
                        <div class="min-w-0 flex-1">
                            <div class="flex min-w-0 flex-wrap items-center gap-2">
                                <span class="truncate text-sm font-bold text-[var(--fsusblog-text-primary)]">
                                    {{ row.displayHandle }}
                                </span>
                                <span class="bg-[var(--fsusblog-panel-bg-soft)] px-2 py-1 text-xs font-medium italic normal-case tracking-normal text-[var(--fsusblog-text-muted)]">
                                    {{ row.identityKindLabel }}
                                </span>
                            </div>
                        </div>
                        <div class="inline-flex shrink-0 items-center gap-2">
                            <span
                                class="h-1.5 w-1.5 rounded-[var(--fsus-radius-control-small)]"
                                :class="row.statusDotClass"
                                aria-hidden="true"
                            />
                            <span
                                class="text-xs font-bold normal-case tracking-normal"
                                :class="row.statusClass"
                            >
                                {{ row.statusText }}
                            </span>
                        </div>
                    </div>

                    <div class="user-resource-list-meta mt-3 text-[12px] leading-5 text-[var(--fsusblog-text-muted)] normal-case tracking-normal">
                        <SemanticTime
                            class="tabular-nums"
                            :value="row.createTime"
                            :text="row.createdAtText"
                        />
                        <span>匿名身份：{{ row.anonymousCredentialText }}</span>
                        <span>{{ row.riskFlagsText }}</span>
                    </div>

                    <div class="user-resource-list-action-row mt-3 flex items-center justify-between gap-3 border-t border-[var(--fsusblog-panel-border)] pt-3">
                        <p class="min-w-0 text-[12px] leading-5 text-[var(--fsusblog-text-muted)] normal-case tracking-normal">
                            {{ row.credentialSummary }}
                        </p>
                        <ElButton
                            v-if="!row.isDeleted"
                            :type="row.status === 0 ? 'danger' : 'success'"
                            :loading="isProcessing && processingId === row.accountId"
                            :aria-label="`变更匿名账号状态：${row.displayHandle}`"
                            @click="emit('toggle-status', row)"
                        >
                            {{ row.status === 0 ? '封禁' : '解封' }}
                        </ElButton>
                        <span
                            v-else
                            class="text-xs font-medium normal-case tracking-normal text-[var(--fsusblog-text-muted)]"
                        >
                            已注销账户
                        </span>
                    </div>
                </div>
            </template>

            <template #empty>
                <AdminInlineEmptyState
                    :title="emptyTitle"
                    :description="emptyDescription"
                >
                    <template
                        v-if="hasActiveFilters"
                        #actions
                    >
                        <ElButton @click="emit('reset-filters')">清除筛选</ElButton>
                    </template>
                </AdminInlineEmptyState>
            </template>

            <template #table>
                <div class="user-table-v2-frame">
                    <ElAutoResizer>
                        <template #default="{ height, width }">
                            <ElTableV2
                                class="user-table"
                                :columns="userTableColumns"
                                :data="tableRows"
                                :width="width"
                                :height="height"
                                :row-height="72"
                                row-key="accountId"
                                :row-class="rowClassName"
                                :row-class-name="rowClassName"
                            >
                                <template #cell="{ rowData, column }">
                                    <span
                                        v-if="isTableRow(rowData) && column.key === 'accountId'"
                                        class="tabular-nums"
                                    >
                                        {{ rowData.accountId }}
                                    </span>

                                    <div
                                        v-else-if="isTableRow(rowData) && column.key === 'account'"
                                        class="flex items-center gap-5 overflow-hidden whitespace-nowrap"
                                    >
                                        <div class="shrink-0">
                                            <ElAvatar :size="32">
                                                {{ rowData.initials }}
                                            </ElAvatar>
                                        </div>
                                        <p class="flex min-w-0 flex-col justify-center overflow-hidden">
                                            <span class="truncate text-sm font-bold leading-tight text-[var(--fsusblog-text-primary)]">
                                                {{ rowData.displayHandle }}
                                            </span>
                                            <SemanticTime
                                                :value="rowData.createTime"
                                                :text="`${rowData.createdAtText} 初始化`"
                                                class="mt-1 tabular-nums text-[11px] text-[var(--fsusblog-text-muted)] normal-case tracking-normal"
                                            />
                                        </p>
                                    </div>

                                    <span
                                        v-else-if="isTableRow(rowData) && column.key === 'identityKind'"
                                        class="text-xs font-medium italic normal-case tracking-normal text-[var(--fsusblog-text-muted)]"
                                    >
                                        {{ rowData.identityKindLabel }}
                                    </span>

                                    <div
                                        v-else-if="isTableRow(rowData) && column.key === 'credential'"
                                        class="flex flex-col whitespace-nowrap"
                                    >
                                        <span class="text-[12px] font-bold text-[var(--fsusblog-text-tertiary)]">
                                            {{ rowData.credentialSummary }}
                                        </span>
                                        <span class="text-[11px] text-[var(--fsusblog-text-muted)]">
                                            匿名身份：{{ rowData.anonymousCredentialText }}
                                        </span>
                                        <span class="text-[11px] text-[var(--fsusblog-text-muted)]">
                                            风险标记：{{ rowData.riskFlagsText }}
                                        </span>
                                    </div>

                                    <span
                                        v-else-if="isTableRow(rowData) && column.key === 'status'"
                                        class="inline-flex flex-col items-center justify-center"
                                    >
                                        <span
                                            class="mb-1 h-1 w-1 rounded-[var(--fsus-radius-control-small)]"
                                            :class="rowData.statusDotClass"
                                            aria-hidden="true"
                                        />
                                        <span
                                            class="text-xs font-medium normal-case tracking-normal"
                                            :class="rowData.statusClass"
                                        >
                                            {{ rowData.statusText }}
                                        </span>
                                    </span>

                                    <div
                                        v-else-if="isTableRow(rowData) && column.key === 'actions' && !rowData.isDeleted"
                                        class="flex items-center justify-end gap-2 pr-2"
                                    >
                                        <ElButton
                                            class="user-table-action-button"
                                            link
                                            :type="rowData.status === 0 ? 'danger' : 'success'"
                                            size="small"
                                            :loading="isProcessing && processingId === rowData.accountId"
                                            :aria-label="`变更匿名账号状态：${rowData.displayHandle}`"
                                            @click="emit('toggle-status', rowData)"
                                        >
                                            {{ rowData.status === 0 ? '封禁' : '解封' }}
                                        </ElButton>
                                    </div>
                                    <span
                                        v-else-if="isTableRow(rowData) && column.key === 'actions'"
                                        class="pr-4 text-xs font-medium italic normal-case tracking-normal text-[var(--fsusblog-text-muted)]"
                                    >
                                        已注销
                                    </span>
                                </template>

                                <template #empty>
                                    <AdminInlineEmptyState
                                        :title="emptyTitle"
                                        :description="emptyDescription"
                                    >
                                        <template
                                            v-if="hasActiveFilters"
                                            #actions
                                        >
                                            <ElButton @click="emit('reset-filters')">清除筛选</ElButton>
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
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import AdminInlineEmptyState from '@/components/admin/AdminInlineEmptyState.vue';
import SemanticTime from '@/components/ui/SemanticTime.vue';
import type { UserListViewItem } from '@/composables/useAdminUserManage';
import { FsusUiTableV2FixedDir as TableV2FixedDir } from '@/fsusui/tableV2';

import type { Column } from '@ozwasyd/element-plus';

defineOptions({
    inheritAttrs: false
});

interface Props {
    loading: boolean;
    list: readonly UserListViewItem[];
    total: number;
    currentPage: number;
    pageSize: number;
    isProcessing: boolean;
    processingId: number | null;
    rowMotionClass?: (id: number) => string;
    emptyTitle?: string;
    emptyDescription?: string;
    hasActiveFilters?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
    emptyTitle: '暂无匿名账号记录',
    emptyDescription: '匿名账号初始化后会显示在这里。',
    hasActiveFilters: false
});

const hasCompletedFirstLoad = ref(false);
watch(() => props.loading, (isLoading) =>
{
    if (!isLoading)
    {
        hasCompletedFirstLoad.value = true;
    }
});

const userTableColumns: Column<UserListViewItem>[] = [
    { key: 'accountId', dataKey: 'accountId', title: 'Account', width: 96, align: 'center' },
    { key: 'account', dataKey: 'displayHandle', title: '匿名账号', width: 280 },
    { key: 'identityKind', dataKey: 'identityKind', title: '身份', width: 128, align: 'center' },
    { key: 'credential', dataKey: 'credentialSummary', title: '凭据', width: 280 },
    { key: 'status', dataKey: 'status', title: '状态', width: 132, align: 'center' },
    { key: 'actions', title: '操作', width: 128, align: 'right', fixed: TableV2FixedDir.RIGHT }
];
// The public controls require mutable containers; never expose the readonly
// product input as that container. Keep each row's original object identity.
const tableRows = computed(() => props.list.slice());
const tableRowIdentities = computed<ReadonlySet<unknown>>(() => new Set(tableRows.value));
const isTableRow = (row: unknown): row is UserListViewItem => tableRowIdentities.value.has(row);
const showInitialSkeleton = computed(() => props.loading && !hasCompletedFirstLoad.value && props.list.length === 0);
const rowMotionClass = (id: number): string => props.rowMotionClass?.(id) ?? 'blog-motion-row-state';
const rowClassName = ({ rowData }: { rowData: unknown; }): string => isTableRow(rowData) ? rowMotionClass(rowData.accountId) : '';

const emit = defineEmits<{
    refresh: [];
    'toggle-status': [row: UserListViewItem];
    'reset-filters': [];
    'update:current-page': [value: number];
    'update:page-size': [value: number];
}>();
</script>

<style scoped>
.tabular-nums
 {
    font-variant-numeric: tabular-nums;
}

.user-table-v2-frame
 {
    height: clamp(360px, 58vh, 620px);
    border-block: 1px solid var(--fsusblog-panel-border);
}

.user-resource-surface:has(.is-compact)
 {
    width: min(100%, 44rem);
    margin-inline: auto;
    background: var(--fsusblog-panel-bg);
    box-shadow: none;
}



.user-resource-list-item
 {
    width: 100%;
    border-block-end: 1px solid var(--fsusblog-panel-border);
    border-radius: 0;
    background: transparent;
}

.user-resource-list-item:last-child
 {
    border-block-end: 0;
}

.user-resource-list-meta
 {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fsus-space-1) var(--fsus-space-3);
}

.user-table-action-button
 {
    min-height: 2.5rem;
    padding-inline: var(--fsus-space-2);
}
</style>
