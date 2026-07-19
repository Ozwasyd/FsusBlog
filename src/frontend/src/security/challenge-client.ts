import {
  issueSecurityChallenge,
  SecurityChallengeKind,
  verifySecurityChallenge,
  type IssueSecurityChallengeRequest,
  type SecurityChallengeAssignment,
  type SecurityChallengeIssueResponse,
  type SecurityChallengeProviderPayload,
  type SecurityChallengeVerifyResponse,
  type VerifySecurityChallengeRequest
} from '@/api/security'
import { getErrorMessage } from '@/utils/errors'
import {
  defaultChallengeProofStore,
  type ChallengeProofSettlement,
  type ChallengeProofStore,
  type SecurityChallengeProof
} from './challenge-proof-store'
import type { RiskChallengeProofContext } from '@/contracts/riskChallenge'
import {
  getChallengeCapabilityRegistration,
  resolveChallengeCapability,
  type ChallengeCapabilityResolution,
  type ChallengeExecutionMode,
  type ChallengeKindGroup
} from './challenge-capability-registry'

export type { ChallengeKindGroup } from './challenge-capability-registry'
export type ChallengeIssueStatus = 'verified' | 'allow' | 'challenge' | 'unsupported' | 'failed'
export type ChallengeVerifyStatus = 'verified' | 'failed'

export interface SecurityChallengeContext {
  action: string
  routeKey: string
  attributes?: Record<string, unknown>
  deviceFingerprint?: string
  executionMode?: ChallengeExecutionMode
  capabilityManifestVersion?: string
}

export interface SecurityChallengeIssueResult {
  status: ChallengeIssueStatus
  response: SecurityChallengeIssueResponse | null
  assignment: SecurityChallengeAssignment | null
  providerPayload: SecurityChallengeProviderPayload | null
  proof: SecurityChallengeProof | null
  kindGroup: ChallengeKindGroup | null
  capability: ChallengeCapabilityResolution | null
  reason: string | null
  retryAfterMs: number
}

export interface SecurityChallengeVerifyResult {
  status: ChallengeVerifyStatus
  response: SecurityChallengeVerifyResponse | null
  proof: SecurityChallengeProof | null
  reason: string | null
  retryAfterMs: number
}

export interface SecurityChallengeProofLease extends RiskChallengeProofContext {
  readonly proof: SecurityChallengeProof
  settle(outcome: ChallengeProofSettlement): boolean
}

export interface SecurityChallengeClient {
  issue(context: SecurityChallengeContext, options?: { forceRefresh?: boolean }): Promise<SecurityChallengeIssueResult>
  refresh(context: SecurityChallengeContext): Promise<SecurityChallengeIssueResult>
  verify(context: SecurityChallengeContext, request: VerifySecurityChallengeRequest): Promise<SecurityChallengeVerifyResult>
  reserveProof(context: SecurityChallengeContext): SecurityChallengeProofLease | null
  clearProof(context: SecurityChallengeContext): void
}

export interface SecurityChallengeClientOptions {
  issueChallenge?: (request: IssueSecurityChallengeRequest) => Promise<SecurityChallengeIssueResponse>
  verifyChallenge?: (request: VerifySecurityChallengeRequest) => Promise<SecurityChallengeVerifyResponse>
  proofStore?: ChallengeProofStore
  now?: () => number
}

export const securityBusinessChallengeGates = {
  'comment.create': 'perception-v2',
  'auth.login': 'fallback',
  'recovery-key.verify': 'fallback'
} as const

export function createSecurityChallengeClient(options: SecurityChallengeClientOptions = {}): SecurityChallengeClient {
  const issueChallenge = options.issueChallenge ?? issueSecurityChallenge
  const verifyChallenge = options.verifyChallenge ?? verifySecurityChallenge
  const proofStore = options.proofStore ?? defaultChallengeProofStore
  const now = options.now ?? (() => Date.now())

  const reserveProof = (context: SecurityChallengeContext): SecurityChallengeProofLease | null => {
    const reservation = proofStore.reserve(context.action, context.routeKey)
    if (!reservation) {
      return null
    }
    return {
      proof: reservation.proof,
      markInFlight: () => proofStore.markInFlight(reservation.reservationId),
      settle: (outcome) => proofStore.settle(reservation.reservationId, outcome)
    }
  }

  const clearProof = (context: SecurityChallengeContext): void => {
    proofStore.delete(context.action, context.routeKey)
  }

  async function issue(context: SecurityChallengeContext, issueOptions: { forceRefresh?: boolean } = {}): Promise<SecurityChallengeIssueResult> {
    if (!issueOptions.forceRefresh) {
      const proof = proofStore.peek(context.action, context.routeKey)
      if (proof) {
        return {
          status: 'verified',
          response: null,
          assignment: null,
          providerPayload: null,
          proof,
          kindGroup: getChallengeKindGroup(proof.kind),
          capability: resolveChallengeCapability(proof.kind, capabilityOptions(context)),
          reason: null,
          retryAfterMs: 0
        }
      }
    } else {
      clearProof(context)
    }

    try {
      const response = await issueChallenge({
        action: context.action,
        routeKey: context.routeKey,
        attributes: context.attributes,
        deviceFingerprint: context.deviceFingerprint
      })
      if (response.decision === 'allow') {
        return allowResult(response)
      }
      if (response.decision !== 'challenge' && response.decision !== 'stepUp') {
        return failedIssueResult(response, `security_challenge_${response.decision || 'failed'}`)
      }

      const assignment = response.envelope?.assignments[0] ?? null
      if (!assignment) {
        return failedIssueResult(response, 'security_challenge_assignment_missing')
      }
      if (assignment.expiresAtUnixMs <= now()) {
        return failedIssueResult(response, 'security_challenge_expired')
      }

      const kindGroup = getChallengeKindGroup(assignment.kind)
      const capability = resolveChallengeCapability(assignment.kind, capabilityOptions(context))
      if (!capability.policyEligible) {
        return {
          status: 'unsupported',
          response,
          assignment,
          providerPayload: null,
          proof: null,
          kindGroup,
          capability,
          reason: `security_challenge_${capability.unavailableReason ?? 'unavailable'}`,
          retryAfterMs: response.retryAfterMs
        }
      }

      const providerPayload = response.providerPayloads.find((item) => item.challengeId === assignment.challengeId) ?? null
      return {
        status: 'challenge',
        response,
        assignment,
        providerPayload,
        proof: null,
        kindGroup,
        capability,
        reason: null,
        retryAfterMs: response.retryAfterMs
      }
    } catch (error) {
      return failedIssueResult(null, getErrorMessage(error, 'security_challenge_issue_failed'))
    }
  }

  async function verify(context: SecurityChallengeContext, request: VerifySecurityChallengeRequest): Promise<SecurityChallengeVerifyResult> {
    try {
      const response = await verifyChallenge(request)
      if (!response.verified || !response.proofToken?.trim()) {
        return {
          status: 'failed',
          response,
          proof: null,
          reason: response.reason || 'security_challenge_verify_failed',
          retryAfterMs: response.retryAfterMs
        }
      }

      const verifiedAtUnixMs = now()
      if (!Number.isFinite(response.expiresAtUnixMs) || response.expiresAtUnixMs <= verifiedAtUnixMs) {
        return {
          status: 'failed',
          response,
          proof: null,
          reason: 'security_challenge_proof_expired',
          retryAfterMs: response.retryAfterMs
        }
      }
      const proof: SecurityChallengeProof = {
        action: context.action,
        routeKey: context.routeKey,
        challengeId: response.challengeId,
        kind: response.kind,
        proofToken: response.proofToken,
        policyVersion: response.policyVersion,
        verifiedAtUnixMs,
        expiresAtUnixMs: response.expiresAtUnixMs
      }
      proofStore.set(proof)
      return {
        status: 'verified',
        response,
        proof,
        reason: null,
        retryAfterMs: response.retryAfterMs
      }
    } catch (error) {
      return {
        status: 'failed',
        response: null,
        proof: null,
        reason: getErrorMessage(error, 'security_challenge_verify_failed'),
        retryAfterMs: 0
      }
    }
  }

  return {
    issue,
    refresh(context) {
      return issue(context, { forceRefresh: true })
    },
    verify,
    reserveProof,
    clearProof
  }
}

export function getChallengeKindGroup(kind: SecurityChallengeKind): ChallengeKindGroup {
  return getChallengeCapabilityRegistration(kind).group
}

function capabilityOptions(context: SecurityChallengeContext) {
  return {
    action: context.action,
    mode: context.executionMode ?? 'ui',
    manifestVersion: context.capabilityManifestVersion
  } as const
}

function allowResult(response: SecurityChallengeIssueResponse): SecurityChallengeIssueResult {
  return {
    status: 'allow',
    response,
    assignment: null,
    providerPayload: null,
    proof: null,
    kindGroup: null,
    capability: null,
    reason: null,
    retryAfterMs: response.retryAfterMs
  }
}

function failedIssueResult(response: SecurityChallengeIssueResponse | null, reason: string): SecurityChallengeIssueResult {
  return {
    status: 'failed',
    response,
    assignment: null,
    providerPayload: null,
    proof: null,
    kindGroup: null,
    capability: null,
    reason,
    retryAfterMs: response?.retryAfterMs ?? 0
  }
}
