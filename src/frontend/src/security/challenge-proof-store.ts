import type { SecurityChallengeKind } from '@/api/security'

export interface SecurityChallengeProof {
  action: string
  routeKey: string
  challengeId: string
  kind: SecurityChallengeKind
  proofToken: string
  policyVersion: string
  verifiedAtUnixMs: number
  expiresAtUnixMs: number
}

export interface ChallengeProofStore {
  get(action: string, routeKey: string): SecurityChallengeProof | null
  set(proof: SecurityChallengeProof): void
  delete(action: string, routeKey: string): void
  clear(): void
}

export interface ChallengeProofStoreOptions {
  now?: () => number
  expirySkewMs?: number
}

const DEFAULT_EXPIRY_SKEW_MS = 1000

export function createChallengeProofStore(options: ChallengeProofStoreOptions = {}): ChallengeProofStore {
  const now = options.now ?? (() => Date.now())
  const expirySkewMs = Math.max(0, options.expirySkewMs ?? DEFAULT_EXPIRY_SKEW_MS)
  const proofs = new Map<string, SecurityChallengeProof>()

  return {
    get(action, routeKey) {
      const key = proofKey(action, routeKey)
      const proof = proofs.get(key)
      if (!proof) {
        return null
      }
      if (proof.expiresAtUnixMs - expirySkewMs <= now()) {
        proofs.delete(key)
        return null
      }
      return { ...proof }
    },
    set(proof) {
      proofs.set(proofKey(proof.action, proof.routeKey), { ...proof })
    },
    delete(action, routeKey) {
      proofs.delete(proofKey(action, routeKey))
    },
    clear() {
      proofs.clear()
    }
  }
}

export function proofKey(action: string, routeKey: string): string {
  return `${action.trim()}\x1f${routeKey.trim()}`
}

export const defaultChallengeProofStore = createChallengeProofStore()
