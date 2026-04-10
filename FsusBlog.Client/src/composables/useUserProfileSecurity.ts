import { computed, onUnmounted, reactive, ref } from 'vue'
import type { FormInstance } from 'element-plus'
import type { AxiosRequestConfig } from 'axios'
import { updatePassword, updateUsername, type UpdatePasswordDto, type UpdateUsernameDto } from '@/api/auth'
import { usePow } from '@/composables/usePow'
import { useAbortableTask } from '@/composables/useAbortableTask'
import { useUserStore } from '@/store/user'
import { validateUsername } from '@/utils/contentFilter'
import { toast } from '@/utils/toast'
import { getErrorMessage, isAbortError } from '@/utils/errors'

type ProfileModalConfig = Readonly<{
  title: string
  content: string
  onConfirm: () => void
}>

export function useUserProfileSecurity() {
  const userStore = useUserStore()
  const powProvider = usePow()

  const loadingName = ref(false)
  const loadingPwd = ref(false)
  const usernameFormRef = ref<FormInstance>()
  const passwordFormRef = ref<FormInstance>()

  const usernameTask = useAbortableTask()
  const passwordTask = useAbortableTask()

  const usernameForm = reactive<UpdateUsernameDto>({
    newUsername: userStore.userInfo?.username || ''
  })

  const passwordForm = reactive({
    oldPassword: '',
    newPassword: '',
    confirmPassword: ''
  })

  const modalState = reactive({
    visible: false,
    title: '',
    content: '',
    onConfirm: () => {}
  })

  const isUserBanned = computed(() => userStore.isBanned)
  const isCalculating = computed(() => powProvider.isCalculating.value)
  const isUsernameSubmitDisabled = computed(() => isUserBanned.value || loadingName.value)
  const isPasswordSubmitDisabled = computed(
    () => isUserBanned.value || loadingPwd.value || isCalculating.value
  )
  const usernameSubmitText = computed(() => (loadingName.value ? '处理中...' : '保存更改'))
  const passwordSubmitText = computed(() => {
    if (isCalculating.value) {
      return '🔒 安全计算中...'
    }
    if (loadingPwd.value) {
      return '提交中...'
    }
    return '更新账户凭证'
  })
  const passwordSubmitPulseClass = computed(() =>
    loadingPwd.value || isCalculating.value ? 'animate-pulse' : ''
  )
  const showUsernameSubmitButton = computed(() => !isUserBanned.value)
  const showPasswordSubmitButton = computed(() => !isUserBanned.value)
  const usernameBannedText = '账号受限：暂无法修改资料'
  const passwordBannedText = '账号受限：安全设置已锁定'

  const triggerModal = (config: ProfileModalConfig): void => {
    modalState.title = config.title
    modalState.content = config.content
    modalState.onConfirm = () => {
      config.onConfirm()
      modalState.visible = false
    }
    modalState.visible = true
  }

  let usernameRegex: RegExp
  try {
    usernameRegex = new RegExp('^[\\p{Script=Han}\\p{L}\\p{N}_-]+$', 'u')
  } catch {
    usernameRegex = /^[\u4e00-\u9fa5A-Za-z0-9_-]+$/
  }

  const rules = {
    newUsername: [
      { required: true, message: '请填写新的用户名', trigger: 'blur' },
      { pattern: usernameRegex, message: '用户名仅允许中英文字符、数字及连字符', trigger: 'blur' },
      { min: 3, max: 20, message: '长度在 3 到 20 个字符', trigger: 'blur' }
    ],
    oldPassword: [{ required: true, message: '请填写当前密码', trigger: 'blur' }],
    newPassword: [
      { required: true, message: '请填写新密码', trigger: 'blur' },
      { min: 6, message: '密码长度至少 6 位', trigger: 'blur' }
    ],
    confirmPassword: [
      { required: true, message: '请再次确认密码', trigger: 'blur' },
      {
        validator: (_rule: unknown, value: string, callback: (error?: Error) => void) => {
          if (value !== passwordForm.newPassword) {
            callback(new Error('两次输入的密码不一致'))
          } else {
            callback()
          }
        },
        trigger: 'blur'
      }
    ]
  }

  let logoutTimer: ReturnType<typeof setTimeout> | null = null

  const handleUpdateUsername = async (): Promise<void> => {
    const nameCheck = validateUsername(usernameForm.newUsername)
    if (!nameCheck.isValid) {
      toast.error(`用户名违规：${nameCheck.message}`)
      return
    }

    loadingName.value = true
    try {
      await usernameTask.run(async (signal) => {
        await updateUsername({ newUsername: usernameForm.newUsername.trim() }, { signal })
        if (signal.aborted) {
          return
        }
        await userStore.fetchUserInfo(true)
        toast.success('用户名已同步更新')
      })
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        toast.error(getErrorMessage(error, '用户名修改失败'))
      }
    } finally {
      loadingName.value = false
    }
  }

  const requestUpdateUsername = async (): Promise<void> => {
    if (!usernameFormRef.value) {
      return
    }

    try {
      await usernameFormRef.value.validate()
      const safeName = usernameForm.newUsername.replace(/["<>]/g, '')
      triggerModal({
        title: '修改身份识别',
        content: `确定将用户名修改为 "${safeName}" 吗？这可能会影响您的展示名称。`,
        onConfirm: () => { void handleUpdateUsername() }
      })
    } catch {
      // ElementPlus shows validation message.
    }
  }

  const handleUpdatePassword = async (): Promise<void> => {
    if (loadingPwd.value || powProvider.isCalculating.value) {
      return
    }

    loadingPwd.value = true
    try {
      await passwordTask.run(async (signal) => {
        const payload: UpdatePasswordDto = {
          oldPassword: passwordForm.oldPassword,
          newPassword: passwordForm.newPassword,
          confirmPassword: passwordForm.confirmPassword
        }

        await updatePassword(
          payload,
          {
            signal,
            requiresPow: true
          } satisfies AxiosRequestConfig
        )

        if (signal.aborted) {
          return
        }

        passwordForm.oldPassword = ''
        passwordForm.newPassword = ''
        passwordForm.confirmPassword = ''

        toast.success('密码已重置，请重新登录')
        if (logoutTimer) {
          clearTimeout(logoutTimer)
        }

        logoutTimer = setTimeout(async () => {
          await userStore.logout()
        }, 2000)
      })
    } catch (error: unknown) {
      if (isAbortError(error)) {
        return
      }

      const message = getErrorMessage(error, '密码修改失败')
      if (message.includes('POW_CALCULATION_TIMEOUT')) {
        toast.error('安全环境响应超时，请刷新页面重试')
      } else {
        toast.error(message || '密码修改失败')
      }
    } finally {
      loadingPwd.value = false
    }
  }

  const requestUpdatePassword = async (): Promise<void> => {
    if (!passwordFormRef.value) {
      return
    }

    try {
      await passwordFormRef.value.validate()
      triggerModal({
        title: '更新安全凭证',
        content: '确定要重置您的登录密码吗？更新成功后，系统将要求您重新登录。',
        onConfirm: () => { void handleUpdatePassword() }
      })
    } catch {
      // ElementPlus shows validation message.
    }
  }

  onUnmounted(() => {
    usernameTask.cancel()
    passwordTask.cancel()
    if (logoutTimer) {
      clearTimeout(logoutTimer)
      logoutTimer = null
    }
  })

  return {
    userStore,
    isCalculating,
    isUserBanned,
    isUsernameSubmitDisabled,
    isPasswordSubmitDisabled,
    usernameSubmitText,
    passwordSubmitText,
    passwordSubmitPulseClass,
    showUsernameSubmitButton,
    showPasswordSubmitButton,
    usernameBannedText,
    passwordBannedText,
    loadingName,
    loadingPwd,
    usernameFormRef,
    passwordFormRef,
    usernameForm,
    passwordForm,
    modalState,
    rules,
    requestUpdateUsername,
    requestUpdatePassword
  }
}
