import {
  cancelSecurityChallenge,
  issueSecurityChallenge,
  SecurityChallengeKind,
  verifySecurityChallenge,
  type CancelSecurityChallengeRequest,
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
  SECURITY_CHALLENGE_CAPABILITY_MANIFEST_VERSION,
  type ChallengeCapabilityResolution,
  type ChallengeExecutionMode,
  type ChallengeKindGroup
} from './challenge-capability-registry'

export type { ChallengeKindGroup } from './challenge-capability-registry'
export type ChallengeIssueStatus = 'verified' | 'allow' | 'challenge' | 'unsupported' | 'failed'
export type ChallengeVerifyStatus = 'verified' | 'continue' | 'unsupported' | 'failed'
export type SecurityChallengeMemberVerifyRequest = Omit<VerifySecurityChallengeRequest, 'envelopeId'> & {
  envelopeId?: string
}

export interface SecurityChallengeContext {
  action: string
  routeKey: string
  attributes?: Record<string, unknown>
  deviceFingerprint?: string
  executionMode?: ChallengeExecutionMode
  capabilityManifestVersion?: string
  identity?: string
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
  next: SecurityChallengeIssueResult | null
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
  verify(context: SecurityChallengeContext, request: SecurityChallengeMemberVerifyRequest): Promise<SecurityChallengeVerifyResult>
  reserveProof(context: SecurityChallengeContext): SecurityChallengeProofLease | null
  cancelEnvelope(context: SecurityChallengeContext): void
  clearProof(context: SecurityChallengeContext): void
}

export interface SecurityChallengeClientOptions {
  cancelChallenge?: (request: CancelSecurityChallengeRequest) => Promise<unknown>
  issueChallenge?: (request: IssueSecurityChallengeRequest, config?: { signal?: AbortSignal }) => Promise<SecurityChallengeIssueResponse>
  verifyChallenge?: (request: VerifySecurityChallengeRequest, config?: { signal?: AbortSignal }) => Promise<SecurityChallengeVerifyResponse>
  proofStore?: ChallengeProofStore
  now?: () => number
}

export function createSecurityChallengeClient(options: SecurityChallengeClientOptions = {}): SecurityChallengeClient {
  const cancelChallenge = options.cancelChallenge ?? cancelSecurityChallenge
  const issueChallenge = options.issueChallenge ?? issueSecurityChallenge
  const verifyChallenge = options.verifyChallenge ?? verifySecurityChallenge
  const proofStore = options.proofStore ?? defaultChallengeProofStore
  const now = options.now ?? (() => Date.now())
  const envelopeRuns = new Map<string, ActiveEnvelopeRun>()
  const contextGenerations = new Map<string, number>()
  const activeRequests = new Map<string, AbortController>()

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
    invalidateContext(context)
  }

  const cancelEnvelope = (context: SecurityChallengeContext): void => {
    invalidateContext(context)
  }

  async function issue(context: SecurityChallengeContext, issueOptions: { forceRefresh?: boolean } = {}): Promise<SecurityChallengeIssueResult> {
    const operation = beginContextGeneration(context)
    if (!issueOptions.forceRefresh) {
      const proof = proofStore.peek(context.action, context.routeKey)
      if (proof) {
        finishRequest(operation)
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
      proofStore.delete(context.action, context.routeKey)
    }

    try {
      const response = await issueChallenge({
        action: context.action,
        routeKey: context.routeKey,
        attributes: context.attributes,
        deviceFingerprint: context.deviceFingerprint,
        capabilityManifestVersion: effectiveCapabilityManifestVersion(context)
      }, { signal: operation.controller.signal })
      if (!isCurrentOperation(operation)) {
        return cancelledIssueResult()
      }
      if (response.decision === 'allow') {
        return allowResult(response)
      }
      if (response.decision !== 'challenge' && response.decision !== 'stepUp') {
        return failedIssueResult(response, `security_challenge_${response.decision || 'failed'}`)
      }
      const run = createEnvelopeRun(context, response, operation.generation)
      if (!run) {
        return failedIssueResult(response, 'security_challenge_envelope_invalid')
      }
      envelopeRuns.set(operation.key, run)
      return selectEnvelopeMember(context, run, 0, now())
    } catch (error) {
      if (!isCurrentOperation(operation) || operation.controller.signal.aborted) {
        return cancelledIssueResult()
      }
      return failedIssueResult(null, getErrorMessage(error, 'security_challenge_issue_failed'))
    } finally {
      finishRequest(operation)
    }
  }

  async function verify(context: SecurityChallengeContext, request: SecurityChallengeMemberVerifyRequest): Promise<SecurityChallengeVerifyResult> {
    const key = contextKey(context)
    const run = envelopeRuns.get(key)
    const assignment = run?.response.envelope?.assignments[run.completedCount] ?? null
    if (!run || !assignment) {
      return failedVerifyResult('security_challenge_envelope_missing')
    }
    if ((request.envelopeId && request.envelopeId !== run.envelopeId) ||
        request.challengeId !== assignment.challengeId || request.kind !== assignment.kind ||
        request.action !== context.action || request.routeKey !== context.routeKey) {
      return failedVerifyResult('security_challenge_member_mismatch')
    }

    const operation = beginRequest(key, run.generation)
    try {
      const response = await verifyChallenge(
        { ...request, envelopeId: run.envelopeId },
        { signal: operation.controller.signal })
      if (!isCurrentOperation(operation) || envelopeRuns.get(key) !== run) {
        return failedVerifyResult('security_challenge_request_cancelled')
      }
      if (!isExpectedProgressResponse(run, assignment, response)) {
        return failedVerifyResult('security_challenge_progress_invalid', response)
      }
      if (!response.verified) {
        return failedVerifyResult(response.reason || 'security_challenge_verify_failed', response)
      }

      if (!response.envelopeCompleted) {
        run.completedCount = response.completedCount
        const next = selectEnvelopeMember(context, run, run.completedCount, now())
        return {
          status: next.status === 'unsupported' ? 'unsupported' : next.status === 'challenge' ? 'continue' : 'failed',
          response,
          proof: null,
          next,
          reason: next.reason,
          retryAfterMs: response.retryAfterMs
        }
      }

      const verifiedAtUnixMs = now()
      if (!Number.isFinite(response.expiresAtUnixMs) || response.expiresAtUnixMs <= verifiedAtUnixMs) {
        return {
          status: 'failed',
          response,
          proof: null,
          next: null,
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
      envelopeRuns.delete(key)
      return {
        status: 'verified',
        response,
        proof,
        next: null,
        reason: null,
        retryAfterMs: response.retryAfterMs
      }
    } catch (error) {
      if (!isCurrentOperation(operation) || operation.controller.signal.aborted) {
        return failedVerifyResult('security_challenge_request_cancelled')
      }
      return {
        status: 'failed',
        response: null,
        proof: null,
        next: null,
        reason: getErrorMessage(error, 'security_challenge_verify_failed'),
        retryAfterMs: 0
      }
    } finally {
      finishRequest(operation)
    }
  }

  function invalidateContext(context: SecurityChallengeContext): void {
    const key = contextKey(context)
    revokeRun(context, envelopeRuns.get(key))
    activeRequests.get(key)?.abort()
    activeRequests.delete(key)
    contextGenerations.set(key, (contextGenerations.get(key) ?? 0) + 1)
    envelopeRuns.delete(key)
  }

  function beginContextGeneration(context: SecurityChallengeContext): ChallengeClientOperation {
    const key = contextKey(context)
    revokeRun(context, envelopeRuns.get(key))
    activeRequests.get(key)?.abort()
    const generation = (contextGenerations.get(key) ?? 0) + 1
    contextGenerations.set(key, generation)
    envelopeRuns.delete(key)
    return beginRequest(key, generation)
  }

  function revokeRun(context: SecurityChallengeContext, run: ActiveEnvelopeRun | undefined): void {
    if (!run) {
      return
    }

    const request: CancelSecurityChallengeRequest = {
      envelopeId: run.envelopeId,
      action: context.action,
      routeKey: context.routeKey,
      deviceFingerprint: context.deviceFingerprint,
      policyVersion: run.response.policyVersion
    }
    void cancelChallenge(request).catch(() => cancelChallenge(request).catch(() => undefined))
  }

  function beginRequest(key: string, generation: number): ChallengeClientOperation {
    activeRequests.get(key)?.abort()
    const controller = new AbortController()
    activeRequests.set(key, controller)
    return { key, generation, controller }
  }

  function isCurrentOperation(operation: ChallengeClientOperation): boolean {
    return !operation.controller.signal.aborted &&
      contextGenerations.get(operation.key) === operation.generation &&
      activeRequests.get(operation.key) === operation.controller
  }

  function finishRequest(operation: ChallengeClientOperation): void {
    if (activeRequests.get(operation.key) === operation.controller) {
      activeRequests.delete(operation.key)
    }
  }

  return {
    issue,
    refresh(context) {
      return issue(context, { forceRefresh: true })
    },
    verify,
    reserveProof,
    cancelEnvelope,
    clearProof
  }
}

interface ActiveEnvelopeRun {
  readonly envelopeId: string
  readonly response: SecurityChallengeIssueResponse
  readonly generation: number
  completedCount: number
}

interface ChallengeClientOperation {
  readonly key: string
  readonly generation: number
  readonly controller: AbortController
}

function createEnvelopeRun(
  context: SecurityChallengeContext,
  response: SecurityChallengeIssueResponse,
  generation: number
): ActiveEnvelopeRun | null {
  const envelope = response.envelope
  if (!envelope || !isUuidV7(envelope.envelopeId) || envelope.policyVersion !== response.policyVersion ||
      envelope.assignments.length < 1 || envelope.assignments.length > 8) {
    return null
  }
  const ids = new Set<string>()
  for (const assignment of envelope.assignments) {
    if (!assignment.challengeId || ids.has(assignment.challengeId) ||
        assignment.action !== context.action || assignment.routeKey !== context.routeKey) {
      return null
    }
    ids.add(assignment.challengeId)
  }
  const assignmentIds = new Set(envelope.assignments.map((assignment) => assignment.challengeId))
  if (response.providerPayloads.some((payload) => !assignmentIds.has(payload.challengeId))) {
    return null
  }
  return { envelopeId: envelope.envelopeId, response, generation, completedCount: 0 }
}

function selectEnvelopeMember(
  context: SecurityChallengeContext,
  run: ActiveEnvelopeRun,
  index: number,
  currentTime: number
): SecurityChallengeIssueResult {
  const assignment = run.response.envelope?.assignments[index] ?? null
  if (!assignment) {
    return failedIssueResult(run.response, 'security_challenge_assignment_missing')
  }
  if (assignment.expiresAtUnixMs <= currentTime) {
    return failedIssueResult(run.response, 'security_challenge_expired')
  }
  const kindGroup = getChallengeKindGroup(assignment.kind)
  const capability = resolveChallengeCapability(assignment.kind, capabilityOptions(context))
  const providerPayload = run.response.providerPayloads.find((item) => item.challengeId === assignment.challengeId) ?? null
  if (!capability.policyEligible) {
    return {
      status: 'unsupported', response: run.response, assignment, providerPayload, proof: null, kindGroup, capability,
      reason: `security_challenge_${capability.unavailableReason ?? 'unavailable'}`,
      retryAfterMs: run.response.retryAfterMs
    }
  }
  if (!providerPayload) {
    return failedIssueResult(run.response, 'security_challenge_provider_payload_missing')
  }
  return {
    status: 'challenge', response: run.response, assignment, providerPayload, proof: null, kindGroup, capability,
    reason: null, retryAfterMs: run.response.retryAfterMs
  }
}

function isExpectedProgressResponse(
  run: ActiveEnvelopeRun,
  assignment: SecurityChallengeAssignment,
  response: SecurityChallengeVerifyResponse
): boolean {
  const memberCount = run.response.envelope?.assignments.length ?? 0
  return response.envelopeId === run.envelopeId && response.challengeId === assignment.challengeId &&
    response.kind === assignment.kind && response.policyVersion === run.response.policyVersion &&
    response.memberCount === memberCount &&
    response.completedCount === run.completedCount + 1
}

function failedVerifyResult(reason: string, response: SecurityChallengeVerifyResponse | null = null): SecurityChallengeVerifyResult {
  return { status: 'failed', response, proof: null, next: null, reason, retryAfterMs: response?.retryAfterMs ?? 0 }
}

function contextKey(context: SecurityChallengeContext): string {
  return `${context.action}\u0000${context.routeKey}\u0000${context.identity?.trim() ?? ''}`
}

function isUuidV7(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
}

export function getChallengeKindGroup(kind: SecurityChallengeKind): ChallengeKindGroup {
  return getChallengeCapabilityRegistration(kind).group
}

function capabilityOptions(context: SecurityChallengeContext) {
  return {
    action: context.action,
    mode: context.executionMode ?? 'ui',
    manifestVersion: effectiveCapabilityManifestVersion(context)
  } as const
}

function effectiveCapabilityManifestVersion(context: SecurityChallengeContext): string {
  return context.capabilityManifestVersion?.trim() || SECURITY_CHALLENGE_CAPABILITY_MANIFEST_VERSION
}

function cancelledIssueResult(): SecurityChallengeIssueResult {
  return failedIssueResult(null, 'security_challenge_request_cancelled')
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
