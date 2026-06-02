import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import type { FormInstance } from '@ozwasyd/element-plus'
import { ElMessageBox } from '@ozwasyd/element-plus'
import { isFsusUiOk } from '@/utils/fsusUiResult'
import type { ApiRequestConfig } from '@/api/requestConfig'
import {
  deleteAccount,
  disableMfa,
  getMfaProfile,
  listSessions,
  regenerateMfaRecoveryCodes,
  revokeOtherSessions,
  revokeSession,
  startMfaSetup,
  updatePassword,
  updateUsername,
  verifyMfaSetup,
  type DeleteAccountRequest,
  type MfaProfile,
  type MfaSetupStart,
  type MfaSetupVerify,
  type UpdatePasswordDto,
  type UpdateUsernameDto,
  type UserSessionSummary
} from '@/api/auth'
import { usePow } from '@/composables/usePow'
import { useAbortableTask } from '@/composables/useAbortableTask'
import { useUserStore } from '@/store/user'
import { createUsernamePattern, USERNAME_CONSTRAINT, validateUsername } from '@/utils/contentFilter'
import { toast } from '@/utils/toast'
import { getErrorMessage, isAbortError } from '@/utils/errors'

type MfaPromptState = {
  visible: boolean
  loading: boolean
  errorMessage: string
}

type MfaSetupState = {
  visible: boolean
  loading: boolean
  secret: string
  otpAuthUrl: string
  setupCode: string
  recoveryCodes: string[]
  errorMessage: string
}

type MfaCredentialState = {
  visible: boolean
  loading: boolean
  errorMessage: string
  mode: 'disable' | 'regenerate'
}

type SessionState = {
  loading: boolean
  list: UserSessionSummary[]
}

type DeleteAccountState = {
  loading: boolean
  visible: boolean
  form: {
    password: string
    confirmText: string
    code: string
    recoveryCode: string
  }
}

const DELETE_CONFIRM_TEXT = 'DELETE'

export function useUserProfileSecurity() {
  const userStore = useUserStore()
  const powProvider = usePow()

  const loadingName = ref(false)
  const loadingPwd = ref(false)
  const usernameFormRef = ref<FormInstance>()
  const passwordFormRef = ref<FormInstance>()

  const usernameTask = useAbortableTask()
  const passwordTask = useAbortableTask()
  const sessionTask = useAbortableTask()
  const mfaTask = useAbortableTask()
  const deleteTask = useAbortableTask()

  const usernameForm = reactive<UpdateUsernameDto>({
    newUsername: userStore.userInfo?.username || ''
  })

  const passwordForm = reactive({
    oldPassword: '',
    newPassword: '',
    confirmPassword: ''
  })

  const mfaPrompt = reactive<MfaPromptState>({
    visible: false,
    loading: false,
    errorMessage: ''
  })

  const mfaProfile = reactive<MfaProfile & { loading: boolean }>({
    enabled: false,
    verifiedAt: null,
    loading: false
  })

  const mfaSetupState = reactive<MfaSetupState>({
    visible: false,
    loading: false,
    secret: '',
    otpAuthUrl: '',
    setupCode: '',
    recoveryCodes: [],
    errorMessage: ''
  })

  const mfaCredentialState = reactive<MfaCredentialState>({
    visible: false,
    loading: false,
    errorMessage: '',
    mode: 'disable'
  })

  const sessionState = reactive<SessionState>({
    loading: false,
    list: []
  })

  const deleteAccountState = reactive<DeleteAccountState>({
    loading: false,
    visible: false,
    form: {
      password: '',
      confirmText: '',
      code: '',
      recoveryCode: ''
    }
  })

  const isUserBanned = computed(() => userStore.isBanned)
  const isCalculating = computed(() => powProvider.isCalculating.value)
  const isUsernameSubmitDisabled = computed(() => isUserBanned.value || loadingName.value)
  const isPasswordProcessing = computed(() => loadingPwd.value || isCalculating.value)
  const isPasswordSubmitDisabled = computed(
    () => isUserBanned.value || isPasswordProcessing.value
  )
  const usernameSubmitText = computed(() => (loadingName.value ? '处理中...' : '保存更改'))
  const passwordSubmitText = computed(() => {
    if (isCalculating.value) {
      return '安全计算中...'
    }
    if (loadingPwd.value) {
      return '提交中...'
    }
    return '更新账户凭证'
  })
  const showUsernameSubmitButton = computed(() => !isUserBanned.value)
  const showPasswordSubmitButton = computed(() => !isUserBanned.value)
  const usernameBannedText = '账号受限：暂无法修改资料'
  const passwordBannedText = '账号受限：安全设置已锁定'
  const mfaCredentialTitle = computed(() =>
    mfaCredentialState.mode === 'disable' ? '关闭 MFA' : '重新生成恢复码'
  )
  const mfaCredentialDescription = computed(() =>
    mfaCredentialState.mode === 'disable'
      ? '请输入当前密码和验证码，确认关闭多因素认证。'
      : '请输入当前密码和验证码，重新生成恢复码。'
  )

  const rules = {
    newUsername: [
      { required: true, message: '请填写新的用户名', trigger: 'blur' },
      { pattern: createUsernamePattern(), message: USERNAME_CONSTRAINT.patternMessage, trigger: 'blur' },
      {
        min: USERNAME_CONSTRAINT.minLength,
        max: USERNAME_CONSTRAINT.maxLength,
        message: USERNAME_CONSTRAINT.lengthMessage,
        trigger: 'blur'
      }
    ],
    oldPassword: [{ required: true, message: '请填写当前密码', trigger: 'blur' }],
    newPassword: [
      { required: true, message: '请填写新密码', trigger: 'blur' },
      { min: 8, message: '密码长度至少 8 位', trigger: 'blur' }
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

  const buildSignalConfig = (signal: AbortSignal) =>
    ({
      signal,
      requiresPow: true
    } satisfies ApiRequestConfig)

  const reloadMfaProfile = async (): Promise<void> => {
    mfaProfile.loading = true
    try {
      const profile = await mfaTask.run(async (signal) => await getMfaProfile({ signal }))
      if (!profile) {
        return
      }
      mfaProfile.enabled = profile.enabled
      mfaProfile.verifiedAt = profile.verifiedAt
    } catch (error) {
      if (!isAbortError(error)) {
        toast.error(getErrorMessage(error, 'MFA 状态加载失败'))
      }
    } finally {
      mfaProfile.loading = false
    }
  }

  const reloadSessions = async (): Promise<void> => {
    sessionState.loading = true
    try {
      const sessions = await sessionTask.run(async (signal) => await listSessions({ signal }))
      sessionState.list = sessions ?? []
    } catch (error) {
      if (!isAbortError(error)) {
        toast.error(getErrorMessage(error, '设备会话加载失败'))
      }
    } finally {
      sessionState.loading = false
    }
  }

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

    const validation = await usernameFormRef.value.validate()
    if (!isFsusUiOk(validation)) {
      return
    }

    const safeName = usernameForm.newUsername.replace(/["<>]/g, '')
    const confirmation = await ElMessageBox.confirm(
      `确定将用户名修改为 "${safeName}" 吗？这可能会影响您的展示名称。`,
      '修改身份识别',
      { confirmButtonText: '确认', cancelButtonText: '取消', type: 'warning' }
    )
    if (!isFsusUiOk(confirmation)) {
      return
    }

    void handleUpdateUsername()
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

        await updatePassword(payload, buildSignalConfig(signal))
        if (signal.aborted) {
          return
        }

        passwordForm.oldPassword = ''
        passwordForm.newPassword = ''
        passwordForm.confirmPassword = ''

        toast.success('密码已重置，请重新登录')
        await userStore.logout()
      })
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        toast.error(getErrorMessage(error, '密码修改失败'))
      }
    } finally {
      loadingPwd.value = false
    }
  }

  const requestUpdatePassword = async (): Promise<void> => {
    if (!passwordFormRef.value) {
      return
    }

    const validation = await passwordFormRef.value.validate()
    if (!isFsusUiOk(validation)) {
      return
    }

    const confirmation = await ElMessageBox.confirm(
      '确定要重置您的登录密码吗？更新成功后，系统将要求您重新登录。',
      '更新安全凭证',
      { confirmButtonText: '确认', cancelButtonText: '取消', type: 'warning' }
    )
    if (!isFsusUiOk(confirmation)) {
      return
    }

    void handleUpdatePassword()
  }

  const closeMfaPrompt = (_reason: unknown = null): void => {
    mfaPrompt.visible = false
    mfaPrompt.loading = false
    mfaPrompt.errorMessage = ''
  }

  const submitMfaPrompt = async (payload: { code?: string; recoveryCode?: string }): Promise<void> => {
    if (!mfaPrompt.visible) {
      return
    }

    mfaPrompt.loading = true
    mfaPrompt.errorMessage = ''
    try {
      // 当前页面未使用独立 challenge 流，保留占位以兼容现有弹窗结构。
      if (!payload.code && !payload.recoveryCode) {
        mfaPrompt.errorMessage = '请输入验证码或恢复码'
      }
    } finally {
      mfaPrompt.loading = false
    }
  }

  const startMfaSetupFlow = async (): Promise<void> => {
    mfaSetupState.visible = true
    mfaSetupState.loading = true
    mfaSetupState.errorMessage = ''
    mfaSetupState.recoveryCodes = []
    mfaSetupState.setupCode = ''
    try {
      const result = await mfaTask.run(async (signal) => await startMfaSetup({ signal }))
      const payload = result as MfaSetupStart
      mfaSetupState.secret = payload.secret
      mfaSetupState.otpAuthUrl = payload.otpAuthUrl
    } catch (error) {
      mfaSetupState.errorMessage = getErrorMessage(error, 'MFA 初始化失败')
    } finally {
      mfaSetupState.loading = false
    }
  }

  const completeMfaSetupFlow = async (): Promise<void> => {
    if (!mfaSetupState.setupCode.trim()) {
      return
    }

    mfaSetupState.loading = true
    mfaSetupState.errorMessage = ''
    try {
      const result = await mfaTask.run(
        async (signal) => await verifyMfaSetup(mfaSetupState.setupCode.trim(), { signal })
      )
      const payload = result as MfaSetupVerify
      mfaSetupState.recoveryCodes = payload.recoveryCodes
      await reloadMfaProfile()
      toast.success('MFA 已启用')
    } catch (error) {
      mfaSetupState.errorMessage = getErrorMessage(error, 'MFA 验证失败')
    } finally {
      mfaSetupState.loading = false
    }
  }

  const openDisableMfaModal = (): void => {
    mfaCredentialState.mode = 'disable'
    mfaCredentialState.visible = true
    mfaCredentialState.errorMessage = ''
  }

  const openRegenerateRecoveryCodesModal = (): void => {
    mfaCredentialState.mode = 'regenerate'
    mfaCredentialState.visible = true
    mfaCredentialState.errorMessage = ''
  }

  const closeMfaCredentialModal = (): void => {
    mfaCredentialState.visible = false
    mfaCredentialState.loading = false
    mfaCredentialState.errorMessage = ''
  }

  const submitMfaCredential = async (payload: { password: string; code?: string; recoveryCode?: string }): Promise<void> => {
    mfaCredentialState.loading = true
    mfaCredentialState.errorMessage = ''
    try {
      if (mfaCredentialState.mode === 'disable') {
        await mfaTask.run(async (signal) =>
          await disableMfa(
            { password: payload.password, code: payload.code, recoveryCode: payload.recoveryCode },
            buildSignalConfig(signal)
          )
        )
        toast.success('MFA 已关闭')
      } else {
        const result = await mfaTask.run(async (signal) =>
          await regenerateMfaRecoveryCodes(
            { password: payload.password, code: payload.code, recoveryCode: payload.recoveryCode },
            buildSignalConfig(signal)
          )
        )
        const response = result as MfaSetupVerify
        mfaSetupState.secret = ''
        mfaSetupState.otpAuthUrl = ''
        mfaSetupState.setupCode = ''
        mfaSetupState.recoveryCodes = response.recoveryCodes
        mfaSetupState.errorMessage = ''
        mfaSetupState.visible = true
        toast.success('恢复码已更新')
      }

      closeMfaCredentialModal()
      await reloadMfaProfile()
    } catch (error) {
      mfaCredentialState.errorMessage = getErrorMessage(error, 'MFA 操作失败')
    } finally {
      mfaCredentialState.loading = false
    }
  }

  const revokeSessionDevice = async (sessionId: string): Promise<void> => {
    const target = sessionState.list.find((item) => item.sessionId === sessionId)
    const confirmation = await ElMessageBox.confirm(
      `确定下线设备 ${target?.deviceLabel || target?.lastIp || sessionId} 吗？该设备需要重新登录。`,
      '下线设备',
      { confirmButtonText: '确认下线', cancelButtonText: '取消', type: 'warning' }
    ).catch(() => null)
    if (!isFsusUiOk(confirmation)) {
      return
    }

    try {
      await sessionTask.run(async (signal) => await revokeSession(sessionId, { signal }))
      toast.success('设备已下线')
      await reloadSessions()
    } catch (error) {
      if (!isAbortError(error)) {
        toast.error(getErrorMessage(error, '设备下线失败'))
      }
    }
  }

  const revokeOtherSessionDevices = async (): Promise<void> => {
    const count = sessionState.list.filter((item) => !item.isCurrent).length
    const confirmation = await ElMessageBox.confirm(
      `确定下线其他 ${count} 个设备会话吗？这些设备需要重新登录。`,
      '下线其他设备',
      { confirmButtonText: '确认下线', cancelButtonText: '取消', type: 'warning' }
    ).catch(() => null)
    if (!isFsusUiOk(confirmation)) {
      return
    }

    try {
      await sessionTask.run(async (signal) => await revokeOtherSessions({ signal }))
      toast.success('其他设备已下线')
      await reloadSessions()
    } catch (error) {
      if (!isAbortError(error)) {
        toast.error(getErrorMessage(error, '批量下线失败'))
      }
    }
  }

  const openDeleteAccountDialog = async (): Promise<void> => {
    deleteAccountState.visible = true
    deleteAccountState.form.password = ''
    deleteAccountState.form.confirmText = ''
    deleteAccountState.form.code = ''
    deleteAccountState.form.recoveryCode = ''
  }

  const submitDeleteAccount = async (): Promise<void> => {
    if (deleteAccountState.loading) {
      return
    }

    const payload: DeleteAccountRequest = {
      password: deleteAccountState.form.password.trim(),
      confirmText: deleteAccountState.form.confirmText.trim(),
      code: deleteAccountState.form.code.trim() || undefined,
      recoveryCode: deleteAccountState.form.recoveryCode.trim() || undefined
    }

    if (!payload.password) {
      toast.error('请输入当前密码')
      return
    }

    if (payload.confirmText !== DELETE_CONFIRM_TEXT) {
      toast.error(`请输入 ${DELETE_CONFIRM_TEXT} 作为确认文本`)
      return
    }

    deleteAccountState.loading = true
    try {
      await deleteTask.run(async (signal) => await deleteAccount(payload, buildSignalConfig(signal)))
      toast.success('账户已注销')
      deleteAccountState.visible = false
      await userStore.logout()
    } catch (error) {
      if (!isAbortError(error)) {
        toast.error(getErrorMessage(error, '账户注销失败'))
      }
    } finally {
      deleteAccountState.loading = false
    }
  }

  onMounted(() => {
    void reloadMfaProfile()
    void reloadSessions()
  })

  onUnmounted(() => {
    usernameTask.cancel()
    passwordTask.cancel()
    sessionTask.cancel()
    mfaTask.cancel()
    deleteTask.cancel()
  })

  return {
    userStore,
    isCalculating,
    isUserBanned,
    isUsernameSubmitDisabled,
    isPasswordProcessing,
    isPasswordSubmitDisabled,
    usernameSubmitText,
    passwordSubmitText,
    showUsernameSubmitButton,
    showPasswordSubmitButton,
    usernameBannedText,
    passwordBannedText,
    loadingName,
    usernameFormRef,
    passwordFormRef,
    usernameForm,
    passwordForm,
    mfaPrompt,
    mfaProfile,
    mfaSetupState,
    mfaCredentialState,
    mfaCredentialTitle,
    mfaCredentialDescription,
    sessionState,
    deleteAccountState,
    deleteConfirmText: DELETE_CONFIRM_TEXT,
    rules,
    requestUpdateUsername,
    requestUpdatePassword,
    submitMfaPrompt,
    closeMfaPrompt,
    startMfaSetupFlow,
    completeMfaSetupFlow,
    openDisableMfaModal,
    openRegenerateRecoveryCodesModal,
    closeMfaCredentialModal,
    submitMfaCredential,
    revokeSessionDevice,
    revokeOtherSessionDevices,
    openDeleteAccountDialog,
    submitDeleteAccount
  }
}
