<template>
  <div class="account-page tag-manage-wrapper account-motion-enter w-full">
    <AccountPageHeader
      eyebrow="管理 / TAXONOMY"
      title="标签管理"
      description="维护文章的索引关键词与检索语义。标签变更需要保持可读、简洁。"
    />

    <WorkbenchPanel
      class="mb-12"
      eyebrow="索引规模 / SCALE"
      title="已存标签"
      caption="维护博文索引关键词，高危操作将触发强制算力校验"
      title-id="tag-scale-title"
    >
      <template #title>
        已存标签
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
          创建标签
        </el-button>
      </template>
    </WorkbenchPanel>

    <section class="border-t border-[var(--fsusblog-panel-border)]">
      <div class="px-4 py-3 border-b border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-page-bg-soft)] flex items-center justify-between">
        <div class="text-[11px] font-bold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">标签列表 / TAG LIST</div>
      </div>
      <el-table
        v-loading="loading"
        :data="list"
        :row-key="getTagRowKey"
      >
        <el-table-column
          v-if="!isCompact"
          prop="id"
          label="ID"
          width="100"
          align="center"
        >
          <template #default="{ row }: { row: TagItem }">
            <span class="tabular-nums">{{ row.id }}</span>
          </template>
        </el-table-column>

        <el-table-column prop="name" label="标签名称" :min-width="nameColumnWidth">
          <template #default="{ row }: { row: TagItem }">
            <el-tag type="info">
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
            />
          </template>
        </el-table-column>

        <el-table-column label="管理" :width="actionColumnWidth" align="right">
          <template #default="{ row }: { row: TagItem }">
            <div class="flex justify-end items-center gap-2 pr-2" :class="{ 'gap-1 pr-0': isCompact }">
              <el-button link type="primary" @click="openDialog(row)"> <span>{{ isCompact ? '改名' : '重命名' }}</span></el-button>
              <el-divider direction="vertical" />
              <el-button
                link
                type="danger"
                @click="handleDelete(row)"
              >
                删除
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
import { type TagItem } from '@/api/tag'
import AccountPageHeader from '@/components/account/AccountPageHeader.vue'
import WorkbenchPanel from '@/components/account/WorkbenchPanel.vue'
import { InfoFilled, Plus } from '@/ui/fsusIcons'
import { useAdminTagManage } from '@/composables/useAdminTagManage'
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
} = useAdminTagManage()

void formRef

const getTagRowKey = (row: TagItem): string => String(row.id)

const isCompact = useMediaQuery('(max-width: 639px)')
const nameColumnWidth = computed(() => (isCompact.value ? 148 : 220))
const countColumnWidth = computed(() => (isCompact.value ? 96 : 150))
const actionColumnWidth = computed(() => (isCompact.value ? 104 : 180))
</script>

<style scoped>

.tabular-nums {
  font-variant-numeric: tabular-nums;
}
</style>
