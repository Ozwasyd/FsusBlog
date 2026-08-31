<template>
    <div :class="['account-page account-motion-enter w-full', schema.pageClass]">
        <FsusUiTaskPageHeader
            :title="schema.pageTitle"
            :description="schema.pageDescription"
            class="account-task-page-header"
            density="compact"
        />

        <section
            class="mb-8 border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]"
            :aria-label="schema.summaryAriaLabel"
        >
            <AdminCollectionSummary
                :title="stateText"
                :description="schema.summaryDescription"
            >
                <template #actions>
                    <ElButton
                        type="primary"
                        :icon="Plus"
                        @click="state.openDialog()"
                    >{{ schema.newButtonLabel }}</ElButton>
                </template>
            </AdminCollectionSummary>
        </section>

        <section
            class="admin-data-surface"
            :aria-labelledby="`${schema.kind}-list-title`"
        >
            <AdminCollectionSummary
                :id="`${schema.kind}-list-title`"
                :title="schema.listTitle"
                :meta="resultText"
            />
            <AdminCollectionToolbar :label="schema.toolbarLabel">
                <template #filters>
                    <div class="taxonomy-toolbar-controls">
                        <ElInput
                            v-model="state.filters.keyword"
                            class="taxonomy-filter-input"
                            clearable
                            :placeholder="schema.searchPlaceholder"
                            :aria-label="schema.searchAriaLabel"
                            :prefix-icon="Search"
                        />
                        <ElCheckbox v-model="state.filters.unusedOnly">仅未引用</ElCheckbox>
                        <ElButton
                            text
                            @click="state.resetFilters"
                        >清除筛选</ElButton>
                    </div>
                </template>
            </AdminCollectionToolbar>

            <div
                v-if="isInitialLoading"
                class="px-4 py-6"
                aria-busy="true"
            >
                <ElSkeleton
                    :rows="6"
                    animated
                />
            </div>

            <ElTable
                v-else-if="hasTaxonomyRows"
                class="taxonomy-table"
                v-loading="loading"
                :data="filteredList"
                :row-key="getRowKey"
            >
                <ElTableColumn
                    v-if="!isCompact"
                    prop="id"
                    label="ID"
                    width="100"
                    align="center"
                >
                    <template #default="{ row }"><span class="tabular-nums">{{ row.id }}</span></template>
                </ElTableColumn>
                <ElTableColumn
                    prop="name"
                    :label="schema.nameColumnLabel"
                    :min-width="nameColumnWidth"
                >
                    <template #default="{ row }">
                        <div class="min-w-0">
                            <strong
                                v-if="schema.nameDisplay === 'text'"
                                class="font-bold text-[var(--fsusblog-text-secondary)] leading-6"
                            >{{ row.name }}</strong>
                            <ElTag
                                v-else
                                type="info"
                            ># {{ row.name }}</ElTag>
                            <p
                                v-if="isCompact && !row.canDelete"
                                class="mt-2 text-[11px] leading-5 text-[var(--fsusblog-text-muted)]"
                            >{{ state.relationLockReason(row) }}</p>
                        </div>
                    </template>
                </ElTableColumn>
                <ElTableColumn
                    v-if="!isCompact"
                    prop="totalBlockingArticleCount"
                    label="引用数"
                    :width="relationColumnWidth"
                    align="center"
                    sortable
                >
                    <template #header>
                        <span class="inline-flex items-center justify-center gap-1">
                            引用数
                            <ElTooltip
                                content="删除判断使用管理端完整引用数，可能高于公开文章数。"
                                placement="top"
                            ><ElIcon aria-hidden="true"><InfoFilled /></ElIcon></ElTooltip>
                        </span>
                    </template>
                    <template #default="{ row }">
                        <div class="taxonomy-reference-cell">
                            <strong class="tabular-nums">总引用 {{ row.totalBlockingArticleCount }}</strong>
                            <p class="mt-1 text-[10px] text-[var(--fsusblog-text-muted)]">公开 {{ row.publicArticleCount }}</p>
                        </div>
                    </template>
                </ElTableColumn>
                <ElTableColumn
                    label="管理"
                    :width="actionColumnWidth"
                    align="right"
                    :fixed="!isCompact && schema.fixActionColumn ? 'right' : false"
                >
                    <template #default="{ row }">
                        <div
                            class="flex justify-end items-center gap-2 pr-2"
                            :class="{ 'gap-1 pr-0': isCompact }"
                        >
                            <ElButton
                                link
                                type="primary"
                                :class="{ 'admin-table-action--compact': isCompact }"
                                @click="state.openDialog(row)"
                            >
                                <ElIcon
                                    aria-hidden="true"
                                    v-if="schema.compactEditIcon && isCompact"
                                ><Edit /></ElIcon>
                                <span v-else>{{ isCompact ? schema.compactEditLabel : schema.editLabel }}</span>
                            </ElButton>
                            <ElDivider direction="vertical" />
                            <ElButton
                                link
                                type="primary"
                                :class="{ 'admin-table-action--compact': isCompact }"
                                :disabled="row.totalBlockingArticleCount <= 0"
                                @click="state.viewAssociatedArticles(row)"
                            >
                                <span v-if="!isCompact">查看文章</span><ElIcon
                                    aria-hidden="true"
                                    v-else
                                ><View /></ElIcon>
                            </ElButton>
                            <ElDivider direction="vertical" />
                            <ElTooltip
                                v-if="!row.canDelete"
                                :content="state.relationLockReason(row)"
                                placement="top"
                            >
                                <div
                                    class="taxonomy-action-locked"
                                    :aria-label="`锁定：${state.relationLockReason(row)}`"
                                    :title="state.relationLockReason(row)"
                                    tabindex="0"
                                >
                                    <ElIcon
                                        aria-hidden="true"
                                        :size="14"
                                    ><Lock /></ElIcon>
                                    <span v-if="!isCompact">锁定</span>
                                </div>
                            </ElTooltip>
                            <ElButton
                                v-else
                                link
                                type="danger"
                                :class="{ 'admin-table-action--compact': isCompact }"
                                @click="state.handleDelete(row)"
                            >
                                <ElIcon
                                    aria-hidden="true"
                                    v-if="schema.compactDeleteIcon && isCompact"
                                ><Delete /></ElIcon>
                                <span v-else>删除</span>
                            </ElButton>
                        </div>
                    </template>
                </ElTableColumn>
            </ElTable>

            <div
                v-else
                v-loading="loading"
                class="taxonomy-empty-container"
            >
                <AdminInlineEmptyState
                    class="taxonomy-empty-state"
                    :title="emptyTitle"
                    :description="emptyDescription"
                >
                    <template #actions>
                        <div class="taxonomy-empty-actions">
                            <ElButton
                                v-if="hasFilters"
                                class="taxonomy-empty-action"
                                @click="state.resetFilters"
                            >清除筛选</ElButton>
                            <ElButton
                                v-else
                                class="taxonomy-empty-action"
                                type="primary"
                                @click="state.openDialog()"
                            >{{ schema.newButtonLabel }}</ElButton>
                        </div>
                    </template>
                </AdminInlineEmptyState>
            </div>
        </section>

        <FsusDialog
            v-model="state.dialogVisible.value"
            :title="dialogTitle"
            :width="schema.dialogWidth"
            destroy-on-close
            :close-on-click-modal="false"
        >
            <div class="pt-2">
                <ElForm
                    :model="state.form"
                    ref="formRef"
                    :rules="state.rules"
                    label-position="top"
                    @submit.prevent="submitForm"
                >
                    <ElFormItem
                        :label="schema.nameInputLabel"
                        prop="name"
                    >
                        <ElInput
                            v-model="state.form.name"
                            :name="schema.nameInputName"
                            :aria-label="schema.nameInputLabel"
                            :placeholder="schema.nameInputPlaceholder"
                            maxlength="20"
                            show-word-limit
                            clearable
                            :disabled="isProcessing"
                            @keyup.enter="submitForm"
                        />
                    </ElFormItem>
                </ElForm>
            </div>
            <div :class="['taxonomy-dialog-note mt-4 border-t border-[var(--fsusblog-panel-border)] pt-6 flex select-none', schema.dialogNoteGapClass]">
                <span class="taxonomy-dialog-note__icon"><ElIcon
                    aria-hidden="true"
                    :size="16"
                ><InfoFilled /></ElIcon></span>
                <p :class="['taxonomy-dialog-note__text', schema.dialogNoteClass]">{{ schema.dialogDescription }}</p>
            </div>
            <template #footer>
                <div class="taxonomy-dialog-actions">
                    <ElButton
                        @click="state.dialogVisible.value = false"
                        :disabled="isProcessing"
                    >取消</ElButton>
                    <ElButton
                        type="primary"
                        :loading="isProcessing"
                        @click="submitForm"
                    >{{ submitButtonText }}</ElButton>
                </div>
            </template>
        </FsusDialog>
    </div>
</template>

<script setup lang="ts" generic="TItem extends AdminTaxonomyItemBase">
import { type FormInstance } from '@ozwasyd/element-plus';
import { computed, ref, useTemplateRef, watch } from 'vue';

import AdminCollectionSummary from '@/components/admin/AdminCollectionSummary.vue';
import AdminCollectionToolbar from '@/components/admin/AdminCollectionToolbar.vue';
import AdminInlineEmptyState from '@/components/admin/AdminInlineEmptyState.vue';
import FsusDialog from '@/components/ui/FsusDialog.vue';
import type { AdminTaxonomyItemBase, AdminTaxonomyManageState, TaxonomySchema } from '@/composables/useAdminTaxonomyManage';
import { useMediaQuery } from '@/composables/useMediaQuery';
import { FsusUiTaskPageHeader } from '@/fsusui';
import { InfoFilled, Plus, Edit, Lock, Delete, Search, View } from '@/fsusui/icons';

const props = defineProps<{
    schema: TaxonomySchema<TItem>;
    state: AdminTaxonomyManageState;
}>();

const formRef = useTemplateRef<FormInstance>('formRef');
const isCompact = useMediaQuery('(max-width: 639px)');
const hasLoadedList = ref(false);

const list = computed(() => props.state.list.value);
const filteredList = computed(() => props.state.filteredList.value);
const loading = computed(() => props.state.loading.value);
const dialogTitle = computed(() => props.state.dialogTitle.value);
const submitButtonText = computed(() => props.state.submitButtonText.value);
const isProcessing = computed(() => props.state.isProcessing.value);
const hasFilters = computed(() => props.state.filters.keyword.trim() !== '' || props.state.filters.unusedOnly);
const isInitialLoading = computed(() => loading.value && !hasLoadedList.value);
const stateText = computed(() => `${props.schema.entityLabel} · ${list.value.length} 个`);
const resultText = computed(() => `${props.schema.listTitle} · ${filteredList.value.length} 条结果`);
const emptyTitle = computed(() => hasFilters.value ? props.schema.filteredEmptyTitle : props.schema.emptyTitle);
const emptyDescription = computed(() => hasFilters.value ? props.schema.filteredEmptyDescription : props.schema.emptyDescription);
const hasTaxonomyRows = computed(() => filteredList.value.length > 0);
const nameColumnWidth = computed(() => isCompact.value ? props.schema.nameColumnWidth.compact : props.schema.nameColumnWidth.wide);
const relationColumnWidth = computed(() => isCompact.value ? props.schema.relationColumnWidth.compact : props.schema.relationColumnWidth.wide);
const actionColumnWidth = computed(() => isCompact.value ? props.schema.actionColumnWidth.compact : props.schema.actionColumnWidth.wide);

watch(loading, (isLoading) =>
{
    if (!isLoading)
    {
        hasLoadedList.value = true;
    }
});

const getRowKey = (row: { id: number; }): string => String(row.id);
const submitForm = (): void =>
{
    void props.state.submitForm(formRef.value);
};
</script>

<style scoped>
.taxonomy-empty-container
 {
    min-height: 10rem;
    border-top: 1px solid var(--fsusblog-panel-border);
    padding-block: var(--fsus-space-5) var(--fsus-space-6);
}

.taxonomy-empty-state
 {
    min-height: 7rem;
}

.taxonomy-empty-actions
 {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fsus-space-3);
    margin-top: var(--fsus-space-3);
}

.taxonomy-empty-action
 {
    min-width: 6.5rem;
}

.taxonomy-dialog-actions
 {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--fsus-space-5);
    padding-inline: var(--fsus-space-1);
}



.taxonomy-action-locked
 {
    display: inline-flex;
    align-items: center;
    box-sizing: border-box;
    min-height: 32px;
    gap: var(--fsus-space-1);
    color: var(--fsusblog-text-muted);
    font-size: 12px;
    font-weight: 500;
    cursor: help;
}

.admin-table-action--compact
 {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    min-width: 32px;
    min-height: 32px;
}

.taxonomy-dialog-note
 {
    color: var(--fsusblog-text-tertiary);
}

.taxonomy-dialog-note__icon
 {
    display: inline-flex;
    flex: 0 0 16px;
    align-items: center;
    min-height: 20px;
}

.taxonomy-dialog-note__text
 {
    margin: 0;
    color: var(--fsusblog-text-tertiary);
    font-size: 13px;
    line-height: 20px;
}

@media (width <= 639px)
 {
    .taxonomy-empty-action
 {
        min-width: 6rem;
    }

    .taxonomy-action-locked
 {
        min-width: 32px;
        justify-content: center;
    }
}
</style>
