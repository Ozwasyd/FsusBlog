<template>
  <el-dialog
    :model-value="visible"
    :title="title || '安全校验'"
    width="400px"
    destroy-on-close
    :show-close="false"
    @update:model-value="val => !val && handleCancel()"
  >
    <p class="text-sm text-[var(--fsusblog-text-muted)] leading-relaxed mb-6">
      {{ description || '请输入当前密码和验证信息继续。' }}
    </p>

    <div class="space-y-4">
      <div>
        <label class="block text-[10px] font-bold tracking-normal text-[var(--fsusblog-text-muted)] normal-case mb-2">当前密码</label>
        <el-input
          ref="passwordInput"
          v-model="password"
          type="password"
          autocomplete="current-password"
          placeholder="当前密码"
          :disabled="loading"
          @keyup.enter="handleConfirm"
        />
      </div>
      <div>
        <label class="block text-[10px] font-bold tracking-normal text-[var(--fsusblog-text-muted)] normal-case mb-2">验证码</label>
        <el-input
          v-model="code"
          type="text"
          placeholder="6 位验证码"
          :disabled="loading"
          @keyup.enter="handleConfirm"
        />
      </div>
      <div>
        <label class="block text-[10px] font-bold tracking-normal text-[var(--fsusblog-text-muted)] normal-case mb-2">恢复码(可选)</label>
        <el-input
          v-model="recoveryCode"
          type="text"
          placeholder="恢复码"
          :disabled="loading"
          @keyup.enter="handleConfirm"
        />
      </div>
    </div>

    <div v-if="errorMessage" class="mt-4 text-[11px] font-medium text-[var(--fsusblog-color-error)]">{{ errorMessage }}</div>

    <template #footer>
      <div class="dialog-footer flex justify-end gap-5 mt-4">
        <el-button @click="handleCancel" :disabled="loading">取消</el-button>
        <el-button
          type="primary"
          :disabled="loading || !password.trim() || (!code.trim() && !recoveryCode.trim())"
          @click="handleConfirm"
          :loading="loading"
        >
          {{ loading ? '处理中...' : '确认' }}
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
  title?: string
  description?: string
  errorMessage?: string
}>(), {
  loading: false,
  title: '',
  description: '',
  errorMessage: ''
})

const emit = defineEmits<{
  'update:visible': [value: boolean]
  confirm: [payload: { password: string; code?: string; recoveryCode?: string }]
  cancel: []
}>()

const password = ref('')
const code = ref('')
const recoveryCode = ref('')
const passwordInput = ref<any>(null)

const reset = () => {
  password.value = ''
  code.value = ''
  recoveryCode.value = ''
}

const handleCancel = () => {
  emit('update:visible', false)
  emit('cancel')
}

const handleConfirm = () => {
  emit('confirm', {
    password: password.value.trim(),
    code: code.value.trim() || undefined,
    recoveryCode: recoveryCode.value.trim() || undefined
  })
}

watch(
  () => props.visible,
  async (visible) => {
    if (!visible) {
      reset()
      return
    }

    await nextTick()
    passwordInput.value?.focus()
  }
)
</script>
