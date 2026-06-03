<template>
  <el-dialog
    :model-value="visible"
    :title="title"
    width="520px"
    destroy-on-close
    :show-close="false"
    @update:model-value="(val: boolean) => !val && close()"
  >
    <p class="sr-only" role="status" aria-live="polite">{{ setupStepStatusText }}</p>

    <p class="text-sm text-[var(--fsusblog-text-muted)] leading-relaxed mb-5">
      1) 使用认证器 App（如 Google Authenticator）扫描下方二维码。2) 输入 6 位验证码完成绑定。
    </p>

    <div class="space-y-6">
      <!-- 二维码区域 -->
      <div v-if="otpAuthUrl && !recoveryCodes.length" class="flex flex-col items-center py-4">
        <div class="p-4 bg-[var(--fsusblog-panel-bg)] rounded-[var(--fsus-radius-popover)] border border-[var(--fsusblog-panel-border)] shadow-none">
          <qrcode-vue
            :value="otpAuthUrl"
            :size="160"
            level="H"
            render-as="svg"
            foreground="var(--fsusblog-text-primary)"
          />
        </div>
        <div class="mt-4 text-[11px] font-bold text-[var(--fsusblog-text-muted)] normal-case tracking-normal">扫描二维码绑定</div>
      </div>

      <div>
        <div class="text-[11px] font-semibold text-[var(--fsusblog-text-secondary)] mb-1 normal-case tracking-normal">手动密钥 (Manual Entry)</div>
        <div class="px-3 py-2 bg-[var(--fsusblog-panel-bg)] border border-[var(--fsusblog-panel-border)] rounded-[var(--fsus-radius-control)] text-[12px] tabular-nums text-[var(--fsusblog-text-secondary)] break-all">{{ secret || '-' }}</div>
      </div>

      <a
        v-if="otpAuthUrl"
        :href="otpAuthUrl"
        class="inline-flex text-[11px] font-bold normal-case tracking-normal text-[var(--fsusblog-text-secondary)] hover:text-[var(--fsusblog-color-primary)] transition-colors border-b border-current pb-0.5"
      >
        在 App 中直接打开
      </a>

      <div v-if="!recoveryCodes.length">
        <label for="mfa-setup-code" class="block text-[11px] font-bold tracking-normal text-[var(--fsusblog-text-muted)] normal-case mb-2">验证码</label>
        <el-input
          id="mfa-setup-code"
          :model-value="setupCode"
          @update:model-value="(val: string | number) => emit('update:setupCode', String(val))"
          type="text"
          autocomplete="one-time-code"
          inputmode="numeric"
          placeholder="6 位验证码"
          :disabled="loading"
          @keyup.enter="$emit('verify')"
        />
      </div>

      <div v-else>
        <div class="text-[11px] font-semibold text-[var(--fsusblog-text-secondary)] mb-2">恢复码（仅显示一次）</div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div
            v-for="code in recoveryCodes"
            :key="code"
            class="px-3 py-2 bg-[var(--fsusblog-panel-bg)] border border-[var(--fsusblog-panel-border)] rounded-[var(--fsus-radius-control)] text-[12px] tabular-nums text-[var(--fsusblog-text-secondary)]"
          >
            {{ code }}
          </div>
        </div>
        <div class="mt-4 flex flex-wrap gap-3">
          <el-button size="small" @click="copyRecoveryCodes">复制恢复码</el-button>
          <el-button size="small" @click="downloadRecoveryCodes">下载恢复码</el-button>
        </div>
        <el-checkbox v-model="recoveryCodesAcknowledged" class="mt-4">
          我已保存恢复码
        </el-checkbox>
      </div>
    </div>

    <div v-if="errorMessage" role="alert" class="mt-4 text-[11px] font-medium text-[var(--fsusblog-color-error)]">{{ errorMessage }}</div>

    <template #footer>
      <div class="dialog-footer flex justify-end gap-5 mt-4">
        <el-button @click="close" :disabled="loading">
          {{ recoveryCodes.length ? '完成' : '取消' }}
        </el-button>
        <el-button
          v-if="!recoveryCodes.length"
          type="primary"
          :disabled="loading || !setupCode.trim()"
          @click="$emit('verify')"
          :loading="loading"
        >
          {{ loading ? '验证中...' : '完成绑定' }}
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import QrcodeVue from 'qrcode.vue'
import { toast } from '@/fsusui/feedback'

const props = withDefaults(defineProps<{
  visible: boolean
  title?: string
  loading: boolean
  secret: string
  otpAuthUrl: string
  setupCode: string
  recoveryCodes: string[]
  errorMessage: string
}>(), {
  title: 'MFA 绑定'
})

const emit = defineEmits<{
  'update:visible': [value: boolean]
  'update:setupCode': [value: string]
  verify: []
}>()

const recoveryCodesAcknowledged = ref(false)
const recoveryCodesText = computed(() => props.recoveryCodes.join('\n'))

watch(recoveryCodesText, () => {
  recoveryCodesAcknowledged.value = false
})

const close = () => {
  if (props.recoveryCodes.length > 0 && !recoveryCodesAcknowledged.value) {
    toast.warning('请先确认已保存恢复码')
    return
  }

  emit('update:visible', false)
}

const copyRecoveryCodes = async (): Promise<void> => {
  try {
    await navigator.clipboard.writeText(recoveryCodesText.value)
    toast.success('恢复码已复制')
  } catch {
    toast.error('复制失败，请手动保存恢复码')
  }
}

const downloadRecoveryCodes = (): void => {
  const blob = new Blob([`${recoveryCodesText.value}\n`], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `fsusblog-recovery-codes-${new Date().toISOString().slice(0, 10)}.txt`
  anchor.rel = 'noopener'
  anchor.click()
  URL.revokeObjectURL(url)
  toast.success('恢复码已下载')
}

const setupStepStatusText = computed(() => {
  if (props.recoveryCodes.length > 0) {
    return 'MFA 绑定完成，请保存恢复码'
  }

  if (props.loading) {
    return 'MFA 绑定流程正在处理'
  }

  if (props.otpAuthUrl) {
    return 'MFA 绑定步骤，扫描二维码或输入手动密钥后填写验证码'
  }

  return '正在准备 MFA 绑定信息'
})
</script>
