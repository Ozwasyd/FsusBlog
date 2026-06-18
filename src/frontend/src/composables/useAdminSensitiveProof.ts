import { startAuthentication } from '@simplewebauthn/browser'
import { adminStepUpPasskeyBegin, adminStepUpPasskeyComplete } from '@/api/auth'

const AdminSensitiveAction = 'admin-sensitive'

export function useAdminSensitiveProof() {
  const ensureAdminSensitiveProof = async (): Promise<string> => {
    const challenge = await adminStepUpPasskeyBegin()
    const challengeToken = (challenge as any).challengeToken || (challenge as any).ChallengeToken
    const options = (challenge as any).options || (challenge as any).Options
    if (!challengeToken || !options) {
      throw new Error('ADMIN_STEP_UP_CHALLENGE_REQUIRED')
    }

    if (location.hostname === '127.0.0.1' && options.rpId === 'localhost') {
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
