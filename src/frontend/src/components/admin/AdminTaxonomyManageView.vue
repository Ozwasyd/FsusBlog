<template>
  <div :class="['account-page account-motion-enter w-full', schema.pageClass]">
    <header class="account-page-header account-page-header--compact">
      <h1 class="account-page-title">{{ schema.pageTitle }}</h1>
      <p class="account-page-description">{{ schema.pageDescription }}</p>
    </header>

    <section class="mb-8 border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]" :aria-label="schema.summaryAriaLabel">
      <AdminCollectionSummary :title="stateText" :description="schema.summaryDescription">
        <template #actions>
          <el-button type="primary" :icon="Plus" @click="state.openDialog()">{{ schema.newButtonLabel }}</el-button>
        </template>
      </AdminCollectionSummary>
    </section>

    <section class="admin-data-surface" :aria-labelledby="`${schema.kind}-list-title`">
      <AdminCollectionSummary :id="`${schema.kind}-list-title`" :title="schema.listTitle" :meta="resultText" />
      <AdminCollectionToolbar :label="schema.toolbarLabel">
        <template #filters>
          <div class="taxonomy-toolbar-controls">
            <el-input v-model="state.filters.keyword" class="taxonomy-filter-input" clearable :placeholder="schema.searchPlaceholder" :aria-label="schema.searchAriaLabel" :prefix-icon="Search" />
            <el-checkbox v-model="state.filters.unusedOnly">仅未引用</el-checkbox>
            <el-button text @click="state.resetFilters">清除筛选</el-button>
          </div>
        </template>
      </AdminCollectionToolbar>

      <div v-if="isInitialLoading" class="px-4 py-6" aria-busy="true">
        <el-skeleton :rows="6" animated />
      </div>

      <el-table v-else-if="hasTaxonomyRows" class="taxonomy-table" v-loading="loading" :data="filteredList" :row-key="getRowKey">
        <el-table-column v-if="!isCompact" prop="id" label="ID" width="100" align="center">
          <template #default="{ row }"><span class="tabular-nums">{{ row.id }}</span></template>
        </el-table-column>
        <el-table-column prop="name" :label="schema.nameColumnLabel" :min-width="nameColumnWidth">
          <template #default="{ row }">
            <div class="min-w-0">
              <strong v-if="schema.nameDisplay === 'text'" class="font-bold text-[var(--fsusblog-text-secondary)] leading-6">{{ row.name }}</strong>
              <el-tag v-else type="info"># {{ row.name }}</el-tag>
              <p v-if="isCompact && !row.canDelete" class="mt-2 text-[11px] leading-5 text-[var(--fsusblog-text-muted)]">{{ state.relationLockReason(row) }}</p>
            </div>
          </template>
        </el-table-column>
        <el-table-column v-if="!isCompact" prop="totalBlockingArticleCount" label="引用数" :width="relationColumnWidth" align="center" sortable>
          <template #header>
            <span class="inline-flex items-center justify-center gap-1">
              引用数
              <el-tooltip content="删除判断使用管理端完整引用数，可能高于公开文章数。" placement="top"><el-icon aria-hidden="true"><InfoFilled /></el-icon></el-tooltip>
            </span>
          </template>
          <template #default="{ row }">
            <div class="taxonomy-reference-cell">
              <strong class="tabular-nums">总引用 {{ row.totalBlockingArticleCount }}</strong>
              <p class="mt-1 text-[10px] text-[var(--fsusblog-text-muted)]">公开 {{ row.publicArticleCount }}</p>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="管理" :width="actionColumnWidth" align="right" :fixed="!isCompact && schema.fixActionColumn ? 'right' : false">
          <template #default="{ row }">
            <div class="flex justify-end items-center gap-2 pr-2" :class="{ 'gap-1 pr-0': isCompact }">
              <el-button link type="primary" @click="state.openDialog(row)">
                <el-icon aria-hidden="true" v-if="schema.compactEditIcon && isCompact"><Edit /></el-icon>
                <span v-else>{{ isCompact ? schema.compactEditLabel : schema.editLabel }}</span>
              </el-button>
              <el-divider direction="vertical" />
              <el-button link type="primary" :disabled="row.totalBlockingArticleCount <= 0" @click="state.viewAssociatedArticles(row)">
                <span v-if="!isCompact">查看文章</span><el-icon aria-hidden="true" v-else><View /></el-icon>
              </el-button>
              <el-divider direction="vertical" />
              <el-tooltip v-if="!row.canDelete" :content="state.relationLockReason(row)" placement="top">
                <el-button link type="info" disabled><span v-if="!isCompact">锁定</span><el-icon aria-hidden="true" v-else><Lock /></el-icon></el-button>
              </el-tooltip>
              <el-button v-else link type="danger" @click="state.handleDelete(row)">
                <el-icon aria-hidden="true" v-if="schema.compactDeleteIcon && isCompact"><Delete /></el-icon>
                <span v-else>删除</span>
              </el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>

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
              <el-button v-if="hasFilters" class="taxonomy-empty-action" @click="state.resetFilters">清除筛选</el-button>
              <el-button v-else class="taxonomy-empty-action" type="primary" @click="state.openDialog()">{{ schema.newButtonLabel }}</el-button>
            </div>
          </template>
        </AdminInlineEmptyState>
      </div>
    </section>

    <FsusDialog v-model="state.dialogVisible.value" :title="dialogTitle" :width="schema.dialogWidth" destroy-on-close :close-on-click-modal="false">
      <div class="pt-2">
        <el-form :model="state.form" ref="formRef" :rules="state.rules" label-position="top" @submit.prevent="submitForm">
          <el-form-item :label="schema.nameInputLabel" prop="name">
            <el-input v-model="state.form.name" :name="schema.nameInputName" :aria-label="schema.nameInputLabel" :placeholder="schema.nameInputPlaceholder" maxlength="20" show-word-limit clearable :disabled="isProcessing" @keyup.enter="submitForm" />
          </el-form-item>
        </el-form>
      </div>
      <div :class="['mt-4 border-t border-[var(--fsusblog-panel-border)] pt-6 flex select-none', schema.dialogNoteGapClass]">
        <span class="text-[var(--fsusblog-text-muted)] mt-1"><el-icon aria-hidden="true"><InfoFilled /></el-icon></span>
        <p :class="['text-[12px] text-[var(--fsusblog-text-muted)] leading-relaxed', schema.dialogNoteClass]">{{ schema.dialogDescription }}</p>
      </div>
      <template #footer>
        <div class="taxonomy-dialog-actions">
          <el-button @click="state.dialogVisible.value = false" :disabled="isProcessing">取消</el-button>
          <el-button type="primary" :loading="isProcessing" @click="submitForm">{{ submitButtonText }}</el-button>
        </div>
      </template>
    </FsusDialog>
  </div>
</template>

<script setup lang="ts" generic="TItem extends AdminTaxonomyItemBase">
import { computed, ref, useTemplateRef, watch } from 'vue'
import { type FormInstance } from '@ozwasyd/element-plus'
import { InfoFilled, Plus, Edit, Lock, Delete, Search, View } from '@/fsusui/icons'
import { useMediaQuery } from '@/composables/useMediaQuery'
import AdminCollectionSummary from '@/components/admin/AdminCollectionSummary.vue'
import AdminCollectionToolbar from '@/components/admin/AdminCollectionToolbar.vue'
import AdminInlineEmptyState from '@/components/admin/AdminInlineEmptyState.vue'
import FsusDialog from '@/components/ui/FsusDialog.vue'
import type { AdminTaxonomyItemBase, AdminTaxonomyManageState, TaxonomySchema } from '@/composables/useAdminTaxonomyManage'

const props = defineProps<{
  schema: TaxonomySchema<TItem>
  state: AdminTaxonomyManageState
}>()

const formRef = useTemplateRef<FormInstance>('formRef')
const isCompact = useMediaQuery('(max-width: 639px)')
const hasLoadedList = ref(false)

const list = computed(() => props.state.list.value)
const filteredList = computed(() => props.state.filteredList.value)
const loading = computed(() => props.state.loading.value)
const dialogTitle = computed(() => props.state.dialogTitle.value)
const submitButtonText = computed(() => props.state.submitButtonText.value)
const isProcessing = computed(() => props.state.isProcessing.value)
const hasFilters = computed(() => props.state.filters.keyword.trim() !== '' || props.state.filters.unusedOnly)
const isInitialLoading = computed(() => loading.value && !hasLoadedList.value)
const stateText = computed(() => `${props.schema.entityLabel} · ${list.value.length} 个`)
const resultText = computed(() => `${props.schema.listTitle} · ${filteredList.value.length} 条结果`)
const emptyTitle = computed(() => hasFilters.value ? props.schema.filteredEmptyTitle : props.schema.emptyTitle)
const emptyDescription = computed(() => hasFilters.value ? props.schema.filteredEmptyDescription : props.schema.emptyDescription)
const hasTaxonomyRows = computed(() => filteredList.value.length > 0)
const nameColumnWidth = computed(() => isCompact.value ? props.schema.nameColumnWidth.compact : props.schema.nameColumnWidth.wide)
const relationColumnWidth = computed(() => isCompact.value ? props.schema.relationColumnWidth.compact : props.schema.relationColumnWidth.wide)
const actionColumnWidth = computed(() => isCompact.value ? props.schema.actionColumnWidth.compact : props.schema.actionColumnWidth.wide)

watch(loading, (isLoading) => {
  if (!isLoading) {
    hasLoadedList.value = true
  }
})

const getRowKey = (row: { id: number }): string => String(row.id)
const submitForm = (): void => {
  void props.state.submitForm(formRef.value)
}
</script>

<style scoped>
.taxonomy-empty-container {
  min-height: 10rem;
  border-top: 1px solid var(--fsusblog-panel-border);
  padding-block: var(--fsus-space-5) var(--fsus-space-6);
}

.taxonomy-empty-state {
  min-height: 7rem;
  padding: var(--fsus-space-6);
}

.taxonomy-empty-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--fsus-space-3);
  margin-top: var(--fsus-space-3);
}

.taxonomy-empty-action {
  min-width: 6.5rem;
}

.taxonomy-dialog-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--fsus-space-5);
  padding-inline: var(--fsus-space-1);
}

.taxonomy-table :deep(.el-table-fixed-column--right.is-first-column) {
  border-left: 1px solid var(--fsusblog-panel-border);
}

.taxonomy-table :deep(.el-table-fixed-column--right.is-first-column::before) {
  box-shadow: none;
}

@media (max-width: 639px) {
  .taxonomy-empty-state {
    padding-inline: var(--fsus-space-5);
  }

  .taxonomy-empty-action {
    min-width: 6rem;
  }
}
</style>
