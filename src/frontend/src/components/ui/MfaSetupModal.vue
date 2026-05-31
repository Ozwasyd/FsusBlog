<template>
  <el-dialog
    :model-value="visible"
    title="MFA 绑定"
    width="520px"
    destroy-on-close
    :show-close="false"
    @update:model-value="val => !val && close()"
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
          @update:model-value="val => emit('update:setupCode', String(val))"
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
import { computed } from 'vue'
import QrcodeVue from 'qrcode.vue'

const props = defineProps<{
  visible: boolean
  loading: boolean
  secret: string
  otpAuthUrl: string
  setupCode: string
  recoveryCodes: string[]
  errorMessage: string
}>()

const emit = defineEmits<{
  'update:visible': [value: boolean]
  'update:setupCode': [value: string]
  verify: []
}>()

const close = () => {
  emit('update:visible', false)
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
