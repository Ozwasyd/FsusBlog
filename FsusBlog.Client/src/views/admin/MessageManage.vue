<template>
  <div class="message-manage-wrapper">
    <el-card shadow="never" class="action-card mb-5 border-none rounded-xl">
      <div class="flex justify-between items-center px-2">
        <div class="header-info">
          <h2 class="text-xl font-bold text-zinc-800 tracking-tight flex items-center gap-2">
            {{ messageView.title }}
            <el-tag size="small" type="primary" effect="dark" class="rounded-full border-none bg-zinc-950 tabular-nums">
              {{ messageView.adminBadge }}
            </el-tag>
          </h2>
          <p class="text-[12px] text-zinc-400 mt-1 italic font-medium">
            {{ messageView.safetyNotice }}
          </p>
        </div>
      </div>
    </el-card>

    <el-row :gutter="20">
      <el-col :md="10" :sm="24">
        <el-card shadow="never" class="border-none rounded-xl p-2 mb-5">
          <el-form ref="formRef" :model="form" :rules="rules" label-position="top" @submit.prevent>
            <el-form-item :label="messageView.modeLabel" for="distribution-mode">
              <el-radio-group v-model="sendType" id="distribution-mode" class="custom-radio" :disabled="isProcessing">
                <el-radio-button
                  v-for="option in messageView.modeOptions"
                  :key="option.value"
                  :value="option.value"
                >
                  {{ option.label }}
                </el-radio-button>
              </el-radio-group>
            </el-form-item>

            <el-form-item v-if="isDirectMode" :label="messageView.targetUserLabel" prop="targetUserId">
              <el-input
                v-model.trim="form.targetUserId"
                :placeholder="messageView.targetUserPlaceholder"
                size="large"
                clearable
                :disabled="isProcessing"
              />
            </el-form-item>

            <el-form-item :label="messageView.titleLabel" prop="title">
              <el-input
                v-model="form.title"
                :placeholder="messageView.titlePlaceholder"
                maxlength="50"
                show-word-limit
                size="large"
                :disabled="isProcessing"
              />
            </el-form-item>

            <el-form-item :label="messageView.contentLabel" prop="content">
              <el-input
                v-model="form.content"
                type="textarea"
                :rows="4"
                :placeholder="messageView.contentPlaceholder"
                resize="none"
                maxlength="2000"
                show-word-limit
                :disabled="isProcessing"
              />
            </el-form-item>

            <el-button
              type="primary"
              class="w-full h-12 rounded-xl font-bold bg-zinc-950 border-none mt-4 transition-all"
              :loading="isProcessing"
              :disabled="isSubmitDisabled"
              @click="submitForm"
            >
              {{ messageView.submitText }}
            </el-button>
          </el-form>
        </el-card>

        <el-card shadow="never" class="border-none rounded-xl p-2">
          <div class="flex justify-between items-center mb-4">
            <h3 class="text-sm font-bold text-zinc-800">{{ messageView.historyTitle }}</h3>
            <el-button
              link
              :icon="Refresh"
              class="outline-none"
              :loading="loadingHistory"
              :aria-label="messageView.historyRefreshLabel"
              @click="fetchHistory"
            />
          </div>
          <div v-loading="loadingHistory" class="history-list min-h-60">
            <template v-if="messageView.history.length > 0">
              <div
                v-for="item in messageView.history"
                :key="item.id"
                class="history-item flex items-center justify-between p-3 mb-2 rounded-lg bg-zinc-50 border border-zinc-100 hover:border-zinc-200 transition-all"
              >
                <div class="flex-1 min-w-0 mr-4">
                  <div class="flex items-center gap-2 mb-1">
                    <span class="text-[10px] px-1.5 py-0.5 rounded bg-zinc-200 text-zinc-600 font-bold scale-90 origin-left select-none">
                      {{ item.categoryLabel }}
                    </span>
                    <span class="text-xs font-bold text-zinc-700 truncate">{{ item.title }}</span>
                  </div>
                  <p class="text-[10px] text-zinc-400 tabular-nums">{{ item.createdAtText }}</p>
                </div>
                <el-popconfirm
                  :title="messageView.revokeConfirmTitle"
                  :confirm-button-text="messageView.revokeConfirmText"
                  :cancel-button-text="messageView.revokeCancelText"
                  width="220"
                  @confirm="handleRevoke(item.id)"
                >
                  <template #reference>
                    <el-button type="danger" link :icon="Delete" :disabled="isProcessing" class="outline-none" />
                  </template>
                </el-popconfirm>
              </div>
            </template>
            <el-empty v-else-if="!loadingHistory" :image-size="40" :description="messageView.historyEmptyDescription" />
          </div>
        </el-card>
      </el-col>

      <el-col :md="14" :sm="24">
        <div class="preview-box h-full flex flex-col justify-center items-center bg-white border border-dashed border-zinc-200 rounded-2xl min-h-125 p-10">
          <div v-if="messageView.preview.isEmpty" class="text-center opacity-20 select-none">
            <el-icon size="64"><ChatLineSquare /></el-icon>
            <p class="text-sm font-bold mt-4 uppercase tracking-widest">{{ messageView.preview.emptyLabel }}</p>
          </div>
          <div v-else class="w-full max-w-md animate-in fade-in zoom-in-95 duration-500">
            <div class="preview-card bg-white p-8 rounded-2xl shadow-[0_20px_50px_rgba(0,0,0,0.05)]">
              <div class="flex justify-between items-center mb-6 select-none">
                <span class="text-[8px] font-black px-2 py-0.5 rounded-sm bg-zinc-950 text-white uppercase tracking-widest">
                  {{ messageView.preview.modeLabel }}
                </span>
                <span v-if="isDirectMode" class="text-[9px] font-mono text-zinc-400">{{ messageView.preview.targetUserText }}</span>
              </div>
              <h4 class="text-base font-bold mb-3 wrap-break-word">{{ messageView.preview.titleText }}</h4>
              <p class="text-xs text-zinc-500 whitespace-pre-wrap wrap-break-word">{{ messageView.preview.contentText }}</p>
            </div>
          </div>
        </div>
      </el-col>
    </el-row>
  </div>
</template>

<script setup lang="ts">
import { ChatLineSquare, Delete, Refresh } from '@element-plus/icons-vue'
import { useAdminMessageCenter } from '@/composables/useAdminMessageCenter'

const {
  formRef,
  loadingHistory,
  isProcessing,
  isDirectMode,
  isSubmitDisabled,
  sendType,
  messageView,
  form,
  rules,
  fetchHistory,
  handleRevoke,
  submitForm
} = useAdminMessageCenter()
</script>

<style scoped>
@reference "@/assets/main.css";

.message-manage-wrapper {
  animation: slide-in 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}

.history-item {
  animation: slide-in 0.3s ease-out;
}

@keyframes slide-in {
  from {
    opacity: 0;
    transform: translateX(-10px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

.preview-card {
  transition: transform 0.2s ease;
}

:deep(.el-radio-button__inner) {
  border-radius: 8px !important;
  margin-right: 8px;
  border: 1px solid #e4e4e7 !important;
  background: #f4f4f5;
  color: #71717a;
}

:deep(.el-radio-button__original-radio:checked + .el-radio-button__inner) {
  background-color: #09090b !important;
  border-color: #09090b !important;
  color: white !important;
  box-shadow: none !important;
}

.wrap-break-word {
  overflow-wrap: break-word;
  word-break: break-word;
}

.tabular-nums {
  font-variant-numeric: tabular-nums;
}
</style>
