<template>
  <div class="account-page tag-manage-wrapper w-full">
    <header class="account-page-header">
      <div class="account-page-eyebrow">管理</div>
      <h1 class="account-page-title">标签管理</h1>
      <p class="account-page-description">
        维护文章的索引关键词与检索语义。标签变更需要保持可读、简洁。
      </p>
    </header>

    <section class="admin-page-toolbar mb-6">
      <header class="flex flex-col justify-between gap-6 sm:flex-row sm:items-center">
        <div>
          <h2 class="text-xl font-bold text-[#27272A] flex items-center gap-2">
            标签管理
            <el-tag size="small" type="info" effect="plain" class="rounded-[var(--fsus-radius-full)] border-[#E4E4E7] text-[#A1A1AA] tabular-nums">
              {{ list.length }}
            </el-tag>
          </h2>
          <p class="text-[12px] text-[#A1A1AA] mt-1 italic font-medium">
            维护博文索引关键词，高危操作将触发强制算力校验
          </p>
        </div>
        <el-button
          type="primary"
          size="large"
          @click="openDialog()"
          class="px-8 transition-transform active:scale-95"
        >
          <el-icon class="mr-1"><Plus /></el-icon>创建标签
        </el-button>
      </header>
    </section>

    <section class="admin-table-panel">
      <!-- 表格区域 -->
      <el-table
        v-loading="loading"
        :data="list"
        :row-key="getTagRowKey"
        class="tag-table w-full"
      >
        <el-table-column
          prop="id"
          label="ID"
          width="100"
          align="center"
          class-name="font-mono text-[#D4D4D8] hidden-sm-and-down"
        />

        <el-table-column prop="name" label="标签名称" :min-width="nameColumnWidth">
          <template #default="{ row }: { row: TagItem }">
            <el-tag size="default" type="info" effect="plain" class="font-bold rounded-[8px] border-[#E4E4E7] bg-[#FCFCFC] text-[#3F3F46]">
              # {{ row.name }}
            </el-tag>
          </template>
        </el-table-column>

        <el-table-column
          v-if="!isCompact"
          prop="articleCount"
          label="引用次数"
          :width="countColumnWidth"
          align="center"
          sortable
        >
          <template #default="{ row }: { row: TagItem }">
            <el-statistic
              :value="row.articleCount"
              :value-style="{ fontSize: '14px', fontWeight: '600', color: '#8E8E93' }"
            />
          </template>
        </el-table-column>

        <el-table-column label="管理" :width="actionColumnWidth" align="right">
          <template #default="{ row }: { row: TagItem }">
            <div class="flex justify-end items-center gap-2 pr-2" :class="{ 'gap-1 pr-0': isCompact }">
              <el-button link type="primary" @click="openDialog(row)" class="font-bold"> <span>{{ isCompact ? '改名' : '重命名' }}</span></el-button>
              <el-divider direction="vertical" />
              <el-button
                link
                type="danger"
                @click="handleDelete(row)"
                class="font-bold outline-none focus-visible:ring-1 focus-visible:ring-[#E5484D] rounded-[var(--fsus-radius-sm)]"
              >
                {{ isCompact ? '删' : '销毁' }}
              </el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <!-- 对话框 -->
    <el-dialog
      v-model="dialogVisible"
      :title="dialogTitle"
      width="380px"
      append-to-body
      destroy-on-close
      :close-on-click-modal="false"
      class="custom-dialog rounded-[var(--fsus-radius-xl)]"
    >
      <el-form :model="form" ref="formRef" :rules="rules" class="pt-2" @submit.prevent="submitForm">
        <el-form-item prop="name">
          <el-input
            v-model="form.name"
            name="tagName"
            aria-label="标签名称"
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
      <div class="mt-4 rounded-[var(--fsus-radius-lg)] border border-[#F4F4F5] bg-[#FCFCFC] p-5 flex gap-2 select-none">
        <el-icon class="text-[#A1A1AA] mt-1"><InfoFilled /></el-icon>
        <p class="text-[11px] text-[#8E8E93] leading-relaxed">
          变更标签名会即时同步至所有关联博文。建议使用简洁、具有高辨识度的词汇。
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
import { type TagItem } from '@/api/tag'
import { InfoFilled, Plus } from '@element-plus/icons-vue'
import { useAdminTagManage } from '@/composables/useAdminTagManage'
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
} = useAdminTagManage()

const getTagRowKey = (row: TagItem): string => row.id

const viewportWidth = useViewportWidth()

const isCompact = computed(() => viewportWidth.value < 640)
const nameColumnWidth = computed(() => (isCompact.value ? 148 : 220))
const countColumnWidth = computed(() => (isCompact.value ? 96 : 150))
const actionColumnWidth = computed(() => (isCompact.value ? 104 : 180))
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
  --el-table-header-bg-color: rgba(252, 252, 252, 0.96);
  --el-table-header-text-color: #A1A1AA;
  --el-table-row-hover-bg-color: rgba(42, 89, 156, 0.04);
}

:deep(.tag-table .el-table__header th) {
  font-size: 0.65rem;
  letter-spacing: 0;
  text-transform: uppercase;
}

:deep(.tag-table .el-table__inner-wrapper::before) {
  display: none;
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
