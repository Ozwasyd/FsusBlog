<template>
  <div class="account-page category-manage-wrapper w-full">
    <header class="account-page-header">
      <div class="account-page-eyebrow">管理</div>
      <h1 class="account-page-title">分类管理</h1>
      <p class="account-page-description">
        维护主站的目录结构与归档入口。分类变更会即时影响导航组织，因此只保留必要而清晰的操作信息。
      </p>
    </header>

    <section class="admin-page-toolbar mb-6">
      <header class="flex flex-col justify-between gap-6 sm:flex-row sm:items-center">
        <div>
          <h2 class="text-xl font-bold text-[#27272A] flex items-center gap-2">
            分类管理
            <el-tag size="small" type="info" effect="plain" class="rounded-[var(--fsus-radius-full)] border-[#E4E4E7] text-[#A1A1AA] tabular-nums">
              {{ list.length }}
            </el-tag>
          </h2>
          <p class="text-[12px] text-[#A1A1AA] mt-1 italic font-medium">
            <el-icon class="align-middle mr-1"><Management /></el-icon>
            安全机制：仅允许删除关联文章数为 0 的项，变更将即时同步至主站
          </p>
        </div>
        <el-button
          type="primary"
          size="large"
          @click="openDialog()"
          class="px-8 transition-transform active:scale-95"
        >
          <el-icon class="mr-1"><Plus /></el-icon>新增分类
        </el-button>
      </header>
    </section>

    <section class="admin-table-panel">
      <el-table
        v-loading="loading"
        :data="list"
        :row-key="getCategoryRowKey"
        table-layout="fixed"
        class="category-table w-full"
      >
        <el-table-column prop="id" label="ID" width="100" align="center" class-name="font-mono text-[#D4D4D8] hidden-sm-and-down" />

        <el-table-column prop="name" label="分类名称" :min-width="nameColumnWidth">
          <template #default="{ row }: { row: CategoryItem }">
            <strong class="font-bold text-[#3F3F46] leading-6">{{ row.name }}</strong>
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
              :value-style="getArticleCountValueStyle(row.articleCount)"
            />
          </template>
        </el-table-column>

        <el-table-column label="管理" :width="actionColumnWidth" align="right" :fixed="isCompact ? false : 'right'">
          <template #default="{ row }: { row: CategoryItem }">
            <div class="flex justify-end items-center gap-2 pr-2" :class="{ 'gap-1 pr-0': isCompact }">
              <el-button link type="primary" @click="openDialog(row)" class="font-bold">
                <el-icon :class="isCompact ? '' : 'mr-1'"><Edit /></el-icon><span v-if="!isCompact">编辑</span>
              </el-button>
              <el-divider direction="vertical" />

              <el-tooltip
                v-if="row.articleCount > 0"
                content="该分类下仍有博文挂载，系统拦截删除操作"
                placement="top"
              >
                <el-button link type="info" class="font-bold opacity-40 cursor-not-allowed">
                  <el-icon :class="isCompact ? '' : 'mr-1'"><Lock /></el-icon><span v-if="!isCompact">锁定</span>
                </el-button>
              </el-tooltip>
              <el-button
                v-else
                link
                type="danger"
                @click="handleDelete(row)"
                class="font-bold"
              >
                <el-icon :class="isCompact ? '' : 'mr-1'"><Delete /></el-icon><span v-if="!isCompact">删除</span>
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
      append-to-body
      destroy-on-close
      :close-on-click-modal="false"
      class="custom-dialog rounded-[var(--fsus-radius-xl)] overflow-hidden"
    >
      <el-form :model="form" ref="formRef" :rules="rules" label-position="top" class="pt-2" @submit.prevent="submitForm">
        <el-form-item label="分类名称" prop="name">
          <el-input
            v-model="form.name"
            name="categoryName"
            aria-label="分类名称"
            placeholder="请输入 2-20 个字符的名称"
            maxlength="20"
            show-word-limit
            size="large"
            clearable
            :disabled="isProcessing"
            @keyup.enter="submitForm"
          />
        </el-form-item>
      </el-form>
      <div class="mt-4 rounded-[var(--fsus-radius-lg)] border border-[#F4F4F5] bg-[#FCFCFC] p-6 flex gap-5 select-none">
        <el-icon class="text-[#A1A1AA] mt-1"><InfoFilled /></el-icon>
        <p class="text-[11px] text-[#8E8E93] leading-relaxed italic">
          变更分类名称会即时同步至主站导航。建议使用通用、简洁的语义词汇。
        </p>
      </div>
      <template #footer>
        <div class="flex gap-5 px-1">
          <el-button @click="dialogVisible = false" :disabled="isProcessing" class="flex-1 ">取消</el-button>
          <el-button
            type="primary"
            class="flex-1  font-bold shadow-[0_32px_64px_rgba(0,0,0,0.08)]"
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
import { InfoFilled, Management, Plus, Edit, Lock, Delete } from '@element-plus/icons-vue'
import { useAdminCategoryManage } from '@/composables/useAdminCategoryManage'
import { useViewportWidth } from '@/composables/useViewportWidth'

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

const getCategoryRowKey = (row: CategoryItem): string => row.id
const getArticleCountValueStyle = (articleCount: number) => ({
  fontSize: '15px',
  fontWeight: '700',
  color: articleCount > 0 ? '#0F0F11' : '#A1A1AA'
})

const viewportWidth = useViewportWidth()

const isCompact = computed(() => viewportWidth.value < 640)
const nameColumnWidth = computed(() => (isCompact.value ? 148 : 200))
const relationColumnWidth = computed(() => (isCompact.value ? 96 : 150))
const actionColumnWidth = computed(() => (isCompact.value ? 104 : 200))
</script>

<style scoped>

:root {
  --admin-card-border: #f4f4f5;
}

.category-manage-wrapper {
  animation: slide-in 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes slide-in {
  from { opacity: 0; transform: translateY(15px); }
  to { opacity: 1; transform: translateY(0); }
}

:deep(.category-table) {
  --el-table-header-bg-color: rgba(252, 252, 252, 0.96);
  --el-table-header-text-color: #A1A1AA;
  --el-table-row-hover-bg-color: rgba(42, 89, 156, 0.04);
}

:deep(.category-table .el-table__header th) {
  font-size: 0.65rem;
  letter-spacing: 0;
  text-transform: uppercase;
}

:deep(.category-table .el-table__inner-wrapper::before) {
  display: none;
}

.tabular-nums {
  font-variant-numeric: tabular-nums;
}

@media (max-width: 640px) {
  :deep(.hidden-sm-and-down) {
    display: none !important;
  }
}

.el-button:active {
  transform: scale(0.97);
}

.custom-dialog :deep(.el-dialog__header) {
  padding-bottom: 20px;
  border-bottom: 1px solid var(--admin-card-border);
  margin-right: 0;
}

.custom-dialog :deep(.el-dialog__footer) {
  padding-top: 20px;
  border-top: 1px solid var(--admin-card-border);
}
</style>
