import type { SecurityChallengeKind } from './binaryApi'

export interface RiskChallengeProof {
  action: string
  routeKey: string
  challengeId: string
  kind: SecurityChallengeKind
  proofToken: string
  policyVersion: string
  verifiedAtUnixMs: number
  expiresAtUnixMs: number
}

export type RiskChallengeProofSettlement =
  | 'before_send_cancelled'
  | 'accepted'
  | 'business_rejected'
  | 'expired'
  | 'replayed'
  | 'binding_mismatch'
  | 'revoked'
  | 'rejected'
  | 'unknown_network'

/**
 * Opaque lease produced only by the challenge proof store. Binary callers pass
 * the lease itself instead of constructing protocol headers or token maps.
 */
export interface RiskChallengeProofContext {
  readonly proof: RiskChallengeProof
  markInFlight(): boolean
  settle(outcome: RiskChallengeProofSettlement): boolean
}

export type RiskChallengeFailureReason =
  | 'required'
  | 'expired'
  | 'replayed'
  | 'binding_mismatch'
  | 'revoked'
  | 'rejected'

export type RiskControlDecision = 'challenge' | 'stepUp' | 'queue' | 'throttle' | 'block' | 'reject'

export interface RiskChallengeHandoff {
  decision: 'challenge' | 'stepUp'
  action: string
  routeKey: string
  policyVersion: string
}
