import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { bootstrapAnonymousAccount, createRecoveryKey } from '@/api/auth'
import { usePasskeyManagement } from '@/composables/usePasskeyManagement'
import { useSessionBootstrap } from '@/composables/useSessionBootstrap'
import { authBroadcastRuntime } from '@/services/authBroadcastRuntime'
import { toAppError } from '@/utils/appError'
import { PUBLIC_HANDLE_CONSTRAINT, validatePublicHandle } from '@/utils/contentFilter'
import { toast } from '@/fsusui/feedback'

type AnonymousOnboardingStep = 'account' | 'recovery' | 'passkey' | 'complete'

const getSafeRedirect = (target: unknown): string => {
  if (typeof target !== 'string') {
    return '/user/identity'
  }

  if (target.startsWith('/') && !target.startsWith('//')) {
    return target
  }

  return '/user/identity'
}

const getErrorText = (error: unknown, fallback: string): string => {
  const normalized = toAppError(error, fallback)
  return normalized.message || fallback
}

export function useAnonymousOnboarding() {
  const route = useRoute()
  const router = useRouter()
  const { siteStore, userStore, ensureUserInfo, syncAuthPhase, markSessionActive } = useSessionBootstrap()
  const { fetchPasskeys } = usePasskeyManagement()

  const publicHandle = ref('')
  const isAgreed = ref(false)
  const showGuidelines = ref(false)
  const loading = ref(false)
  const localError = ref('')
  const step = ref<AnonymousOnboardingStep>('account')
  const recoveryKeyPlaintext = ref('')
  const recoveryKeyVersion = ref<number | null>(null)
  const recoveryKeyCreatedAt = ref<string | null>(null)
  const recoveryKeySaved = ref(false)
  const passkeyModalVisible = ref(false)
  const passkeyRegistered = ref(false)

  const publicHandleHint = computed(() => {
    const value = publicHandle.value.trim()
    if (!value) {
      return ''
    }

    const result = validatePublicHandle(value)
    if (!result.isValid) {
      return result.message || PUBLIC_HANDLE_CONSTRAINT.patternMessage
    }

    return ''
  })

  const isProcessing = computed(() => loading.value)
  const canCreateAnonymousAccount = computed(() =>
    isAgreed.value &&
    !publicHandleHint.value &&
    !loading.value &&
    step.value === 'account'
  )
  const canRegisterPasskey = computed(() =>
    step.value === 'recovery' &&
    recoveryKeySaved.value &&
    recoveryKeyPlaintext.value.length > 0 &&
    !loading.value
  )
  const submitButtonText = computed(() => {
    if (loading.value) {
      return '正在创建匿名账号...'
    }
    return '创建匿名账号并生成 Recovery Key'
  })

  const handleGuidelinesActivator = (event?: KeyboardEvent | MouseEvent): void => {
    if (event instanceof KeyboardEvent && event.key !== 'Enter' && event.key !== ' ') {
      return
    }
    showGuidelines.value = true
  }

  const createAnonymousAccount = async (): Promise<void> => {
    if (!canCreateAnonymousAccount.value) {
      return
    }

    loading.value = true
    localError.value = ''
    try {
      const handle = publicHandle.value.trim()
      await bootstrapAnonymousAccount({
        publicHandle: handle || undefined,
        acceptedGuidelines: isAgreed.value
      })
      await ensureUserInfo(true)
      syncAuthPhase()
      if (userStore.isLoggedIn) {
        markSessionActive()
        authBroadcastRuntime.broadcastLogin()
      }

      const response = await createRecoveryKey()
      recoveryKeyPlaintext.value = response.recoveryKey
      recoveryKeyVersion.value = response.keyVersion
      recoveryKeyCreatedAt.value = response.createdAt
      recoveryKeySaved.value = false
      step.value = 'recovery'
      toast.success('匿名账号已创建，请保存 Recovery Key')
    } catch (error) {
      localError.value = getErrorText(error, '匿名账号创建失败，请稍后再试')
    } finally {
      loading.value = false
    }
  }

  const copyRecoveryKey = async (): Promise<void> => {
    if (!recoveryKeyPlaintext.value) {
      return
    }

    await navigator.clipboard.writeText(recoveryKeyPlaintext.value)
    toast.success('Recovery Key 已复制')
  }

  const openPasskeyRegistration = (): void => {
    if (!canRegisterPasskey.value) {
      localError.value = '请先确认已保存 Recovery Key'
      return
    }

    localError.value = ''
    step.value = 'passkey'
    passkeyModalVisible.value = true
  }

  const onPasskeyRegistered = async (): Promise<void> => {
    passkeyRegistered.value = true
    recoveryKeyPlaintext.value = ''
    passkeyModalVisible.value = false
    step.value = 'complete'
    await fetchPasskeys()
  }

  const finishOnboarding = async (): Promise<void> => {
    recoveryKeyPlaintext.value = ''
    await router.push(getSafeRedirect(route.query.redirect))
  }

  return {
    siteStore,
    publicHandle,
    publicHandleHint,
    isAgreed,
    showGuidelines,
    loading,
    localError,
    step,
    recoveryKeyPlaintext,
    recoveryKeyVersion,
    recoveryKeyCreatedAt,
    recoveryKeySaved,
    passkeyModalVisible,
    passkeyRegistered,
    isProcessing,
    canCreateAnonymousAccount,
    canRegisterPasskey,
    submitButtonText,
    handleGuidelinesActivator,
    createAnonymousAccount,
    copyRecoveryKey,
    openPasskeyRegistration,
    onPasskeyRegistered,
    finishOnboarding
  }
}
