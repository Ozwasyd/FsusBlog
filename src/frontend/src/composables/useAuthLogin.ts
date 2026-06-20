import { computed, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { verifyMfaChallenge } from '@/api/auth'
import { useNotification } from '@/composables/useNotification'
import { useSessionBootstrap } from '@/composables/useSessionBootstrap'
import { useViewTask } from '@/composables/useViewTask'
import { AppErrorCode, createAppError, toAppError } from '@/utils/appError'

const getErrorText = (error: unknown): string => {
  const normalized = toAppError(error, '登录服务暂不可用，请稍后再试')

  if (
    normalized.message === 'PREEMPTED_BY_NEW_TASK'
    || normalized.message === 'POW_CALCULATION_ABORTED'
    || normalized.message === 'canceled'
  ) {
    return '安全校验已刷新，请重新提交'
  }

  switch (normalized.code) {
    case AppErrorCode.Unauthorized:
      return '验证失败，请重新尝试'
    case AppErrorCode.Forbidden:
      if (normalized.status === 423 || normalized.message.includes('锁定')) {
        return '该账户已被安全锁定，请联系管理员处理'
      }
      return '此账号无系统登录权限'
    case AppErrorCode.Validation:
      if (normalized.status === 423 || normalized.message.includes('锁定')) {
        return '该账户已被安全锁定，请联系管理员处理'
      }
      return normalized.message || '验证信息校验失败，请检查后重试'
    case AppErrorCode.Timeout:
      if (normalized.details === 'pow_calculation_timeout' || normalized.message === 'pow_calculation_timeout') {
        return '环境安全校验超时，请检查设备性能或刷新重试'
      }
      return '网络连接异常，请检查您的网络设置'
    case AppErrorCode.ProtocolFailure:
      if (normalized.message === 'login_response_invalid') {
        return '系统数据异常，请刷新页面后重试'
      }

      if (normalized.message === 'MFA_VERIFY_FAILED') {
        return '验证状态异常，请重新登录后再试'
      }

      return normalized.message
    default:
      if (normalized.message === '账户已注销') {
        return '该账户已注销，无法继续登录'
      }
      return normalized.message || '登录服务暂不可用，请稍后再试'
  }
}

const getSafeRedirect = (target: unknown): string => {
  if (typeof target !== 'string') {
    return '/'
  }

  if (target.startsWith('/') && !target.startsWith('//')) {
    return target
  }

  return '/'
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms))
const POST_AUTH_NOTIFICATION_DELAY_MS = 5000
type MfaMode = 'totp' | 'recovery'

export function useAuthLogin() {
  const router = useRouter()
  const route = useRoute()
  const { userStore, siteStore, syncAuthPhase, markSessionActive, setRiskPhase, ensureUserInfo } = useSessionBootstrap()
  const { initNotification } = useNotification()
  const verifyTask = useViewTask()
  const loading = computed(() => verifyTask.loading.value)
  const errorMessage = verifyTask.errorMessage
  const mfaChallengeToken = ref<string>('')
  const mfaCode = ref('')
  const mfaRecoveryCode = ref('')
  const mfaMode = ref<MfaMode>('totp')
  const requiresMfa = ref(false)
  const rememberMe = ref(true)
  let verifySubmitting = false

  const isProcessing = computed(() => loading.value)

  const confirmSessionReady = async (): Promise<boolean> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await ensureUserInfo(true)
      syncAuthPhase()

      if (userStore.isLoggedIn) {
        markSessionActive()
        return true
      }

      await wait(120)
    }

    return false
  }

  const handleMfaVerify = async (): Promise<void> => {
    errorMessage.value = ''
    if (!requiresMfa.value || !mfaChallengeToken.value || verifySubmitting) {
      return
    }

    if (mfaMode.value === 'totp' && !mfaCode.value.trim()) {
      errorMessage.value = '请输入验证码'
      return
    }

    if (mfaMode.value === 'recovery' && !mfaRecoveryCode.value.trim()) {
      errorMessage.value = '请输入恢复码'
      return
    }

    verifySubmitting = true
    try {
      const result = await verifyTask.run(
        async () =>
          await verifyMfaChallenge({
            challengeToken: mfaChallengeToken.value,
            code: mfaMode.value === 'totp' ? mfaCode.value.trim() : undefined,
            recoveryCode: mfaMode.value === 'recovery' ? mfaRecoveryCode.value.trim() : undefined
          }),
        {
          fallbackMessage: '验证码无效，请重试',
          onError: (error) => {
            errorMessage.value = getErrorText(error)
          }
        }
      )

      if (!result) {
        errorMessage.value = verifyTask.errorMessage.value || '验证码无效，请重试'
        return
      }

      if (!result.verified || !result.user) {
        throw createAppError(AppErrorCode.ProtocolFailure, 'MFA_VERIFY_FAILED')
      }

      if (!await confirmSessionReady()) {
        errorMessage.value = '登录状态同步失败，请重新登录'
        return
      }

      setRiskPhase('normal')
      requiresMfa.value = false
      mfaChallengeToken.value = ''
      mfaMode.value = 'totp'
      mfaCode.value = ''
      mfaRecoveryCode.value = ''
      await router.push(getSafeRedirect(route.query.redirect))
      window.setTimeout(() => {
        if (userStore.isLoggedIn) {
          void initNotification(true)
        }
      }, POST_AUTH_NOTIFICATION_DELAY_MS)
    } catch (error: unknown) {
      const normalized = toAppError(error, '验证码无效，请重试')
      errorMessage.value = normalized.message === 'INVALID_TOTP' ? '验证码无效，请重试' : getErrorText(normalized)
    } finally {
      verifySubmitting = false
    }
  }

  onUnmounted(() => {
    verifyTask.cancel()
  })

  return {
    siteStore,
    loading,
    errorMessage,
    rememberMe,
    isProcessing,
    handleMfaVerify,
    requiresMfa,
    mfaMode,
    mfaCode,
    mfaRecoveryCode
  }
}
