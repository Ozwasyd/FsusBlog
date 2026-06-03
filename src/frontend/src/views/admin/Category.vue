<template>
  <div class="account-page category-manage-wrapper account-motion-enter w-full">
    <AccountPageHeader
      eyebrow="管理 / STRUCTURE"
      title="分类管理"
      description="维护主站的目录结构与归档入口。分类变更会即时影响导航组织，因此只保留必要而清晰的操作信息。"
    />

    <WorkbenchPanel
      class="mb-12"
      eyebrow="库存状态 / INVENTORY"
      title="现有分类"
      caption="安全机制：删除判断使用管理端真实引用数，不复用公开分类计数"
      title-id="category-inventory-title"
    >
      <template #title>
        现有分类
        <span class="text-[var(--fsusblog-text-primary)] tabular-nums">
          {{ list.length }}
        </span>
      </template>
      <template #actions>
        <el-button
          type="primary"
          :icon="Plus"
          @click="openDialog()"
        >
          新增分类
        </el-button>
      </template>
    </WorkbenchPanel>

    <section class="border-t border-[var(--fsusblog-panel-border)]">
      <div class="px-4 py-3 border-b border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg-soft)] flex flex-wrap items-center justify-between gap-3">
        <div class="text-[11px] font-bold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">分类列表 / CATEGORY LIST</div>
        <div class="flex flex-wrap items-center gap-2">
          <el-input
            v-model="filters.keyword"
            class="taxonomy-filter-input"
            clearable
            placeholder="搜索分类"
            aria-label="搜索分类"
            :prefix-icon="Search"
          />
          <el-checkbox v-model="filters.unusedOnly">仅未引用</el-checkbox>
          <el-button text @click="resetFilters">清除筛选</el-button>
        </div>
      </div>
      <el-table
        v-loading="loading"
        :data="filteredList"
        :row-key="getCategoryRowKey"
        >
        <el-table-column v-if="!isCompact" prop="id" label="ID" width="100" align="center">
          <template #default="{ row }: { row: AdminCategoryItemResponse }">
            <span class="tabular-nums">{{ row.id }}</span>
          </template>
        </el-table-column>

        <el-table-column prop="name" label="分类名称" :min-width="nameColumnWidth">
          <template #default="{ row }: { row: AdminCategoryItemResponse }">
            <div class="min-w-0">
              <strong class="font-bold text-[var(--fsusblog-text-secondary)] leading-6">{{ row.name }}</strong>
              <p
                v-if="isCompact && !row.canDelete"
                class="mt-1 text-[11px] leading-5 text-[var(--fsusblog-text-muted)]"
              >
                {{ relationLockReason(row) }}
              </p>
            </div>
          </template>
        </el-table-column>

        <el-table-column
          v-if="!isCompact"
          prop="totalBlockingArticleCount"
          label="真实引用"
          :width="relationColumnWidth"
          align="center"
          sortable
        >
          <template #default="{ row }: { row: AdminCategoryItemResponse }">
            <el-statistic
              :value="row.totalBlockingArticleCount"
            />
            <p class="mt-1 text-[10px] text-[var(--fsusblog-text-muted)]">
              公开 {{ row.publicArticleCount }}
            </p>
          </template>
        </el-table-column>

        <el-table-column label="管理" :width="actionColumnWidth" align="right" :fixed="isCompact ? false : 'right'">
          <template #default="{ row }: { row: AdminCategoryItemResponse }">
            <div class="flex justify-end items-center gap-2 pr-2" :class="{ 'gap-1 pr-0': isCompact }">
              <el-button link type="primary" @click="openDialog(row)">
                <span v-if="!isCompact">编辑</span><el-icon v-else><Edit /></el-icon>
              </el-button>
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
                <span v-if="!isCompact">删除</span><el-icon v-else><Delete /></el-icon>
              </el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <el-dialog
      v-model="dialogVisible"
      :title="dialogTitle"
      width="400px"
      destroy-on-close
      :close-on-click-modal="false"
    >
      <div class="pt-2">
        <el-form :model="form" ref="formRef" :rules="rules" label-position="top" @submit.prevent="submitForm">
          <el-form-item label="分类名称" prop="name">
            <el-input
              v-model="form.name"
              name="categoryName"
              aria-label="分类名称"
              placeholder="请输入 2-20 个字符的名称"
              maxlength="20"
              show-word-limit
              clearable
              :disabled="isProcessing"
              @keyup.enter="submitForm"
            />
          </el-form-item>
        </el-form>
      </div>
      <div class="mt-4 border-t border-[var(--fsusblog-panel-border)] pt-6 flex gap-5 select-none">
        <span class="text-[var(--fsusblog-text-muted)] mt-1">
          <el-icon><InfoFilled /></el-icon>
        </span>
        <p class="text-[12px] text-[var(--fsusblog-text-muted)] leading-relaxed italic">
          变更分类名称会即时同步至主站导航。建议使用通用、简洁的语义词汇。
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
import { type AdminCategoryItemResponse } from '@/api/authoring'
import AccountPageHeader from '@/components/account/AccountPageHeader.vue'
import WorkbenchPanel from '@/components/account/WorkbenchPanel.vue'
import { InfoFilled, Plus, Edit, Lock, Delete, Search, View } from '@/ui/fsusIcons'
import { useAdminCategoryManage } from '@/composables/useAdminCategoryManage'
import { useMediaQuery } from '@/composables/useMediaQuery'

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
} = useAdminCategoryManage()

void formRef

const getCategoryRowKey = (row: AdminCategoryItemResponse): string => String(row.id)
const isCompact = useMediaQuery('(max-width: 639px)')
const nameColumnWidth = computed(() => (isCompact.value ? 148 : 200))
const relationColumnWidth = computed(() => (isCompact.value ? 96 : 150))
const actionColumnWidth = computed(() => (isCompact.value ? 156 : 300))
</script>

<style scoped>

.tabular-nums {
  font-variant-numeric: tabular-nums;
}

.taxonomy-filter-input {
  width: min(15rem, 100%);
}

</style>
