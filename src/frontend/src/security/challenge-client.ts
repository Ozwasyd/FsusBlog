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
  type ChallengeProofStore,
  type SecurityChallengeProof
} from './challenge-proof-store'

export type ChallengeKindGroup = 'captcha' | 'pow' | 'pospace' | 'passkey' | 'unsupported'
export type ChallengeIssueStatus = 'verified' | 'allow' | 'challenge' | 'unsupported' | 'failed'
export type ChallengeVerifyStatus = 'verified' | 'failed'

export interface SecurityChallengeContext {
  action: string
  routeKey: string
  attributes?: Record<string, unknown>
  deviceFingerprint?: string
}

export interface SecurityChallengeIssueResult {
  status: ChallengeIssueStatus
  response: SecurityChallengeIssueResponse | null
  assignment: SecurityChallengeAssignment | null
  providerPayload: SecurityChallengeProviderPayload | null
  proof: SecurityChallengeProof | null
  kindGroup: ChallengeKindGroup | null
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

export interface SecurityChallengeClient {
  issue(context: SecurityChallengeContext, options?: { forceRefresh?: boolean }): Promise<SecurityChallengeIssueResult>
  refresh(context: SecurityChallengeContext): Promise<SecurityChallengeIssueResult>
  verify(context: SecurityChallengeContext, request: VerifySecurityChallengeRequest): Promise<SecurityChallengeVerifyResult>
  getCachedProof(context: SecurityChallengeContext): SecurityChallengeProof | null
  clearProof(context: SecurityChallengeContext): void
}

export interface SecurityChallengeClientOptions {
  issueChallenge?: (request: IssueSecurityChallengeRequest) => Promise<SecurityChallengeIssueResponse>
  verifyChallenge?: (request: VerifySecurityChallengeRequest) => Promise<SecurityChallengeVerifyResponse>
  proofStore?: ChallengeProofStore
  now?: () => number
  proofTtlMs?: number
}

const DEFAULT_PROOF_TTL_MS = 5 * 60 * 1000

export function createSecurityChallengeClient(options: SecurityChallengeClientOptions = {}): SecurityChallengeClient {
  const issueChallenge = options.issueChallenge ?? issueSecurityChallenge
  const verifyChallenge = options.verifyChallenge ?? verifySecurityChallenge
  const proofStore = options.proofStore ?? defaultChallengeProofStore
  const now = options.now ?? (() => Date.now())
  const proofTtlMs = Math.max(1000, options.proofTtlMs ?? DEFAULT_PROOF_TTL_MS)

  const getCachedProof = (context: SecurityChallengeContext): SecurityChallengeProof | null =>
    proofStore.get(context.action, context.routeKey)

  const clearProof = (context: SecurityChallengeContext): void => {
    proofStore.delete(context.action, context.routeKey)
  }

  async function issue(context: SecurityChallengeContext, issueOptions: { forceRefresh?: boolean } = {}): Promise<SecurityChallengeIssueResult> {
    if (!issueOptions.forceRefresh) {
      const proof = getCachedProof(context)
      if (proof) {
        return {
          status: 'verified',
          response: null,
          assignment: null,
          providerPayload: null,
          proof,
          kindGroup: getChallengeKindGroup(proof.kind),
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
      if (kindGroup === 'unsupported') {
        return {
          status: 'unsupported',
          response,
          assignment,
          providerPayload: null,
          proof: null,
          kindGroup,
          reason: 'security_challenge_kind_unsupported',
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
      const proof: SecurityChallengeProof = {
        action: context.action,
        routeKey: context.routeKey,
        challengeId: response.challengeId,
        kind: response.kind,
        proofToken: response.proofToken,
        policyVersion: response.policyVersion,
        verifiedAtUnixMs,
        expiresAtUnixMs: verifiedAtUnixMs + proofTtlMs
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
    getCachedProof,
    clearProof
  }
}

export function getChallengeKindGroup(kind: SecurityChallengeKind): ChallengeKindGroup {
  switch (kind) {
    case SecurityChallengeKind.CaptchaV1:
      return 'captcha'
    case SecurityChallengeKind.Sha256PowV1:
    case SecurityChallengeKind.HumanReadProofV1:
      return 'pow'
    case SecurityChallengeKind.Argon2IdPoSpaceV1:
      return 'pospace'
    case SecurityChallengeKind.PasskeyStepUpV1:
    case SecurityChallengeKind.AdminPasskeyStepUpV1:
    case SecurityChallengeKind.RecoveryKeyProofV1:
    case SecurityChallengeKind.AnonymousCredentialProofV1:
    case SecurityChallengeKind.ZkAnonymousCommentProofV1:
      return 'passkey'
    default:
      return 'unsupported'
  }
}

function allowResult(response: SecurityChallengeIssueResponse): SecurityChallengeIssueResult {
  return {
    status: 'allow',
    response,
    assignment: null,
    providerPayload: null,
    proof: null,
    kindGroup: null,
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
    reason,
    retryAfterMs: response?.retryAfterMs ?? 0
  }
}
