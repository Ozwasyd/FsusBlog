import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { register, type RegisterDto } from '@/api/auth'
import { scheduleIdleTask, type IdleTaskHandle } from '@/composables/useIdleTask'
import { usePow } from '@/composables/usePow'
import { useViewTask } from '@/composables/useViewTask'
import { useSiteStore } from '@/store/site'
import { AppErrorCode, toAppError } from '@/utils/appError'
import { validateCommentContent } from '@/utils/contentFilter'
import { toast } from '@/utils/toast'

const USERNAME_REGEX = /^[\u4e00-\u9fa5a-zA-Z]+$/

const getErrorText = (error: unknown): string => {
  const normalized = toAppError(error, '注册服务暂不可用，请稍后再试')

  switch (normalized.code) {
    case AppErrorCode.Timeout:
      if (normalized.details === 'pow_calculation_timeout' || normalized.message === 'pow_calculation_timeout') {
        return '安全组件响应超时，请刷新页面重试'
      }
      return '网络连接异常，请检查您的网络设置'
    case AppErrorCode.Conflict:
      return '该用户名已被注册，请尝试其他名称'
    default:
      return normalized.message || '注册服务暂不可用，请稍后再试'
  }
}

export function useAuthRegister() {
  const router = useRouter()
  const siteStore = useSiteStore()
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
    usernameHint.value ? 'text-[#E5484D]' : 'text-[#52525B] dark:text-[#A1A1AA]'
  )
  const usernameInputClass = computed(() =>
    usernameHint.value
      ? 'border-[#E5484D] focus:border-[#E5484D] focus:ring-1 focus:ring-[#E5484D] dark:border-[#E5484D] dark:focus:ring-[#E5484D]'
      : 'border-[#E4E4E7] focus:border-[#2A599C] focus:ring-1 focus:ring-[#2A599C] dark:border-[#27272A] dark:focus:border-[#7EA7E0] dark:focus:ring-[#7EA7E0]'
  )
  const passwordLabelClass = computed(() =>
    passwordHint.value ? 'text-[#E5484D]' : 'text-[#52525B] dark:text-[#A1A1AA]'
  )
  const passwordInputClass = computed(() =>
    passwordHint.value
      ? 'border-[#E5484D] focus:border-[#E5484D] focus:ring-1 focus:ring-[#E5484D] dark:border-[#E5484D] dark:focus:ring-[#E5484D]'
      : 'border-[#E4E4E7] focus:border-[#2A599C] focus:ring-1 focus:ring-[#2A599C] dark:border-[#27272A] dark:focus:border-[#7EA7E0] dark:focus:ring-[#7EA7E0]'
  )
  const confirmPasswordLabelClass = computed(() =>
    confirmPasswordHint.value ? 'text-[#E5484D]' : 'text-[#52525B] dark:text-[#A1A1AA]'
  )
  const confirmPasswordInputClass = computed(() =>
    confirmPasswordHint.value
      ? 'border-[#E5484D] focus:border-[#E5484D] focus:ring-1 focus:ring-[#E5484D] dark:border-[#E5484D] dark:focus:ring-[#E5484D]'
      : 'border-[#E4E4E7] focus:border-[#2A599C] focus:ring-1 focus:ring-[#2A599C] dark:border-[#27272A] dark:focus:border-[#7EA7E0] dark:focus:ring-[#7EA7E0]'
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

          console.error('[Register Error]', error)
        }
      })

      if (!registered) {
        return
      }

      toast.success('账户注册成功')
      await router.push('/login')
    } catch (error: unknown) {
      console.error('[Register Error]', error)
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
    usernameInputClass,
    passwordHint,
    passwordLabelClass,
    passwordInputClass,
    confirmPasswordHint,
    confirmPasswordLabelClass,
    confirmPasswordInputClass,
    isFormValid,
    submitButtonText,
    submitButtonPulseClass,
    showSubmitLockIcon,
    showSubmitArrow,
    handleGuidelinesActivator,
    handleRegister
  }
}
