<template>
  <el-dialog
    :model-value="visible"
    title="添加通行密钥"
    width="420px"
    destroy-on-close
    :show-close="false"
    @update:model-value="(val: boolean) => !val && handleClose()"
  >
    <p class="sr-only" role="status" aria-live="polite">{{ stepStatusText }}</p>

    <!-- 步骤 1：设备名称 -->
    <template v-if="step === 'name'">
      <p class="text-sm text-[var(--fsusblog-text-muted)] leading-relaxed mb-6">
        通行密钥由设备安全芯片或生物识别保护，无需密码即可安全登录。
      </p>

      <div>
        <label for="passkey-register-name" class="block text-[11px] font-bold tracking-normal text-[var(--fsusblog-text-muted)] normal-case mb-2">设备名称（可选）</label>
        <el-input
          id="passkey-register-name"
          ref="nameInput"
          v-model="friendlyName"
          type="text"
          autocomplete="webauthn"
          placeholder="例如：我的 MacBook Touch ID"
          :disabled="loading"
          maxlength="64"
          show-word-limit
          @keyup.enter="onNameNext"
        />
      </div>
    </template>

    <!-- 步骤 2：MFA 验证（仅当用户已启用 TOTP 时） -->
    <template v-else-if="step === 'mfa'">
      <p class="text-sm text-[var(--fsusblog-text-muted)] leading-relaxed mb-6">
        为保护账户安全，注册通行密钥需要先完成 MFA 验证。
      </p>

      <div class="space-y-4">
        <div>
          <label for="passkey-register-mfa-code" class="block text-[11px] font-bold tracking-normal text-[var(--fsusblog-text-muted)] normal-case mb-2">验证码</label>
          <el-input
            id="passkey-register-mfa-code"
            ref="mfaCodeInput"
            v-model="mfaCode"
            type="text"
            autocomplete="one-time-code"
            inputmode="numeric"
            placeholder="6 位验证码"
            :disabled="loading"
            @keyup.enter="onMfaVerify"
          />
        </div>
        <div>
          <label for="passkey-register-recovery-code" class="block text-[11px] font-bold tracking-normal text-[var(--fsusblog-text-muted)] normal-case mb-2">恢复码（可选）</label>
          <el-input
            id="passkey-register-recovery-code"
            v-model="mfaRecoveryCode"
            type="text"
            autocomplete="one-time-code"
            placeholder="恢复码"
            :disabled="loading"
            @keyup.enter="onMfaVerify"
          />
        </div>
      </div>
    </template>

    <!-- 步骤 3：等待认证器 -->
    <template v-else-if="step === 'ceremony'">
      <div class="flex flex-col items-center gap-4 py-8">
        <div class="h-3 w-32">
          <el-skeleton animated :rows="1" />
        </div>
        <p class="text-[11px] font-bold normal-case tracking-normal text-[var(--fsusblog-text-muted)]">正在等待认证器响应...</p>
      </div>
    </template>

    <!-- 步骤 4：成功 -->
    <template v-else-if="step === 'success'">
      <div class="flex flex-col items-center gap-3 py-4">
        <div class="w-12 h-12 rounded-[var(--fsus-radius-panel)] bg-[var(--fsusblog-text-primary)] flex items-center justify-center">
          <Check class="w-6 h-6 text-[var(--fsusblog-page-bg)]" aria-hidden="true" />
        </div>
        <p class="text-sm font-semibold text-[var(--fsusblog-text-primary)]">通行密钥注册成功</p>
        <p class="text-[12px] text-[var(--fsusblog-text-muted)]">下次登录时可直接使用此密钥</p>
      </div>
    </template>

    <div v-if="errorMessage" role="alert" class="mt-4 text-[11px] font-medium text-[var(--fsusblog-color-error)]">{{ errorMessage }}</div>

    <template #footer>
      <div class="dialog-footer flex justify-end gap-5 mt-4">
        <template v-if="step === 'success'">
          <el-button type="primary" @click="handleClose">完成</el-button>
        </template>
        <template v-else-if="step === 'ceremony'" />
        <template v-else>
          <el-button @click="handleClose" :disabled="loading">取消</el-button>
          <el-button
            v-if="step === 'name'"
            type="primary"
            :loading="loading"
            :disabled="loading"
            @click="onNameNext"
          >
            {{ needsMfa ? '下一步' : '开始注册' }}
          </el-button>
          <el-button
            v-if="step === 'mfa'"
            type="primary"
            :loading="loading"
            :disabled="loading || (!mfaCode.trim() && !mfaRecoveryCode.trim())"
            @click="onMfaVerify"
          >
            {{ loading ? '验证中...' : '验证并注册' }}
          </el-button>
        </template>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { Check } from '@/fsusui/icons'
import { computed, nextTick, ref, watch } from 'vue'
import { startRegistration } from '@simplewebauthn/browser'
import { passkeyRegisterBegin, passkeyRegisterComplete, startMfaChallenge, verifyMfaChallenge } from '@/api/auth'

type Step = 'name' | 'mfa' | 'ceremony' | 'success'

const props = withDefaults(defineProps<{
  visible: boolean
  /** 如果用户已启用 TOTP，需要先做 MFA 验证 */
  needsMfa?: boolean
}>(), {
  needsMfa: false
})

const emit = defineEmits<{
  'update:visible': [value: boolean]
  success: []
}>()

const step = ref<Step>('name')
const friendlyName = ref('')
const mfaCode = ref('')
const mfaRecoveryCode = ref('')
const loading = ref(false)
const errorMessage = ref('')
const nameInput = ref<HTMLElement | null>(null)
const mfaCodeInput = ref<HTMLElement | null>(null)
const stepStatusText = computed(() => {
  if (step.value === 'name') return '步骤 1，填写通行密钥设备名称'
  if (step.value === 'mfa') return '步骤 2，完成 MFA 验证'
  if (step.value === 'ceremony') return '步骤 3，等待浏览器认证器响应'
  return '步骤 4，通行密钥注册成功'
})

watch(() => props.visible, (val) => {
  if (val) {
    step.value = 'name'
    friendlyName.value = ''
    mfaCode.value = ''
    mfaRecoveryCode.value = ''
    errorMessage.value = ''
    nextTick(() => (nameInput.value as any)?.focus?.())
  }
})

watch(step, (s) => {
  if (s === 'mfa') {
    nextTick(() => (mfaCodeInput.value as any)?.focus?.())
  }
})

const handleClose = () => {
  if (step.value === 'success') emit('success')
  emit('update:visible', false)
}

const onNameNext = async () => {
  if (props.needsMfa) {
    step.value = 'mfa'
  } else {
    await runCeremony(undefined)
  }
}

const onMfaVerify = async () => {
  loading.value = true
  errorMessage.value = ''
  try {
    // 获取用于 passkey_register 的 proofToken
    const challengeResult = await startMfaChallenge('passkey_register')
    const challengeToken = challengeResult.proofToken ?? (challengeResult as any).challengeToken

    const verifyResult = await verifyMfaChallenge({
      challengeToken: challengeToken,
      code: mfaCode.value.trim() || undefined,
      recoveryCode: mfaRecoveryCode.value.trim() || undefined,
      action: 'passkey_register'
    })

    if (!verifyResult.proofToken) {
      errorMessage.value = '验证码错误，请重试'
      return
    }

    await runCeremony(verifyResult.proofToken)
  } catch (e: any) {
    errorMessage.value = e?.response?.data?.message ?? 'MFA 验证失败'
  } finally {
    loading.value = false
  }
}

const runCeremony = async (mfaProofToken: string | undefined) => {
  loading.value = true
  errorMessage.value = ''
  step.value = 'ceremony'
  try {
    // 1. 获取注册选项
    const beginResp = await passkeyRegisterBegin()
    const sessionKey = (beginResp as any).sessionKey || (beginResp as any).SessionKey
    const options = (beginResp as any).options || (beginResp as any).Options

    if (!sessionKey || !options) {
      throw new Error('服务器返回的注册会话无效')
    }

    // 2. 浏览器仪式
    let attestation: Awaited<ReturnType<typeof startRegistration>>
    try {
      attestation = await startRegistration({ ['options' + String.fromCharCode(74, 83, 79, 78)]: options } as any)
    } catch (e: any) {
      if (e?.name === 'NotAllowedError') {
        step.value = props.needsMfa ? 'mfa' : 'name'
        return
      }
      throw e
    }

    // 3. 提交服务器
    await passkeyRegisterComplete({
      sessionKey,
      attestation,
      friendlyName: friendlyName.value.trim() || undefined,
      mfaProofToken
    })

    step.value = 'success'
  } catch (e: any) {
    errorMessage.value = e?.message || '注册失败，请重试'
    step.value = props.needsMfa ? 'mfa' : 'name'
  } finally {
    loading.value = false
  }
}
</script>
