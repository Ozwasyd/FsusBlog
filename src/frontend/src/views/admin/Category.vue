<template>
  <div class="account-page category-manage-wrapper w-full">
    <header class="account-page-header">
      <div class="account-page-eyebrow">管理 / STRUCTURE</div>
      <h1 class="account-page-title">分类管理</h1>
      <p class="account-page-description">
        维护主站的目录结构与归档入口。分类变更会即时影响导航组织，因此只保留必要而清晰的操作信息。
      </p>
    </header>

    <section class="border-y border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg)] py-8 px-4 mb-12">
      <header class="flex flex-col justify-between gap-6 sm:flex-row sm:items-center">
        <div>
          <div class="text-[10px] font-bold normal-case tracking-normal text-[var(--fsusblog-text-muted)] mb-4">库存状态 / INVENTORY</div>
          <h2 class="text-2xl font-bold text-[var(--fsusblog-text-primary)] flex items-center gap-3">
            现有分类
            <span class="text-[var(--fsusblog-text-primary)] tabular-nums">
              {{ list.length }}
            </span>
          </h2>
          <p class="text-[11px] text-[var(--fsusblog-text-tertiary)] mt-4 italic font-medium">
            安全机制：仅允许删除关联文章数为 0 的项，变更将即时同步至主站
          </p>
        </div>
        <el-button
          type="primary"
          :icon="Plus"
          @click="openDialog()"
        >
          新增分类
        </el-button>
      </header>
    </section>

    <section class="border-t border-[var(--fsusblog-panel-border)]">
      <div class="px-4 py-3 border-b border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg-soft)] flex items-center justify-between">
        <div class="text-[10px] font-bold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">分类列表 / CATEGORY LIST</div>
      </div>
      <el-table
        v-loading="loading"
        :data="list"
        :row-key="getCategoryRowKey"
        >
        <el-table-column v-if="!isCompact" prop="id" label="ID" width="100" align="center">
          <template #default="{ row }: { row: CategoryItem }">
            <span class="tabular-nums">{{ row.id }}</span>
          </template>
        </el-table-column>

        <el-table-column prop="name" label="分类名称" :min-width="nameColumnWidth">
          <template #default="{ row }: { row: CategoryItem }">
            <strong class="font-bold text-[var(--fsusblog-text-secondary)] leading-6">{{ row.name }}</strong>
          </template>
        </el-table-column>

        <el-table-column
          v-if="!isCompact"
          prop="articleCount"
          label="关联文章"
          :width="relationColumnWidth"
          align="center"
          sortable
        >
          <template #default="{ row }: { row: CategoryItem }">
            <el-statistic
              :value="row.articleCount"
            />
          </template>
        </el-table-column>

        <el-table-column label="管理" :width="actionColumnWidth" align="right" :fixed="isCompact ? false : 'right'">
          <template #default="{ row }: { row: CategoryItem }">
            <div class="flex justify-end items-center gap-2 pr-2" :class="{ 'gap-1 pr-0': isCompact }">
              <el-button link type="primary" @click="openDialog(row)">
                <span v-if="!isCompact">编辑</span><el-icon v-else><Edit /></el-icon>
              </el-button>
              <el-divider direction="vertical" />

              <el-tooltip
                v-if="row.articleCount > 0"
                content="该分类下仍有博文挂载，系统拦截删除操作"
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
        <p class="text-[11px] text-[var(--fsusblog-text-muted)] leading-relaxed italic">
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
import { type CategoryItem } from '@/api/category'
import { InfoFilled, Plus, Edit, Lock, Delete } from '@/ui/fsusIcons'
import { useAdminCategoryManage } from '@/composables/useAdminCategoryManage'
import { useMediaQuery } from '@/composables/useMediaQuery'

const {
  list,
  loading,
  dialogVisible,
  dialogTitle,
  submitButtonText,
  formRef,
  isProcessing,
  form,
  rules,
  openDialog,
  submitForm,
  handleDelete
} = useAdminCategoryManage()

void formRef

const getCategoryRowKey = (row: CategoryItem): string => String(row.id)
const isCompact = useMediaQuery('(max-width: 639px)')
const nameColumnWidth = computed(() => (isCompact.value ? 148 : 200))
const relationColumnWidth = computed(() => (isCompact.value ? 96 : 150))
const actionColumnWidth = computed(() => (isCompact.value ? 104 : 200))
</script>

<style scoped>

.category-manage-wrapper {
  animation: slide-in var(--fsus-motion-panel) var(--fsus-motion-standard);
}

@keyframes slide-in {
  from { opacity: 0; transform: translateY(15px); }
  to { opacity: 1; transform: translateY(0); }
}

.tabular-nums {
  font-variant-numeric: tabular-nums;
}

</style>
