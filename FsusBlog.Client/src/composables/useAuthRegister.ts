import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { register, type RegisterDto } from '@/api/auth'
import { useAbortableTask } from '@/composables/useAbortableTask'
import { scheduleIdleTask, type IdleTaskHandle } from '@/composables/useIdleTask'
import { usePow } from '@/composables/usePow'
import { useSiteStore } from '@/store/site'
import { validateCommentContent } from '@/utils/contentFilter'
import { toast } from '@/utils/toast'

const USERNAME_REGEX = /^[\u4e00-\u9fa5a-zA-Z]+$/

const isAbortOrCanceledError = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) {
    return false
  }

  const known = error as { name?: string; message?: string }
  return known.name === 'AbortError' || known.message === 'canceled'
}

const getErrorText = (error: unknown): string => {
  if (typeof error === 'object' && error !== null) {
    const known = error as { message?: string }
    if (typeof known.message === 'string' && known.message.length > 0) {
      return known.message
    }
  }

  return String(error)
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
    usernameHint.value ? 'text-red-500' : 'text-zinc-400'
  )
  const usernameInputClass = computed(() =>
    usernameHint.value ? 'border-red-500 focus:border-red-500' : 'border-zinc-200 focus:border-zinc-950'
  )
  const passwordLabelClass = computed(() =>
    passwordHint.value ? 'text-red-500' : 'text-zinc-400'
  )
  const passwordInputClass = computed(() =>
    passwordHint.value ? 'border-red-500 focus:border-red-500' : 'border-zinc-200 focus:border-zinc-950'
  )
  const confirmPasswordLabelClass = computed(() =>
    confirmPasswordHint.value ? 'text-red-500' : 'text-zinc-400'
  )
  const confirmPasswordInputClass = computed(() =>
    confirmPasswordHint.value ? 'border-red-500 focus:border-red-500' : 'border-zinc-200 focus:border-zinc-950'
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
  const registerTask = useAbortableTask()

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
      await registerTask.run(async (signal) =>
        await register(
          {
            username: registerData.username.trim(),
            password: registerData.password,
            confirmPassword: registerData.confirmPassword
          },
          { signal }
        )
      )

      toast.success('账户注册成功')
      await router.push('/login')
    } catch (error: unknown) {
      if (isAbortOrCanceledError(error)) {
        return
      }

      const msg = getErrorText(error)

      if (msg.includes('POW_CALCULATION_TIMEOUT')) {
        localError.value = '安全组件响应超时，请刷新页面重试'
      } else if (msg.includes('Network Error') || msg.includes('timeout')) {
        localError.value = '网络连接异常，请检查您的网络设置'
      } else if (msg.includes('已存在') || msg.includes('占用')) {
        localError.value = '该用户名已被注册，请尝试其他名称'
      } else {
        localError.value = msg || '注册服务暂不可用，请稍后再试'
      }

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
