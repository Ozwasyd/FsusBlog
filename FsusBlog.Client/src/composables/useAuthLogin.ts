import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { login, verifyMfaChallenge } from '@/api/auth'
import { scheduleIdleTask, type IdleTaskHandle } from '@/composables/useIdleTask'
import { useNotification } from '@/composables/useNotification'
import { usePow } from '@/composables/usePow'
import { useSessionBootstrap } from '@/composables/useSessionBootstrap'
import { useViewTask } from '@/composables/useViewTask'
import { AppErrorCode, createAppError, toAppError } from '@/utils/appError'

const isAbortOrCanceledError = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) {
    return false
  }

  const known = error as { name?: string; message?: string }
  return known.name === 'AbortError' || known.message === 'canceled'
}

const getErrorText = (error: unknown): string => {
  const normalized = toAppError(error, '登录服务暂不可用，请稍后再试')

  if (normalized.message.includes('POW_CALCULATION_TIMEOUT')) {
    return '环境安全校验超时，请检查设备性能或刷新重试'
  }

  switch (normalized.code) {
    case AppErrorCode.Unauthorized:
      return '用户名或密码错误，请重新输入'
    case AppErrorCode.Forbidden:
      return '此账号无系统登录权限'
    case AppErrorCode.Timeout:
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

export function useAuthLogin() {
  const router = useRouter()
  const route = useRoute()
  const { userStore, siteStore, syncAuthPhase, markSessionActive, setRiskPhase, ensureUserInfo } = useSessionBootstrap()
  const { initNotification } = useNotification()
  const powProvider = usePow()
  const loginTask = useViewTask()
  const verifyTask = useViewTask()
  const loading = computed(() => loginTask.loading.value || verifyTask.loading.value)
  const errorMessage = loginTask.errorMessage
  const mfaChallengeToken = ref<string>('')
  const mfaCode = ref('')
  const mfaRecoveryCode = ref('')
  const requiresMfa = ref(false)
  const rememberMe = ref(true)
  const loginData = reactive({ username: '', password: '', rememberMe: true })

  const isCalculating = computed(() => powProvider.isCalculating.value)
  const isProcessing = computed(() => loading.value || isCalculating.value)
  const isFormValid = computed(
    () => loginData.username.trim().length > 0 && loginData.password.trim().length > 0
  )
  const submitButtonText = computed(() => {
    if (isCalculating.value) {
      return '安全校验中...'
    }
    if (loading.value) {
      return '登录中...'
    }
    return '进行'
  })
  const submitButtonPulseClass = computed(() => {
    if (isCalculating.value) {
      return 'animate-pulse flex items-center'
    }
    if (loading.value) {
      return 'animate-pulse'
    }
    return ''
  })
  const showSubmitLockIcon = computed(() => isCalculating.value)
  const showSubmitArrow = computed(() => !isCalculating.value && !loading.value)

  let prewarmTask: IdleTaskHandle | null = null

  const handleLogin = async (): Promise<void> => {
    errorMessage.value = ''

    if (!isFormValid.value || isProcessing.value) {
      return
    }

    try {
      const userData = await loginTask.run(async (signal) =>
        await login(
          { username: loginData.username, password: loginData.password, rememberMe: rememberMe.value },
          { signal }
        ),
        { fallbackMessage: '登录服务暂不可用，请稍后再试' }
      )

      if (!userData) {
        return
      }

      if (!userData || !userData.username) {
        throw createAppError(AppErrorCode.ProtocolFailure, 'login_response_invalid')
      }

      if (userData.mfaRequired && userData.challengeToken) {
        setRiskPhase(userData.riskMfaRequired ? 'elevated' : 'normal')
        requiresMfa.value = true
        mfaChallengeToken.value = userData.challengeToken
        loginData.rememberMe = rememberMe.value
        loginData.password = ''
        return
      }

      await ensureUserInfo(true)
      syncAuthPhase()
      markSessionActive()
      rememberMe.value = loginData.rememberMe
      loginData.password = ''

      void initNotification(true)

      await router.push(getSafeRedirect(route.query.redirect))
    } catch (error: unknown) {
      if (isAbortOrCanceledError(error)) {
        return
      }

      const msg = getErrorText(error)

      if (msg.includes('Account Locked') || msg.includes('锁定') || msg.includes('受限')) {
        errorMessage.value = '该账户已被安全锁定，请联系管理员解锁'
      } else {
        errorMessage.value = msg || '登录服务暂不可用，请稍后再试'
      }

      console.error('[Login Error]', error)
    }
  }

  const handleMfaVerify = async (): Promise<void> => {
    errorMessage.value = ''
    if (!requiresMfa.value || !mfaChallengeToken.value) {
      return
    }

    if (!mfaCode.value.trim() && !mfaRecoveryCode.value.trim()) {
      errorMessage.value = '请输入验证码或恢复码'
      return
    }

    try {
      const result = await verifyTask.run(
        async () =>
          await verifyMfaChallenge({
            challengeToken: mfaChallengeToken.value,
            code: mfaCode.value.trim() || undefined,
            recoveryCode: mfaRecoveryCode.value.trim() || undefined
          }),
        { fallbackMessage: '验证码无效，请重试' }
      )

      if (!result) {
        errorMessage.value = verifyTask.errorMessage.value || '验证码无效，请重试'
        return
      }

      if (!result.verified || !result.user) {
        throw createAppError(AppErrorCode.ProtocolFailure, 'MFA_VERIFY_FAILED')
      }

      await ensureUserInfo(true)
      syncAuthPhase()
      markSessionActive()
      setRiskPhase('normal')
      requiresMfa.value = false
      mfaChallengeToken.value = ''
      mfaCode.value = ''
      mfaRecoveryCode.value = ''
      rememberMe.value = loginData.rememberMe
      await router.push(getSafeRedirect(route.query.redirect))
    } catch (error: unknown) {
      const normalized = toAppError(error, '验证码无效，请重试')
      errorMessage.value = normalized.message === 'INVALID_TOTP' ? '验证码无效，请重试' : getErrorText(normalized)
    }
  }

  onMounted(() => {
    prewarmTask = scheduleIdleTask(() => powProvider.prewarm())
  })

  onUnmounted(() => {
    loginTask.cancel()
    verifyTask.cancel()
    prewarmTask?.cancel()
    prewarmTask = null
  })

  return {
    siteStore,
    isCalculating,
    loading,
    errorMessage,
    loginData,
    rememberMe,
    isProcessing,
    isFormValid,
    submitButtonText,
    submitButtonPulseClass,
    showSubmitLockIcon,
    showSubmitArrow,
    handleLogin,
    handleMfaVerify,
    requiresMfa,
    mfaCode,
    mfaRecoveryCode
  }
}
