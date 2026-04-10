<template>
  <div class="category-manage-wrapper">
    <el-card shadow="never" class="action-card mb-5 border-none rounded-xl">
      <div class="flex justify-between items-center px-2">
        <div class="header-info">
          <h2 class="text-xl font-bold text-zinc-800 tracking-tight flex items-center gap-2">
            分类管理
            <el-tag size="small" type="info" effect="plain" class="rounded-full border-zinc-200 text-zinc-400 tabular-nums">
              {{ list.length }}
            </el-tag>
          </h2>
          <p class="text-[12px] text-zinc-400 mt-1 italic font-medium">
            <el-icon class="align-middle mr-1"><Management /></el-icon>
            安全机制：仅允许删除关联文章数为 0 的项，变更将即时同步至主站
          </p>
        </div>
        <el-button 
          type="primary" 
          size="large" 
          @click="openDialog()" 
          class="px-8 shadow-lg shadow-blue-50 transition-transform active:scale-95"
        >
          <el-icon class="mr-1"><Plus /></el-icon>新增分类
        </el-button>
      </div>
    </el-card>

    <el-card shadow="never" class="list-card border-none rounded-xl overflow-hidden">
      <!-- 渲染模型：视为只读列表，由后端权威数据驱动 -->
      <el-table 
        v-loading="loading" 
        :data="list" 
        :row-key="getCategoryRowKey"
        stripe 
        table-layout="fixed"
        class="category-table w-full"
      >
        <el-table-column prop="id" label="ID" width="100" align="center" class-name="font-mono text-zinc-300 hidden-sm-and-down" />
        
        <el-table-column prop="name" label="分类名称" min-width="200">
          <template #default="{ row }: { row: CategoryItem }">
            <span class="font-bold text-zinc-700 leading-6">{{ row.name }}</span>
          </template>
        </el-table-column>

        <el-table-column 
          prop="articleCount" 
          label="关联文章" 
          width="150" 
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

        <el-table-column label="管理" width="200" align="right" fixed="right">
          <template #default="{ row }: { row: CategoryItem }">
            <div class="flex justify-end items-center gap-2 pr-2">
              <!-- 统一图标组件渲染方式 -->
              <el-button link type="primary" @click="openDialog(row)" class="font-bold">
                <el-icon class="mr-1"><Edit /></el-icon>编辑
              </el-button>
              <el-divider direction="vertical" />
              
              <el-tooltip 
                v-if="row.articleCount > 0" 
                content="该分类下仍有博文挂载，系统拦截删除操作" 
                placement="top"
              >
                <el-button link type="info" class="font-bold opacity-40 cursor-not-allowed">
                  <el-icon class="mr-1"><Lock /></el-icon>锁定
                </el-button>
              </el-tooltip>
              <el-button 
                v-else 
                link 
                type="danger" 
                @click="handleDelete(row)" 
                class="font-bold"
              >
                <el-icon class="mr-1"><Delete /></el-icon>删除
              </el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog 
      v-model="dialogVisible" 
      :title="dialogTitle" 
      width="400px"
      append-to-body
      destroy-on-close
      :close-on-click-modal="false"
      class="custom-dialog rounded-2xl overflow-hidden"
    >
      <div class="dialog-body pt-2">
        <el-form :model="form" ref="formRef" :rules="rules" label-position="top" @submit.prevent="submitForm">
          <el-form-item label="分类名称" prop="name">
            <el-input 
              v-model="form.name" 
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
        <div class="mt-4 p-4 bg-zinc-50 rounded-xl border border-zinc-100 flex gap-3 select-none">
          <el-icon class="text-zinc-400 mt-1"><InfoFilled /></el-icon>
          <p class="text-[11px] text-zinc-500 leading-relaxed italic">
            变更分类名称会即时同步至主站导航。建议使用通用、简洁的语义词汇。
          </p>
        </div>
      </div>
      <template #footer>
        <div class="flex gap-3 px-1">
          <el-button @click="dialogVisible = false" :disabled="isProcessing" class="flex-1 rounded-xl">取消</el-button>
          <el-button 
            type="primary" 
            class="flex-1 rounded-xl font-bold shadow-md shadow-blue-50" 
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
import { type CategoryItem } from '@/api/category'
import { InfoFilled, Management, Plus, Edit, Lock, Delete } from '@element-plus/icons-vue'
import { useAdminCategoryManage } from '@/composables/useAdminCategoryManage'

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
  color: articleCount > 0 ? '#3b82f6' : '#94a3b8'
})
</script>

<style scoped>
/* 统一样式令牌提取 */
:root {
  --admin-card-border: #f4f4f5; /* zinc-100 */
}

.category-manage-wrapper {
  animation: slide-in 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes slide-in {
  from { opacity: 0; transform: translateY(15px); }
  to { opacity: 1; transform: translateY(0); }
}

:deep(.category-table) {
  --el-table-header-bg-color: #fafafa;
  --el-table-header-text-color: #64748b;
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
