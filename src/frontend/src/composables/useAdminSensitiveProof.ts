import { startAuthentication } from '@simplewebauthn/browser'
import { adminStepUpPasskeyBegin, adminStepUpPasskeyComplete } from '@/api/auth'

const AdminSensitiveAction = 'admin-sensitive'

type AdminSensitiveProofWindow = Window & {
  __FSUSBLOG_ADMIN_SENSITIVE_PROOF_TOKEN__?: string | (() => string | Promise<string>)
}

async function readInjectedProofToken(): Promise<string | null> {
  if (import.meta.env.PROD || typeof window === 'undefined') {
    return null
  }

  const runtimeWindow = window as AdminSensitiveProofWindow
  const source = runtimeWindow.__FSUSBLOG_ADMIN_SENSITIVE_PROOF_TOKEN__
  if (!source) {
    return null
  }

  const token = typeof source === 'function'
    ? await source()
    : source
  if (typeof source !== 'function') {
    Reflect.deleteProperty(runtimeWindow, '__FSUSBLOG_ADMIN_SENSITIVE_PROOF_TOKEN__')
  }

  const normalized = token.trim()
  return normalized.length > 0 ? normalized : null
}

export function useAdminSensitiveProof() {
  const ensureAdminSensitiveProof = async (): Promise<string> => {
    const injectedProofToken = await readInjectedProofToken()
    if (injectedProofToken) {
      return injectedProofToken
    }

    const challenge = await adminStepUpPasskeyBegin()
    const challengeToken = (challenge as any).challengeToken || (challenge as any).ChallengeToken
    const options = (challenge as any).options || (challenge as any).Options
    if (!challengeToken || !options) {
      throw new Error('ADMIN_STEP_UP_CHALLENGE_REQUIRED')
    }

    if (globalThis.location?.hostname === '127.0.0.1' && options.rpId === 'localhost') {
      options.rpId = '127.0.0.1'
    }

    const assertion = await startAuthentication({ ['options' + String.fromCharCode(74, 83, 79, 78)]: options } as any)
    const proof = await adminStepUpPasskeyComplete({
      challengeToken,
      assertion
    })
    if (!proof.verified || proof.action !== AdminSensitiveAction || !proof.proofToken) {
      throw new Error('MFA_PROOF_REQUIRED')
    }

    return proof.proofToken
  }

  return {
    ensureAdminSensitiveProof
  }
}
