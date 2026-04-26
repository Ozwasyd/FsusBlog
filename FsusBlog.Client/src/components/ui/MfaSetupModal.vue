<template>
  <el-dialog
    :model-value="visible"
    title="MFA 绑定"
    width="520px"
    class="fsus-mfa-dialog"
    destroy-on-close
    align-center
    :show-close="false"
    @update:model-value="val => !val && close()"
  >
    <p class="text-sm text-[#8E8E93] leading-relaxed mb-5">
      1) 在 Google Authenticator 中添加账户。2) 输入 6 位验证码完成绑定。
    </p>

    <div class="space-y-4">
      <div>
        <div class="text-[11px] font-semibold text-[#3F3F46] mb-1">手动密钥</div>
        <div class="px-3 py-2 bg-[#FCFCFC] border border-[#F4F4F5] rounded text-[12px] font-mono text-[#27272A] break-all">{{ secret || '-' }}</div>
      </div>

      <a
        v-if="otpAuthUrl"
        :href="otpAuthUrl"
        class="inline-flex text-[12px] font-semibold text-[#3F3F46] hover:text-[#2A599C] underline"
      >
        打开认证器链接
      </a>

      <div v-if="!recoveryCodes.length">
        <label class="block text-[10px] font-bold tracking-normal text-[#A1A1AA] uppercase mb-2">验证码</label>
        <el-input
          :model-value="setupCode"
          @update:model-value="val => emit('update:setupCode', String(val))"
          type="text"
          placeholder="6 位验证码"
          :disabled="loading"
          @keyup.enter="$emit('verify')"
        />
      </div>

      <div v-else>
        <div class="text-[11px] font-semibold text-[#3F3F46] mb-2">恢复码（仅显示一次）</div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div
            v-for="code in recoveryCodes"
            :key="code"
            class="px-3 py-2 bg-[#FCFCFC] border border-[#F4F4F5] rounded text-[12px] font-mono text-[#27272A]"
          >
            {{ code }}
          </div>
        </div>
      </div>
    </div>

    <div v-if="errorMessage" class="mt-4 text-[11px] font-medium text-red-500">{{ errorMessage }}</div>

    <template #footer>
      <div class="dialog-footer flex justify-end gap-5 mt-4">
        <el-button @click="close" :disabled="loading" text>
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
defineProps<{
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
</script>
