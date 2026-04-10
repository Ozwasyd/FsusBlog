<template>
  <div class="tag-manage-wrapper">
    <!-- 头部操作面板 -->
    <el-card shadow="never" class="action-card mb-5 border-none rounded-xl">
      <div class="flex justify-between items-center px-2">
        <div class="header-info">
          <h2 class="text-xl font-bold text-zinc-800 tracking-tight flex items-center gap-2">
            标签管理
            <el-tag size="small" type="info" effect="plain" class="rounded-full border-zinc-200 text-zinc-400 tabular-nums">
              {{ list.length }}
            </el-tag>
          </h2>
          <p class="text-[12px] text-zinc-400 mt-1 italic font-medium">
            维护博文索引关键词，高危操作将触发强制算力校验
          </p>
        </div>
        <el-button 
          type="primary" 
          size="large" 
          @click="openDialog()" 
          class="px-8 shadow-lg shadow-blue-50 transition-transform active:scale-95"
        >
          <el-icon class="mr-1"><Plus /></el-icon>创建标签
        </el-button>
      </div>
    </el-card>

    <el-card shadow="never" class="list-card border-none rounded-xl overflow-hidden">
      <!-- 表格区域 -->
      <el-table 
        v-loading="loading" 
        :data="list" 
        :row-key="getTagRowKey"
        stripe 
        class="tag-table w-full"
      >
        <el-table-column 
          prop="id" 
          label="ID" 
          width="100" 
          align="center" 
          class-name="font-mono text-zinc-300 hidden-sm-and-down" 
        />
        
        <el-table-column prop="name" label="标签名称">
          <template #default="{ row }: { row: TagItem }">
            <el-tag 
              size="default" 
              type="primary" 
              effect="plain" 
              class="font-bold rounded-lg border-blue-100 bg-blue-50/40 text-blue-600"
            >
              # {{ row.name }}
            </el-tag>
          </template>
        </el-table-column>

        <el-table-column 
          prop="articleCount" 
          label="引用次数" 
          width="150" 
          align="center" 
          sortable
        >
          <template #default="{ row }: { row: TagItem }">
            <el-statistic 
              :value="row.articleCount" 
              :value-style="{ fontSize: '14px', fontWeight: '600', color: '#64748b' }" 
            />
          </template>
        </el-table-column>

        <el-table-column label="管理" width="180" align="right">
          <template #default="{ row }: { row: TagItem }">
            <div class="flex justify-end items-center gap-2 pr-2">
              <el-button link type="primary" @click="openDialog(row)" class="font-bold">重命名</el-button>
              <el-divider direction="vertical" />
              <el-button 
                link 
                type="danger" 
                @click="handleDelete(row)" 
                class="font-bold outline-none focus-visible:ring-1 focus-visible:ring-red-500 rounded-sm"
              >
                销毁
              </el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 对话框 -->
    <el-dialog 
      v-model="dialogVisible" 
      :title="dialogTitle" 
      width="380px"
      append-to-body
      destroy-on-close
      :close-on-click-modal="false"
      class="custom-dialog rounded-2xl"
    >
      <div class="dialog-body pt-2">
        <el-form :model="form" ref="formRef" :rules="rules" @submit.prevent="submitForm">
          <el-form-item 
            prop="name" 
          >
            <el-input 
              v-model="form.name" 
              placeholder="标签名称（如：Vue3）" 
              maxlength="20"
              show-word-limit
              size="large"
              clearable
              :disabled="isProcessing"
              @keyup.enter="submitForm"
            />
          </el-form-item>
        </el-form>
        <div class="mt-4 p-3 bg-zinc-50 rounded-xl border border-zinc-100 flex gap-2 select-none">
          <el-icon class="text-zinc-400 mt-1"><InfoFilled /></el-icon>
          <p class="text-[11px] text-zinc-500 leading-relaxed">
            变更标签名会即时同步至所有关联博文。建议使用简洁、具有高辨识度的词汇。
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
import { type TagItem } from '@/api/tag'
import { InfoFilled, Plus } from '@element-plus/icons-vue'
import { useAdminTagManage } from '@/composables/useAdminTagManage'

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
} = useAdminTagManage()

const getTagRowKey = (row: TagItem): string => row.id
</script>

<style scoped>
.tag-manage-wrapper {
  animation: slide-in 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes slide-in {
  from { opacity: 0; transform: translateY(15px); }
  to { opacity: 1; transform: translateY(0); }
}

:deep(.tag-table) {
  --el-table-header-bg-color: #fafafa;
  --el-table-header-text-color: #475569;
}

@media (max-width: 640px) {
  :deep(.hidden-sm-and-down) {
    display: none !important;
  }
}

.el-button:active {
  transform: scale(0.97);
}

.tabular-nums {
  font-variant-numeric: tabular-nums;
}
</style>
