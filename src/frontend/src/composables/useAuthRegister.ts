import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { register, type RegisterDto } from '@/api/auth'
import { scheduleIdleTask, type IdleTaskHandle } from '@/composables/useIdleTask'
import { useNotification } from '@/composables/useNotification'
import { usePow } from '@/composables/usePow'
import { useViewTask } from '@/composables/useViewTask'
import { useSessionBootstrap } from '@/composables/useSessionBootstrap'
import { AppErrorCode, toAppError } from '@/utils/appError'
import { validateCommentContent } from '@/utils/contentFilter'
import { toast } from '@/utils/toast'

const USERNAME_REGEX = /^[\u4e00-\u9fa5a-zA-Z]+$/

const getErrorText = (error: unknown): string => {
  const normalized = toAppError(error, '注册服务暂不可用，请稍后再试')

  if (
    normalized.message === 'PREEMPTED_BY_NEW_TASK'
    || normalized.message === 'POW_CALCULATION_ABORTED'
    || normalized.message === 'canceled'
  ) {
    return '安全校验已刷新，请重新提交'
  }

  switch (normalized.code) {
    case AppErrorCode.Timeout:
      if (normalized.details === 'pow_calculation_timeout' || normalized.message === 'pow_calculation_timeout') {
        return '安全组件响应超时，请刷新页面重试'
      }
      return '网络连接异常，请检查您的网络设置'
    case AppErrorCode.Conflict:
      return '该用户名已被注册，请尝试其他名称'
    case AppErrorCode.Validation:
      if (normalized.message === '用户名不能为空') {
        return '请输入用户名'
      }
      if (normalized.message === '用户名格式非法，仅允许中英文') {
        return '用户名仅支持纯中文或纯英文'
      }
      if (normalized.message === '两次输入的密码不一致') {
        return '两次输入的密码不一致'
      }
      if (normalized.message === '密码长度必须在 8-128 位之间') {
        return '密码长度需为 8-128 位'
      }
      return normalized.message || '注册信息校验失败，请检查后重试'
    case AppErrorCode.Forbidden:
      return '当前环境不允许执行注册操作'
    default:
      return normalized.message || '注册服务暂不可用，请稍后再试'
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

export function useAuthRegister() {
  const router = useRouter()
  const route = useRoute()
  const { userStore, siteStore, ensureUserInfo, syncAuthPhase, markSessionActive } = useSessionBootstrap()
  const { initNotification } = useNotification()
  const powProvider = usePow()

  const loading = ref(false)
  const localError = ref('')
  const isAgreed = ref(false)
  const showGuidelines = ref(false)

  const registerData = reactive<RegisterDto>({
    username: '',
    password: '',
    confirmPassword: ''
  })

  const isCalculating = computed(() => powProvider.isCalculating.value)
  const isProcessing = computed(() => loading.value || isCalculating.value)
  const submitButtonText = computed(() => {
    if (isCalculating.value) {
      return '安全加固校验中...'
    }
    if (loading.value) {
      return '正在同步账户数据...'
    }
    return '立即注册'
  })
  const handleGuidelinesActivator = (event?: KeyboardEvent | MouseEvent): void => {
    if (event instanceof KeyboardEvent && event.key !== 'Enter' && event.key !== ' ') {
      return
    }
    showGuidelines.value = true
  }

  const usernameHint = computed(() => {
    const value = registerData.username.trim()
    if (!value) {
      return ''
    }

    if (value.length < 3 || value.length > 20) {
      return '* 长度需在 3-20 个字符之间'
    }

    if (!USERNAME_REGEX.test(value)) {
      return '* 仅允许包含纯中文或纯英文'
    }

    return ''
  })

  const passwordHint = computed(() => {
    const value = registerData.password
    if (!value) {
      return ''
    }

    if (value.length < 6) {
      return '* 密码至少需要 6 个字符'
    }

    return ''
  })

  const confirmPasswordHint = computed(() => {
    const value = registerData.confirmPassword
    if (!value) {
      return ''
    }

    if (value !== registerData.password) {
      return '* 两次输入的密码不一致'
    }

    return ''
  })

  const usernameLabelClass = computed(() =>
    usernameHint.value ? 'text-[var(--fsusblog-color-error)]' : 'text-[var(--fsusblog-text-secondary)]'
  )
  const passwordLabelClass = computed(() =>
    passwordHint.value ? 'text-[var(--fsusblog-color-error)]' : 'text-[var(--fsusblog-text-secondary)]'
  )
  const confirmPasswordLabelClass = computed(() =>
    confirmPasswordHint.value ? 'text-[var(--fsusblog-color-error)]' : 'text-[var(--fsusblog-text-secondary)]'
  )

  const isFormValid = computed(
    () =>
      !usernameHint.value &&
      registerData.username.trim() !== '' &&
      !passwordHint.value &&
      registerData.password !== '' &&
      !confirmPasswordHint.value &&
      registerData.confirmPassword !== '' &&
      isAgreed.value
  )

  let prewarmTask: IdleTaskHandle | null = null
  const registerTask = useViewTask()

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

  const handleRegister = async (): Promise<void> => {
    if (!isFormValid.value || isProcessing.value) {
      return
    }

    localError.value = ''

    if (registerData.password !== registerData.confirmPassword) {
      localError.value = '两次输入的密码不一致。'
      return
    }

    const nameCheck = validateCommentContent(registerData.username)
    if (!nameCheck.isValid) {
      localError.value = `用户名违规：${nameCheck.message}`
      return
    }

    loading.value = true

    try {
      const registered = await registerTask.run(async (signal) =>
        register(
          {
            username: registerData.username.trim(),
            password: registerData.password,
            confirmPassword: registerData.confirmPassword
          },
          { signal }
        )
      , {
        fallbackMessage: '注册服务暂不可用，请稍后再试',
        onError: (error) => {
          const msg = getErrorText(error)

          localError.value = msg || '注册服务暂不可用，请稍后再试'
        }
      })

      if (!registered) {
        return
      }

      if (!await confirmSessionReady()) {
        localError.value = '注册成功，但登录状态同步失败，请重新登录'
        return
      }

      toast.success('注册成功，已自动登录')
      await router.push(getSafeRedirect(route.query.redirect))
      window.setTimeout(() => {
        if (userStore.isLoggedIn) {
          void initNotification(true)
        }
      }, POST_AUTH_NOTIFICATION_DELAY_MS)
    } catch {
      // registerTask 已负责回填页面级错误文案
    } finally {
      loading.value = false
    }
  }

  onMounted(() => {
    prewarmTask = scheduleIdleTask(() => powProvider.prewarm())
  })

  onUnmounted(() => {
    registerTask.cancel()
    prewarmTask?.cancel()
    prewarmTask = null
  })

  return {
    siteStore,
    isCalculating,
    loading,
    localError,
    isAgreed,
    showGuidelines,
    registerData,
    isProcessing,
    usernameHint,
    usernameLabelClass,
    passwordHint,
    passwordLabelClass,
    confirmPasswordHint,
    confirmPasswordLabelClass,
    isFormValid,
    submitButtonText,
    handleGuidelinesActivator,
    handleRegister
  }
}
