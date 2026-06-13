import { startMfaChallenge, verifyMfaChallenge } from '@/api/auth'
import { promptText } from '@/fsusui/feedback'

const AdminSensitiveAction = 'admin-sensitive'

export function useAdminSensitiveProof() {
  const ensureAdminSensitiveProof = async (): Promise<string> => {
    const challenge = await startMfaChallenge(AdminSensitiveAction)
    if (challenge.verified && challenge.proofToken) {
      return challenge.proofToken
    }

    const challengeToken = challenge.proofToken
    if (!challengeToken) {
      throw new Error('MFA_CHALLENGE_REQUIRED')
    }

    const code = await promptText('Enter MFA code or recovery code', 'Admin step-up verification', {
      confirmButtonText: 'Confirm',
      cancelButtonText: 'Cancel',
      inputPlaceholder: 'Code or recovery code',
      inputValidator: (value: string) => value.trim().length > 0 || 'Enter a code or recovery code'
    })
    if (!code) {
      throw new Error('MFA_CHALLENGE_CANCELLED')
    }

    const proof = await verifyMfaChallenge({
      challengeToken,
      code,
      action: AdminSensitiveAction
    })
    if (!proof.verified || !proof.proofToken) {
      throw new Error('MFA_PROOF_REQUIRED')
    }

    return proof.proofToken
  }

  return {
    ensureAdminSensitiveProof
  }
}
