import { computed, reactive } from 'vue'
import { startMfaChallenge, verifyMfaChallenge } from '@/api/auth'
import { getErrorMessage } from '@/utils/errors'
import { AppErrorCode, createAppError } from '@/utils/appError'

export type MfaCredentialAction = 'disable' | 'regenerate-recovery'

type MfaPromptPayload = Readonly<{
  action: string
  challengeToken: string
}>

export function useMfaActionFlow() {
  const mfaPrompt = reactive({
    visible: false,
    loading: false,
    action: '',
    challengeToken: '',
    errorMessage: ''
  })

  const mfaCredentialState = reactive({
    visible: false,
    loading: false,
    action: 'disable' as MfaCredentialAction,
    errorMessage: ''
  })

  const mfaCredentialTitle = computed(() =>
    mfaCredentialState.action === 'disable' ? '关闭 MFA' : '重新生成恢复码'
  )

  const mfaCredentialDescription = computed(() =>
    mfaCredentialState.action === 'disable'
      ? '请输入当前密码 + 验证码（或恢复码）以关闭多因素认证。'
      : '请输入当前密码 + 验证码（或恢复码）以重新生成恢复码。'
  )

  let promptResolver: ((proof: string | null) => void) | null = null

  const closeMfaPrompt = (proof: string | null): void => {
    mfaPrompt.visible = false
    mfaPrompt.loading = false
    mfaPrompt.errorMessage = ''
    mfaPrompt.challengeToken = ''
    mfaPrompt.action = ''
    promptResolver?.(proof)
    promptResolver = null
  }

  const beginMfaPrompt = (payload: MfaPromptPayload): Promise<string | null> => {
    mfaPrompt.action = payload.action
    mfaPrompt.challengeToken = payload.challengeToken
    mfaPrompt.errorMessage = ''
    mfaPrompt.visible = true

    return new Promise<string | null>((resolve) => {
      promptResolver = resolve
    })
  }

  const requestMfaProof = async (action: string): Promise<string | null> => {
    const start = await startMfaChallenge(action)
    if (!start?.proofToken) {
      return null
    }

    if (start.verified) {
      return start.proofToken
    }

    return beginMfaPrompt({ action, challengeToken: start.proofToken })
  }

  const submitMfaPrompt = async (payload: { code?: string; recoveryCode?: string }): Promise<void> => {
    if (!mfaPrompt.challengeToken) {
      closeMfaPrompt(null)
      return
    }

    mfaPrompt.loading = true
    mfaPrompt.errorMessage = ''
    try {
      const verify = await verifyMfaChallenge({
        challengeToken: mfaPrompt.challengeToken,
        action: mfaPrompt.action,
        code: payload.code,
        recoveryCode: payload.recoveryCode
      })

      if (!verify.verified || !verify.proofToken) {
        throw createAppError(AppErrorCode.Validation, 'INVALID_TOTP')
      }

      closeMfaPrompt(verify.proofToken)
    } catch (error: unknown) {
      mfaPrompt.errorMessage = getErrorMessage(error, '验证码错误，请重试')
      mfaPrompt.loading = false
    }
  }

  const openMfaCredentialModal = (action: MfaCredentialAction): void => {
    mfaCredentialState.action = action
    mfaCredentialState.errorMessage = ''
    mfaCredentialState.visible = true
  }

  const closeMfaCredentialModal = (): void => {
    mfaCredentialState.visible = false
    mfaCredentialState.loading = false
    mfaCredentialState.errorMessage = ''
  }

  const dispose = (): void => {
    if (promptResolver) {
      promptResolver(null)
      promptResolver = null
    }
    closeMfaPrompt(null)
    closeMfaCredentialModal()
  }

  return {
    mfaPrompt,
    beginMfaPrompt,
    requestMfaProof,
    submitMfaPrompt,
    closeMfaPrompt,
    mfaCredentialState,
    mfaCredentialTitle,
    mfaCredentialDescription,
    openMfaCredentialModal,
    closeMfaCredentialModal,
    dispose
  }
}
