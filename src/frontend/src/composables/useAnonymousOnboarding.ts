import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { createRecoveryKey, register } from '@/api/auth'
import { usePasskeyManagement } from '@/composables/usePasskeyManagement'
import { useSessionBootstrap } from '@/composables/useSessionBootstrap'
import { toAppError } from '@/utils/appError'
import { USERNAME_CONSTRAINT, validateUsername } from '@/utils/contentFilter'
import { toast } from '@/fsusui/feedback'

type AnonymousOnboardingStep = 'account' | 'recovery' | 'passkey' | 'complete'

const RANDOM_LETTERS = 'abcdefghijklmnopqrstuvwxyz'
const RANDOM_PASSWORD_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

const getSafeRedirect = (target: unknown): string => {
  if (typeof target !== 'string') {
    return '/user/identity'
  }

  if (target.startsWith('/') && !target.startsWith('//')) {
    return target
  }

  return '/user/identity'
}

const randomBytes = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length)
  const cryptoProvider = globalThis.crypto
  if (!cryptoProvider?.getRandomValues) {
    throw new Error('当前浏览器无法生成匿名账号密钥，请升级浏览器后重试')
  }

  cryptoProvider.getRandomValues(bytes)
  return bytes
}

const randomString = (length: number, alphabet: string): string => {
  const bytes = randomBytes(length)
  let value = ''
  for (const byte of bytes) {
    value += alphabet[byte % alphabet.length]
  }
  return value
}

const buildAnonymousUsername = (publicHandle: string): string => {
  const trimmed = publicHandle.trim()
  if (trimmed && validateUsername(trimmed).isValid) {
    return trimmed
  }

  return `anon${randomString(12, RANDOM_LETTERS)}`
}

const createEphemeralPassword = (): string => `Aa1${randomString(45, RANDOM_PASSWORD_CHARS)}`

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

    const result = validateUsername(value)
    if (!result.isValid) {
      return USERNAME_CONSTRAINT.patternMessage
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
      const username = buildAnonymousUsername(publicHandle.value)
      const password = createEphemeralPassword()

      await register({ username, password, confirmPassword: password })
      await ensureUserInfo(true)
      syncAuthPhase()
      if (userStore.isLoggedIn) {
        markSessionActive()
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
