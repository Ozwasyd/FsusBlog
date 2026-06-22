<template>
  <el-dialog
    :model-value="visible"
    :title="'安全校验'"
    width="min(92vw, 24rem)"
    destroy-on-close
    :show-close="false"
    @update:model-value="(val: boolean) => !val && handleCancel()"
  >
    <p class="text-sm text-[var(--fsusblog-text-muted)] leading-relaxed mb-6">
      {{ description || '请输入 Google Authenticator 6 位验证码，或使用恢复码继续。' }}
    </p>

    <div class="space-y-4">
      <div>
        <label for="mfa-challenge-code" class="block text-[11px] font-bold tracking-normal text-[var(--fsusblog-text-muted)] normal-case mb-2">验证码</label>
        <el-input
          id="mfa-challenge-code"
          ref="codeInput"
          v-model="code"
          type="text"
          autocomplete="one-time-code"
          inputmode="numeric"
          placeholder="6 位验证码"
          :disabled="loading"
          @keyup.enter="handleConfirm"
        />
      </div>

      <div>
        <label for="mfa-challenge-recovery-code" class="block text-[11px] font-bold tracking-normal text-[var(--fsusblog-text-muted)] normal-case mb-2">恢复码(可选)</label>
        <el-input
          id="mfa-challenge-recovery-code"
          v-model="recoveryCode"
          type="text"
          autocomplete="one-time-code"
          placeholder="恢复码"
          :disabled="loading"
          @keyup.enter="handleConfirm"
        />
      </div>
    </div>

    <div v-if="errorMessage" role="alert" class="mt-4 text-[11px] font-medium text-[var(--fsusblog-color-error)]">
      {{ errorMessage }}
    </div>

    <template #footer>
      <div class="dialog-footer flex justify-end gap-5 mt-4">
        <el-button @click="handleCancel" :disabled="loading">取消</el-button>
        <el-button
          type="primary"
          :disabled="loading || (!code.trim() && !recoveryCode.trim())"
          @click="handleConfirm"
          :loading="loading"
        >
          {{ loading ? '验证中...' : '验证' }}
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  visible: boolean
  loading?: boolean
  description?: string
  errorMessage?: string
}>(), {
  loading: false,
  description: '',
  errorMessage: ''
})

const emit = defineEmits<{
  'update:visible': [value: boolean]
  confirm: [payload: { code?: string; recoveryCode?: string }]
  cancel: []
}>()

const code = ref('')
const recoveryCode = ref('')
const codeInput = ref<any>(null)

const handleCancel = () => {
  emit('update:visible', false)
  emit('cancel')
}

const handleConfirm = () => {
  emit('confirm', {
    code: code.value.trim() || undefined,
    recoveryCode: recoveryCode.value.trim() || undefined
  })
}

watch(
  () => props.visible,
  async (visible) => {
    if (!visible) {
      code.value = ''
      recoveryCode.value = ''
      return
    }
    await nextTick()
    codeInput.value?.focus()
  }
)
</script>
