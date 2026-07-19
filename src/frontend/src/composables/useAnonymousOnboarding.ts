import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { bootstrapAnonymousAccount, createRecoveryKey } from '@/api/auth'
import { usePasskeyManagement } from '@/composables/usePasskeyManagement'
import { useSessionBootstrap } from '@/composables/useSessionBootstrap'
import { authBroadcastRuntime } from '@/services/authBroadcastRuntime'
import { toAppError } from '@/utils/appError'
import { PUBLIC_HANDLE_CONSTRAINT, validatePublicHandle } from '@/utils/contentFilter'
import { toast } from '@/fsusui/feedback'
import { resolveSafeRedirectTarget } from '@/security/privateNavigationPolicy'
import { usePostAuthCommit } from '@/composables/usePostAuthCommit'

type AnonymousOnboardingStep = 'account' | 'passkey' | 'recovery' | 'complete'

const getErrorText = (error: unknown, fallback: string): string => {
  const normalized = toAppError(error, fallback)
  if (normalized.message.includes('匿名账号初始化仅在匿名身份模式下可用')) {
    return '注册入口暂不可用。'
  }
  return normalized.message || fallback
}

export function useAnonymousOnboarding() {
  const route = useRoute()
  const router = useRouter()
  const { siteStore } = useSessionBootstrap()
  const { commitPostAuthSession } = usePostAuthCommit()
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
    step.value === 'passkey' &&
    !loading.value
  )
  const submitButtonText = computed(() => {
    if (loading.value) {
      return '正在创建匿名账号'
    }
    return '创建匿名账号并绑定通行密钥'
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
      const enrollment = await bootstrapAnonymousAccount({
        publicHandle: handle || undefined,
        acceptedGuidelines: isAgreed.value
      })
      if (enrollment.authPhase !== 'enrollment_required') {
        throw new Error('注册服务未返回首枚通行密钥绑定状态。')
      }
      step.value = 'passkey'
      passkeyModalVisible.value = true
      toast.success('临时注册会话已创建。请绑定首枚通行密钥。')
    } catch (error) {
      localError.value = getErrorText(error, '匿名账号创建失败。稍后重试。')
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
      localError.value = '当前注册会话无法开始通行密钥绑定。'
      return
    }

    localError.value = ''
    step.value = 'passkey'
    passkeyModalVisible.value = true
  }

  const onPasskeyRegistered = async (): Promise<void> => {
    passkeyRegistered.value = true
    passkeyModalVisible.value = false
    loading.value = true
    localError.value = ''
    try {
      if (!await commitPostAuthSession()) {
        throw new Error('正式会话同步失败，请安全重试注册完成请求。')
      }
      authBroadcastRuntime.broadcastLogin()
      const response = await createRecoveryKey()
      recoveryKeyPlaintext.value = response.recoveryKey
      recoveryKeyVersion.value = response.keyVersion
      recoveryKeyCreatedAt.value = response.createdAt
      recoveryKeySaved.value = false
      step.value = 'recovery'
      await fetchPasskeys()
      toast.success('账户已激活。请保存 Recovery Key。')
    } catch (error) {
      localError.value = getErrorText(error, '账户已激活，但后续安全资料初始化失败。')
    } finally {
      loading.value = false
    }
  }

  const finishOnboarding = async (): Promise<void> => {
    recoveryKeyPlaintext.value = ''
    await router.push(resolveSafeRedirectTarget(router, route.query.redirect, '/user/identity'))
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
