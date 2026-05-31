<template>
  <el-dialog
    :model-value="visible"
    title="高危操作：强制重置密码"
    width="min(90vw, 420px)"
    @update:model-value="emit('update:visible', $event)"
  >
    <div class="pt-1">
      <div class="mb-6 flex gap-5 rounded-[var(--fsus-radius-popover)] border border-[var(--fsusblog-color-error-border)] bg-[var(--fsusblog-color-error-bg)]/70 p-5">
        <span class="text-[var(--fsusblog-color-error)] mt-0.5 shrink-0">
          <el-icon><WarningFilled /></el-icon>
        </span>
        <div class="text-[12px] text-[var(--fsusblog-color-error)] leading-relaxed">
          <p class="font-bold mb-1">警告：该操作将记录审计日志</p>
          <p>重置后，用户 <span class="font-bold underline">{{ targetUsername }}</span> 将被强制踢出所有在线会话。</p>
        </div>
      </div>

      <el-form @submit.prevent="emit('submit')" label-position="top">
        <el-form-item label="设置新登录密码" required>
          <el-input
            :model-value="password"
            name="resetPassword"
            type="password"
            autocomplete="new-password"
            aria-label="设置新登录密码"
            placeholder="请输入 6 位以上密码，禁止使用空格"
            show-password
            @update:model-value="emit('update:password', $event)"
          />
        </el-form-item>
      </el-form>
    </div>
    <template #footer>
      <div class="grid grid-cols-2 gap-5 border-t border-[var(--fsusblog-panel-border)] pt-5">
        <el-button :disabled="isProcessing" @click="emit('update:visible', false)">取消</el-button>
        <el-button type="danger" :loading="isProcessing" @click="emit('submit')">
          {{ isCalculating ? '安全校验中...' : '确认重置' }}
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { WarningFilled } from '@/ui/fsusIcons'

interface Props {
  visible: boolean
  isProcessing: boolean
  isCalculating: boolean
  targetUsername: string
  password: string
}

defineProps<Props>()

const emit = defineEmits<{
  submit: []
  'update:visible': [value: boolean]
  'update:password': [value: string]
}>()
</script>
