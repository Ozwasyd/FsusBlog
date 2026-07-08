<template>
  <FsusDialog
    :model-value="visible"
    title="账号封禁处理"
    width="min(92vw, 28rem)"
    @update:model-value="emit('update:visible', $event)"
  >
    <div class="pt-6 pb-2">
      <div class="mb-8 flex items-center gap-6 rounded-[var(--fsus-radius-popover)] border border-[var(--fsusblog-panel-border)] bg-[var(--fsusblog-panel-bg)]/80 p-5">
        <el-avatar :size="40">{{ targetInitials }}</el-avatar>
        <div class="min-w-0">
          <span class="block truncate text-base font-bold text-[var(--fsusblog-text-secondary)]">{{ targetAccountLabel }}</span>
          <span class="mt-1 block text-[11px] font-bold text-[var(--fsusblog-color-warning-text)] normal-case tracking-normal">
            当前封禁为永久封禁，需要管理员手动解封。
          </span>
        </div>
      </div>

      <div class="admin-muted-alert admin-muted-alert--warning mb-8 p-5 text-[12px] leading-relaxed">
        <p class="font-bold mb-2">封禁影响</p>
        <p>账号容器将无法登录，当前在线会话将失效，封禁原因将展示给账号持有者，并写入审计日志。</p>
      </div>

      <el-form label-position="top">
        <el-form-item label="封禁原因 (将公示给账号持有者)">
          <div class="w-full">
            <el-select
              :model-value="reason"
              aria-label="封禁原因"
              placeholder="请选择或输入理由"
              allow-create
              filterable
              maxlength="100"
              @update:model-value="emit('update:reason', $event)"
            >
              <el-option v-for="item in quickReasons" :key="item" :label="item" :value="item" />
            </el-select>
            <div class="mt-3 space-y-2 text-[11px] font-bold normal-case tracking-normal">
              <p class="text-[var(--fsusblog-text-muted)]">账号持有者可见文案预览：{{ validation.preview }}</p>
              <p v-if="validation.isTooLong || validation.hasUnsafeChars" class="text-[var(--fsusblog-color-error)]">
                原因过长或包含危险字符。
              </p>
            </div>
          </div>
        </el-form-item>

        <el-form-item label="确认目标账号" required>
          <el-input
            :model-value="confirmAccountLabel"
            name="banConfirmAccountLabel"
            :placeholder="`请输入 ${targetAccountLabel} 以确认`"
            autocomplete="off"
            aria-label="输入账号标识确认封禁"
            @update:model-value="emit('update:confirm-account-label', $event)"
          />
        </el-form-item>
      </el-form>
    </div>
    <template #footer>
      <div class="grid grid-cols-2 gap-6">
        <el-button :disabled="isProcessing" @click="emit('update:visible', false)">取消</el-button>
        <el-button type="danger" :loading="isProcessing" :disabled="!canSubmit" @click="emit('submit')">
          {{ isCalculating ? '安全校验中...' : '确认封禁' }}
        </el-button>
      </div>
    </template>
  </FsusDialog>
</template>

<script setup lang="ts">
import FsusDialog from '@/components/ui/FsusDialog.vue'

interface Props {
  visible: boolean
  reason: string
  quickReasons: readonly string[]
  isProcessing: boolean
  isCalculating: boolean
  targetAccountLabel: string
  targetInitials: string
  confirmAccountLabel: string
  validation: {
    isEmpty: boolean
    isTooLong: boolean
    hasUnsafeChars: boolean
    preview: string
  }
  canSubmit: boolean
}

defineProps<Props>()

const emit = defineEmits<{
  submit: []
  'update:visible': [value: boolean]
  'update:reason': [value: string]
  'update:confirm-account-label': [value: string]
}>()
</script>
