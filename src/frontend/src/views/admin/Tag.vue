<template>
  <div class="account-page tag-manage-wrapper account-motion-enter w-full">
    <header class="account-page-header account-page-header--compact">
      <h1 class="account-page-title">标签管理</h1>
      <p class="account-page-description">维护文章标签与检索入口。</p>
    </header>

    <section class="mb-8 border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)]" aria-label="标签状态">
      <AdminCollectionSummary :title="tagStateText" description="删除前会检查引用关系。">
        <template #actions>
          <el-button
            type="primary"
            :icon="Plus"
            @click="openDialog()"
          >
            新增标签
          </el-button>
        </template>
      </AdminCollectionSummary>
    </section>

    <section class="admin-data-surface" aria-labelledby="tag-list-title">
      <AdminCollectionSummary id="tag-list-title" title="标签列表" :meta="tagResultText" />
      <AdminCollectionToolbar label="标签筛选">
        <template #filters>
          <div class="taxonomy-toolbar-controls">
          <el-input
            v-model="filters.keyword"
            class="taxonomy-filter-input"
            clearable
            placeholder="搜索标签"
            aria-label="搜索标签"
            :prefix-icon="Search"
          />
          <el-checkbox v-model="filters.unusedOnly">仅未引用</el-checkbox>
          <el-button text @click="resetFilters">清除筛选</el-button>
          </div>
        </template>
      </AdminCollectionToolbar>
      <el-table
        v-loading="loading"
        :data="filteredList"
        :row-key="getTagRowKey"
      >
        <el-table-column
          v-if="!isCompact"
          prop="id"
          label="ID"
          width="100"
          align="center"
        >
          <template #default="{ row }: { row: AdminTagItemResponse }">
            <span class="tabular-nums">{{ row.id }}</span>
          </template>
        </el-table-column>

        <el-table-column prop="name" label="标签名称" :min-width="nameColumnWidth">
          <template #default="{ row }: { row: AdminTagItemResponse }">
            <div class="min-w-0">
              <el-tag type="info">
                # {{ row.name }}
              </el-tag>
              <p
                v-if="isCompact && !row.canDelete"
                class="mt-2 text-[11px] leading-5 text-[var(--fsusblog-text-muted)]"
              >
                {{ relationLockReason(row) }}
              </p>
            </div>
          </template>
        </el-table-column>

        <el-table-column
          v-if="!isCompact"
          prop="totalBlockingArticleCount"
          label="引用数"
          :width="countColumnWidth"
          align="center"
          sortable
        >
          <template #header>
            <span class="inline-flex items-center justify-center gap-1">
              引用数
              <el-tooltip content="删除判断使用管理端完整引用数，可能高于公开文章数。" placement="top">
                <el-icon><InfoFilled /></el-icon>
              </el-tooltip>
            </span>
          </template>
          <template #default="{ row }: { row: AdminTagItemResponse }">
            <div class="taxonomy-reference-cell">
              <strong class="tabular-nums">总引用 {{ row.totalBlockingArticleCount }}</strong>
              <p class="mt-1 text-[10px] text-[var(--fsusblog-text-muted)]">
                公开 {{ row.publicArticleCount }}
              </p>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="管理" :width="actionColumnWidth" align="right">
          <template #default="{ row }: { row: AdminTagItemResponse }">
            <div class="flex justify-end items-center gap-2 pr-2" :class="{ 'gap-1 pr-0': isCompact }">
              <el-button link type="primary" @click="openDialog(row)"> <span>{{ isCompact ? '改名' : '重命名' }}</span></el-button>
              <el-divider direction="vertical" />
              <el-button
                link
                type="primary"
                :disabled="row.totalBlockingArticleCount <= 0"
                @click="viewAssociatedArticles(row)"
              >
                <span v-if="!isCompact">查看文章</span><el-icon v-else><View /></el-icon>
              </el-button>
              <el-divider direction="vertical" />
              <el-tooltip
                v-if="!row.canDelete"
                :content="relationLockReason(row)"
                placement="top"
              >
                <el-button link type="info" disabled>
                  <span v-if="!isCompact">锁定</span><el-icon v-else><Lock /></el-icon>
                </el-button>
              </el-tooltip>
              <el-button
                v-else
                link
                type="danger"
                @click="handleDelete(row)"
              >
                删除
              </el-button>
            </div>
          </template>
        </el-table-column>
        <template #empty>
          <AdminInlineEmptyState :title="tagEmptyTitle" :description="tagEmptyDescription">
            <template #actions>
              <el-button v-if="hasTagFilters" link type="primary" @click="resetFilters">清除筛选</el-button>
              <el-button v-else link type="primary" @click="openDialog()">新增标签</el-button>
            </template>
          </AdminInlineEmptyState>
        </template>
      </el-table>
    </section>

    <!-- 对话框 -->
    <el-dialog
      v-model="dialogVisible"
      :title="dialogTitle"
      width="380px"
      destroy-on-close
      :close-on-click-modal="false"
    >
      <div class="pt-2">
        <el-form :model="form" ref="formRef" :rules="rules" label-position="top" @submit.prevent="submitForm">
          <el-form-item label="标签名称" prop="name">
            <el-input
              v-model="form.name"
              name="tagName"
              aria-label="标签名称"
              placeholder="标签名称（如：Vue3）"
              maxlength="20"
              show-word-limit
              clearable
              :disabled="isProcessing"
              @keyup.enter="submitForm"
            />
          </el-form-item>
        </el-form>
      </div>
      <div class="mt-4 border-t border-[var(--fsusblog-panel-border)] pt-6 flex gap-2 select-none">
        <span class="text-[var(--fsusblog-text-muted)] mt-1">
          <el-icon><InfoFilled /></el-icon>
        </span>
        <p class="text-[12px] text-[var(--fsusblog-text-muted)] leading-relaxed">
          变更标签名会即时同步至所有关联博文。建议使用简洁、具有高辨识度的词汇。
        </p>
      </div>
      <template #footer>
        <div class="grid grid-cols-2 gap-5 px-1 border-t border-[var(--fsusblog-panel-border)] pt-6">
          <el-button @click="dialogVisible = false" :disabled="isProcessing">取消</el-button>
          <el-button
            type="primary"
            :loading="isProcessing"
            @click="submitForm"
          >
            {{ submitButtonText }}
          </el-button>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { type AdminTagItemResponse } from '@/api/authoring'
import { InfoFilled, Plus, Search, View, Lock } from '@/fsusui/icons'
import { useAdminTagManage } from '@/composables/useAdminTagManage'
import { useMediaQuery } from '@/composables/useMediaQuery'
import {
  AdminCollectionSummary,
  AdminCollectionToolbar,
  AdminInlineEmptyState
} from '@/components/admin/AdminCollectionPrimitives'

const {
  list,
  filteredList,
  loading,
  dialogVisible,
  dialogTitle,
  submitButtonText,
  formRef,
  isProcessing,
  filters,
  form,
  rules,
  relationLockReason,
  viewAssociatedArticles,
  resetFilters,
  openDialog,
  submitForm,
  handleDelete
} = useAdminTagManage()

void formRef

const getTagRowKey = (row: AdminTagItemResponse): string => String(row.id)

const isCompact = useMediaQuery('(max-width: 639px)')
const hasTagFilters = computed(() => filters.keyword.trim() !== '' || filters.unusedOnly)
const tagStateText = computed(() => `标签 · ${list.value.length} 个`)
const tagResultText = computed(() => `标签列表 · ${filteredList.value.length} 条结果`)
const tagEmptyTitle = computed(() => hasTagFilters.value ? '没有匹配的标签' : '暂无标签')
const tagEmptyDescription = computed(() => hasTagFilters.value
  ? '调整关键词或清除筛选。'
  : '新增标签后可用于文章检索与索引。')
const nameColumnWidth = computed(() => (isCompact.value ? 148 : 220))
const countColumnWidth = computed(() => (isCompact.value ? 96 : 150))
const actionColumnWidth = computed(() => (isCompact.value ? 168 : 280))
</script>

<style scoped>

.tabular-nums {
  font-variant-numeric: tabular-nums;
}

.taxonomy-filter-input {
  width: min(15rem, 100%);
}

.taxonomy-toolbar-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem;
}

.taxonomy-reference-cell {
  display: grid;
  gap: 0.125rem;
  justify-items: center;
}

@media (max-width: 639px) {
  .taxonomy-toolbar-controls,
  .taxonomy-filter-input {
    width: 100%;
  }
}
</style>
