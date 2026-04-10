import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { login } from '@/api/auth'
import { useAbortableTask } from '@/composables/useAbortableTask'
import { scheduleIdleTask, type IdleTaskHandle } from '@/composables/useIdleTask'
import { useNotification } from '@/composables/useNotification'
import { usePow } from '@/composables/usePow'
import { useSiteStore } from '@/store/site'
import { useUserStore } from '@/store/user'

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
  const userStore = useUserStore()
  const siteStore = useSiteStore()
  const { initNotification } = useNotification()
  const powProvider = usePow()

  const loading = ref(false)
  const errorMessage = ref('')
  const loginData = reactive({ username: '', password: '' })

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
  const loginTask = useAbortableTask()

  const handleLogin = async (): Promise<void> => {
    errorMessage.value = ''

    if (!isFormValid.value || isProcessing.value) {
      return
    }

    loading.value = true

    try {
      const userData = await loginTask.run(async (signal) =>
        await login(
          { username: loginData.username, password: loginData.password },
          { signal }
        )
      )

      if (!userData || !userData.username) {
        throw new Error('服务器响应格式异常')
      }

      userStore.setUserInfo(userData)
      loginData.password = ''

      void initNotification(true)

      await router.push(getSafeRedirect(route.query.redirect))
    } catch (error: unknown) {
      if (isAbortOrCanceledError(error)) {
        return
      }

      const msg = getErrorText(error)

      if (msg.includes('POW_CALCULATION_TIMEOUT')) {
        errorMessage.value = '环境安全校验超时，请检查设备性能或刷新重试'
      } else if (msg.includes('Account Locked') || msg.includes('锁定') || msg.includes('受限')) {
        errorMessage.value = '该账户已被安全锁定，请联系管理员解锁'
      } else if (msg.includes('Forbidden') || msg.includes('权限不足')) {
        errorMessage.value = '此账号无系统登录权限'
      } else if (msg.includes('Unauthorized') || msg.includes('401')) {
        errorMessage.value = '用户名或密码错误，请重新输入'
      } else if (msg.includes('Network Error') || msg.includes('timeout')) {
        errorMessage.value = '网络连接异常，请检查您的网络设置'
      } else if (msg.includes('格式异常')) {
        errorMessage.value = '系统数据异常，请刷新页面后重试'
      } else {
        errorMessage.value = msg || '登录服务暂不可用，请稍后再试'
      }

      console.error('[Login Error]', error)
    } finally {
      loading.value = false
    }
  }

  onMounted(() => {
    prewarmTask = scheduleIdleTask(() => powProvider.prewarm())
  })

  onUnmounted(() => {
    loginTask.cancel()
    prewarmTask?.cancel()
    prewarmTask = null
  })

  return {
    siteStore,
    isCalculating,
    loading,
    errorMessage,
    loginData,
    isProcessing,
    isFormValid,
    submitButtonText,
    submitButtonPulseClass,
    showSubmitLockIcon,
    showSubmitArrow,
    handleLogin
  }
}
