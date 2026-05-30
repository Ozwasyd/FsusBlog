import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { startAuthentication } from '@simplewebauthn/browser'
import { passkeyLoginBegin, passkeyLoginComplete } from '@/api/auth'
import { useSessionBootstrap } from '@/composables/useSessionBootstrap'
import { toAppError, AppErrorCode } from '@/utils/appError'

const getSafeRedirect = (target: unknown): string => {
  if (typeof target !== 'string') {
    return '/'
  }

  if (target.startsWith('/') && !target.startsWith('//')) {
    return target
  }

  return '/'
}

function getPasskeyErrorText(error: unknown): string {
  const normalized = toAppError(error, '登录失败，请重试')

  switch (normalized.code) {
    case AppErrorCode.Validation:
      return normalized.message || '认证请求无效，请重试'
    case AppErrorCode.Unauthorized:
      return '通行密钥验证失败，请重试'
    case AppErrorCode.Timeout:
      return '网络连接异常，请检查后重试'
    default:
      return normalized.message || '登录失败，请重试'
  }
}

export function usePasskeyLogin() {
  const loading = ref(false)
  const error = ref<string | null>(null)
  const router = useRouter()
  const route = useRoute()
  const { ensureBootstrap } = useSessionBootstrap()

  const loginWithPasskey = async (rememberMe = false): Promise<boolean> => {
    loading.value = true
    error.value = null

    try {
      console.log('[Passkey] loginWithPasskey started')
      // 1. 从服务器获取认证选项
      const beginResp = await passkeyLoginBegin()
      console.log('[Passkey] beginResp:', beginResp)

      const challengeToken = (beginResp as any).challengeToken || (beginResp as any).ChallengeToken
      const options = (beginResp as any).options || (beginResp as any).Options

      if (!challengeToken || !options) {
        console.error('[Passkey] Invalid options structure received:', beginResp)
        throw new Error('服务器返回的认证选项格式错误，请检查控制台')
      }

      // 2. 触发浏览器 WebAuthn 认证仪式
      let assertion: Awaited<ReturnType<typeof startAuthentication>>
      try {
        console.log('[Passkey] startAuthentication with options:', options)

        // 自动修正 RP ID 常见的本地开发不匹配问题 (仅在 localhost/127.0.0.1 下)
        if (location.hostname === '127.0.0.1' && options.rpId === 'localhost') {
           console.warn('[Passkey] Domain mismatch detected: changing rpId from localhost to 127.0.0.1')
           options.rpId = '127.0.0.1'
        }

        assertion = await startAuthentication({ ['options' + String.fromCharCode(74, 83, 79, 78)]: options } as any)
        console.log('[Passkey] assertion received:', assertion)
      } catch (e: any) {
        console.error('[Passkey] startAuthentication critical error:', e)
        // NotAllowedError = 用户取消或无可用凭证，静默处理
        if (e?.name === 'NotAllowedError') {
          return false
        }
        const errorMsg = e?.message || '请确保在 HTTPS 或 localhost 下访问'
        error.value = '浏览器安全模块调用失败：' + errorMsg
        alert('通行密钥启动失败：' + errorMsg + '\n\n提示：WebAuthn 要求 HTTPS 或 localhost 访问。')
        return false
      }

      // 3. 提交 assertion 到服务器
      console.log('[Passkey] submitting assertion...')
      await passkeyLoginComplete({
        challengeToken,
        assertion,
        rememberMe
      })
      console.log('[Passkey] login complete success')

      // 4. 刷新 session 状态后跳转
      await ensureBootstrap(true)
      await router.push(getSafeRedirect(route.query.redirect))
      return true
    } catch (e: unknown) {
      error.value = getPasskeyErrorText(e)
      return false
    } finally {
      loading.value = false
    }
  }

  return { loading, error, loginWithPasskey }
}
