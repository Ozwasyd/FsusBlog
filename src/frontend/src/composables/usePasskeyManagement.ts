import { ref } from 'vue'
import { startRegistration } from '@simplewebauthn/browser'
import {
  passkeyRegisterBegin,
  passkeyRegisterComplete,
  listPasskeys,
  deletePasskey,
  renamePasskey,
  type PasskeyCredentialSummary
} from '@/api/auth'

export function usePasskeyManagement() {
  const credentials = ref<PasskeyCredentialSummary[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  const fetchPasskeys = async (): Promise<void> => {
    loading.value = true
    error.value = null
    try {
      const rawList = await listPasskeys()
      console.log('[Passkey] list raw:', rawList)
      // 映射到 camelCase 确保 UI 能够渲染
      credentials.value = (rawList as any[]).map(item => ({
        id: item.id ?? item.Id,
        deviceFriendlyName: item.deviceFriendlyName ?? item.DeviceFriendlyName,
        createdAt: item.createdAt ?? item.CreatedAt,
        lastUsedAt: item.lastUsedAt ?? item.LastUsedAt,
        aaGuid: item.aaGuid ?? item.AaGuid,
        backupEligible: item.backupEligible ?? item.BackupEligible,
        backupState: item.backupState ?? item.BackupState
      }))
    } catch (e: any) {
      error.value = e?.message ?? '获取通行密钥列表失败'
    } finally {
      loading.value = false
    }
  }

  const addPasskey = async (friendlyName?: string, mfaProofToken?: string): Promise<boolean> => {
    loading.value = true
    error.value = null
    try {
      // 1. 获取注册选项
      const beginResp = await passkeyRegisterBegin()
      console.log('[Passkey] register beginResp:', beginResp)
      const sessionKey = (beginResp as any).sessionKey || (beginResp as any).SessionKey
      const options = (beginResp as any).options || (beginResp as any).Options

      if (!sessionKey || !options) {
         throw new Error('服务器返回的注册会话无效')
      }

      // 2. 触发浏览器 WebAuthn 注册仪式
      let attestation: Awaited<ReturnType<typeof startRegistration>>
      try {
        attestation = await startRegistration({ ['options' + String.fromCharCode(74, 83, 79, 78)]: options } as any)
      } catch (e: any) {
        console.error('[Passkey] startRegistration error:', e)
        if (e?.name === 'NotAllowedError') {
          return false
        }
        error.value = '浏览器通行密钥注册失败：' + (e?.message || '未知错误')
        return false
      }

      // 3. 提交 attestation 到服务器
      await passkeyRegisterComplete({
        sessionKey,
        attestation,
        friendlyName: friendlyName ?? undefined,
        mfaProofToken: mfaProofToken ?? undefined
      })

      // 4. 刷新列表
      await fetchPasskeys()
      return true
    } catch (e: any) {
      error.value = e?.response?.data?.message ?? '注册通行密钥失败'
      return false
    } finally {
      loading.value = false
    }
  }

  const removePasskey = async (id: number, mfaProofToken?: string | null): Promise<boolean> => {
    loading.value = true
    error.value = null
    try {
      await deletePasskey(id, { mfaProofToken })
      credentials.value = credentials.value.filter(c => c.id !== id)
      return true
    } catch (e: any) {
      error.value = e?.response?.data?.message ?? '删除通行密钥失败'
      return false
    } finally {
      loading.value = false
    }
  }

  const renamePasskeyCredential = async (id: number, name: string, mfaProofToken?: string | null): Promise<boolean> => {
    loading.value = true
    error.value = null
    try {
      await renamePasskey(id, name, { mfaProofToken })
      const cred = credentials.value.find(c => c.id === id)
      if (cred) cred.deviceFriendlyName = name
      return true
    } catch (e: any) {
      error.value = e?.response?.data?.message ?? '重命名失败'
      return false
    } finally {
      loading.value = false
    }
  }

  return {
    credentials,
    loading,
    error,
    fetchPasskeys,
    addPasskey,
    removePasskey,
    renamePasskeyCredential
  }
}
