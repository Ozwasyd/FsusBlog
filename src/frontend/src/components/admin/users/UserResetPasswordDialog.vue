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
            placeholder="请输入 10 位以上强密码，禁止任何空白字符"
            show-password
            @update:model-value="emit('update:password', $event)"
          />
          <div class="mt-3 flex flex-wrap items-center gap-3">
            <el-tag size="small" :type="passwordPolicy.level === '强' ? 'success' : passwordPolicy.level === '中' ? 'warning' : 'danger'">
              强度：{{ passwordPolicy.level }}
            </el-tag>
            <span v-if="passwordPolicy.hasWhitespace" class="text-[11px] font-bold text-[var(--fsusblog-color-error)]">包含空白字符</span>
            <span v-if="passwordPolicy.isTooShort" class="text-[11px] font-bold text-[var(--fsusblog-color-warning-text)]">长度不足 10 位</span>
            <span v-if="passwordPolicy.containsUsername" class="text-[11px] font-bold text-[var(--fsusblog-color-error)]">不能包含用户名</span>
          </div>
          <div class="mt-4 flex flex-wrap gap-3">
            <el-button size="small" :disabled="isProcessing" @click="emit('generate-password')">
              生成强密码
            </el-button>
            <el-button size="small" :disabled="isProcessing || !password" @click="emit('copy-password')">
              复制新密码
            </el-button>
          </div>
        </el-form-item>

        <el-form-item label="确认目标用户" required>
          <el-input
            :model-value="confirmUsername"
            name="resetPasswordConfirmUsername"
            :placeholder="`请输入 ${targetUsername} 以确认`"
            autocomplete="off"
            aria-label="输入用户名确认重置密码"
            @update:model-value="emit('update:confirm-username', $event)"
          />
          <div class="mt-3 text-[11px] font-bold text-[var(--fsusblog-text-muted)] normal-case tracking-normal">
            旧密码会立即失效，用户将被强制踢出所有在线会话。
          </div>
        </el-form-item>
      </el-form>
    </div>
    <template #footer>
      <div class="grid grid-cols-2 gap-5 border-t border-[var(--fsusblog-panel-border)] pt-5">
        <el-button :disabled="isProcessing" @click="emit('update:visible', false)">取消</el-button>
        <el-button type="danger" :loading="isProcessing" :disabled="!canSubmit" @click="emit('submit')">
          {{ isCalculating ? '安全校验中...' : '确认重置' }}
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { WarningFilled } from '@/fsusui/icons'

interface Props {
  visible: boolean
  isProcessing: boolean
  isCalculating: boolean
  targetUsername: string
  password: string
  confirmUsername: string
  passwordPolicy: {
    passed: number
    level: string
    hasWhitespace: boolean
    isTooShort: boolean
    containsUsername: boolean
  }
  canSubmit: boolean
}

defineProps<Props>()

const emit = defineEmits<{
  submit: []
  'update:visible': [value: boolean]
  'update:password': [value: string]
  'update:confirm-username': [value: string]
  'generate-password': []
  'copy-password': []
}>()
</script>
