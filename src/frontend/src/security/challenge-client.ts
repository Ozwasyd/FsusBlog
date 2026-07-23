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
} from '@/api/security';
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
} from './challenge-capability-registry';
import {
    requestChallengeCapabilityReload,
    type ChallengeCapabilityReloadResult
} from './challenge-capability-reload';

export type { ChallengeKindGroup } from './challenge-capability-registry';
export type ChallengeIssueStatus = 'verified' | 'allow' | 'challenge' | 'unsupported' | 'failed';
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
    issue(context: SecurityChallengeContext, options?: { forceRefresh?: boolean; }): Promise<SecurityChallengeIssueResult>;
    refresh(context: SecurityChallengeContext, representation?: 'visual' | 'audio'): Promise<SecurityChallengeIssueResult>;
    replace(context: SecurityChallengeContext, representation: 'visual' | 'audio'): Promise<SecurityChallengeIssueResult>;
    verify(context: SecurityChallengeContext, request: SecurityChallengeMemberVerifyRequest): Promise<SecurityChallengeVerifyResult>;
    reserveProof(context: SecurityChallengeContext): SecurityChallengeProofLease | null;
    cancelEnvelope(context: SecurityChallengeContext): void;
  clearProof(context: SecurityChallengeContext): void
}

export interface SecurityChallengeClientOptions {
  cancelChallenge?: (request: CancelSecurityChallengeRequest) => Promise<unknown>
  issueChallenge?: (request: IssueSecurityChallengeRequest, config?: { signal?: AbortSignal }) => Promise<SecurityChallengeIssueResponse>
    verifyChallenge?: (request: VerifySecurityChallengeRequest, config?: { signal?: AbortSignal; }) => Promise<SecurityChallengeVerifyResponse>;
    proofStore?: ChallengeProofStore;
    now?: () => number;
    requestCapabilityReload?: (manifestVersion: string) => ChallengeCapabilityReloadResult;
}

export function createSecurityChallengeClient(options: SecurityChallengeClientOptions = {}): SecurityChallengeClient
{
  const cancelChallenge = options.cancelChallenge ?? cancelSecurityChallenge
  const issueChallenge = options.issueChallenge ?? issueSecurityChallenge
    const verifyChallenge = options.verifyChallenge ?? verifySecurityChallenge;
    const proofStore = options.proofStore ?? defaultChallengeProofStore;
    const now = options.now ?? (() => Date.now());
    const requestCapabilityReload = options.requestCapabilityReload ?? requestChallengeCapabilityReload;
    const envelopeRuns = new Map<string, ActiveEnvelopeRun>();
    const contextGenerations = new Map<string, number>();
    const activeRequests = new Map<string, AbortController>();

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
    };

    async function issue(context: SecurityChallengeContext, issueOptions: { forceRefresh?: boolean; } = {}): Promise<SecurityChallengeIssueResult>
{
        return issueInternal(context, { ...issueOptions, requestedRepresentation: 'visual' });
    }

    async function issueInternal(
        context: SecurityChallengeContext,
        issueOptions: {
            forceRefresh?: boolean;
            requestedRepresentation?: 'visual' | 'audio';
            replacementRepresentation?: 'visual' | 'audio';
        } = {}
    ): Promise<SecurityChallengeIssueResult>
{
        const activeV3 = issueOptions.replacementRepresentation ? currentV3Replacement(context) : null;
        const replacement = activeV3
            ? { challengeId: activeV3.challengeId, envelopeId: activeV3.envelopeId, stateToken: activeV3.stateToken }
            : null;
        if (issueOptions.replacementRepresentation && !replacement)
{
            return failedIssueResult(null, 'perception_character_v3_replacement_missing');
        }
        const replacementRun = replacement ? envelopeRuns.get(contextKey(context)) : undefined;
        const operation = beginContextGeneration(context, replacement === null);
        if (!issueOptions.forceRefresh)
{
            const proof = proofStore.peek(context.action, context.routeKey);
            if (proof)
{
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
                capabilityManifestVersion: effectiveCapabilityManifestVersion(context),
                ...(issueOptions.replacementRepresentation || issueOptions.requestedRepresentation
                    ? { representation: issueOptions.replacementRepresentation ?? issueOptions.requestedRepresentation }
                    : {}),
                ...(replacement ? { replacement } : {})
            }, { signal: operation.controller.signal });
            if (!isCurrentOperation(operation))
{
                revokeLateReplacementResponse(context, response, operation, replacementRun);
                return cancelledIssueResult();
            }
            if (response.decision === 'allow' && replacementRun)
{
                abandonReplacement(context, replacementRun);
                return failedIssueResult(response, 'security_challenge_issue_failed');
            }
            if (response.decision === 'allow')
{
                return allowResult(response);
            }
            if (response.decision !== 'challenge' && response.decision !== 'stepUp')
{
                abandonReplacement(context, replacementRun);
                return failedIssueResult(response, 'security_challenge_issue_failed');
            }
            const run = createEnvelopeRun(context, response, operation.generation);
            if (!run)
{
                abandonReplacement(context, replacementRun);
                return failedIssueResult(response, 'security_challenge_envelope_invalid');
            }
            envelopeRuns.set(operation.key, run);
            const selected = selectEnvelopeMember(context, run, 0, now());
            return selected.capability?.unavailableReason === 'version_incompatible'
                ? capabilityReloadResult(selected.response, requestCapabilityReload(effectiveCapabilityManifestVersion(context)))
                : selected;
        }
 catch (error)
{
            if (!isCurrentOperation(operation) || operation.controller.signal.aborted)
{
                return cancelledIssueResult();
            }
            abandonReplacement(context, replacementRun);
            if (isCapabilityManifestIncompatibleError(error))
{
                return capabilityReloadResult(null, requestCapabilityReload(effectiveCapabilityManifestVersion(context)));
            }
            return failedIssueResult(null, 'security_challenge_issue_failed');
        }
 finally
{
            finishRequest(operation);
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

        const operation = beginRequest(key, run.generation);
        try
{
            const response = sanitizeVerifyResponse(await verifyChallenge(
                { ...request, envelopeId: run.envelopeId },
                { signal: operation.controller.signal }));
            if (!isCurrentOperation(operation) || envelopeRuns.get(key) !== run)
{
                return failedVerifyResult('security_challenge_request_cancelled');
            }
      if (!isExpectedProgressResponse(run, assignment, response)) {
        return failedVerifyResult('security_challenge_progress_invalid', response)
      }
      if (!response.verified) {
        return failedVerifyResult(response.reason || 'security_challenge_verify_failed', response)
      }

      if (!response.envelopeCompleted) {
        if (!appendDeferredMember(context, run, response)) {
          return failedVerifyResult('security_challenge_progress_invalid', response)
        }
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
                reason: 'security_challenge_verify_failed',
                retryAfterMs: 0
            };
        }
 finally
{
      finishRequest(operation)
    }
  }

  function invalidateContext(context: SecurityChallengeContext): void {
    const key = contextKey(context)
    revokeRun(context, envelopeRuns.get(key))
    activeRequests.get(key)?.abort()
    activeRequests.delete(key)
    contextGenerations.set(key, (contextGenerations.get(key) ?? 0) + 1)
        envelopeRuns.delete(key);
    }

    function beginContextGeneration(context: SecurityChallengeContext, revokePrevious = true): ChallengeClientOperation
{
        const key = contextKey(context);
        if (revokePrevious)
{
            revokeRun(context, envelopeRuns.get(key));
            envelopeRuns.delete(key);
        }
        activeRequests.get(key)?.abort();
        const generation = (contextGenerations.get(key) ?? 0) + 1;
        contextGenerations.set(key, generation);
        return beginRequest(key, generation);
    }

    function currentV3Replacement(context: SecurityChallengeContext): {
        challengeId: string;
        envelopeId: string;
        stateToken: string;
        representation: 'visual' | 'audio';
    } | null
{
        const run = envelopeRuns.get(contextKey(context));
        const assignment = run?.response.envelope?.assignments[run.completedCount];
        const payload = assignment
            ? run?.response.providerPayloads.find((item) => item.challengeId === assignment.challengeId)
            : null;
        const typed = payload?.perceptionCharacterV3;
        return run && assignment?.kind === SecurityChallengeKind.PerceptionCharacterV3 && typed
            ? {
          challengeId: assignment.challengeId,
          envelopeId: run.envelopeId,
          stateToken: typed.stateToken,
          representation: typed.representation === 1 ? 'visual' : 'audio'
        }
            : null;
    }

    function revokeRun(context: SecurityChallengeContext, run: ActiveEnvelopeRun | undefined): void
{
        if (!run)
{
            return;
    }

    const request: CancelSecurityChallengeRequest = {
      envelopeId: run.envelopeId,
      action: context.action,
      routeKey: context.routeKey,
      deviceFingerprint: context.deviceFingerprint,
      policyVersion: run.response.policyVersion
    }
        void cancelChallenge(request).catch(() => cancelChallenge(request).catch(() => undefined));
    }

    function abandonReplacement(context: SecurityChallengeContext, run: ActiveEnvelopeRun | undefined): void
{
        if (!run || envelopeRuns.get(contextKey(context)) !== run)
{
            return;
        }
        revokeRun(context, run);
        envelopeRuns.delete(contextKey(context));
    }

    function revokeLateReplacementResponse(
        context: SecurityChallengeContext,
        response: SecurityChallengeIssueResponse,
        operation: ChallengeClientOperation,
        replacementRun: ActiveEnvelopeRun | undefined
    ): void
{
        if (!replacementRun || (response.decision !== 'challenge' && response.decision !== 'stepUp'))
{
            return;
        }
        const lateRun = createEnvelopeRun(context, response, operation.generation);
        if (lateRun)
{
            revokeRun(context, lateRun);
        }
    }

    function beginRequest(key: string, generation: number): ChallengeClientOperation
{
        activeRequests.get(key)?.abort();
        const controller = new AbortController();
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
        refresh(context, representation)
{
            const activeV3 = currentV3Replacement(context);
            if (activeV3)
{
                return issueInternal(context, {
                    forceRefresh: true,
                    replacementRepresentation: representation ?? activeV3.representation
                });
            }
            return issueInternal(context, { forceRefresh: true, requestedRepresentation: representation });
        },
        replace(context, representation)
{
            return issueInternal(context, { forceRefresh: true, replacementRepresentation: representation });
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
  const identityMatches = response.envelopeId === run.envelopeId && response.challengeId === assignment.challengeId &&
    response.kind === assignment.kind && response.policyVersion === run.response.policyVersion
  if (!identityMatches) {
    return false
  }
  if (!response.verified) {
    return !response.envelopeCompleted && !response.nextAssignment &&
      response.completedCount === run.completedCount &&
      response.memberCount >= run.response.envelope!.assignments.length
  }
  return response.completedCount === run.completedCount + 1 &&
    response.memberCount >= run.response.envelope!.assignments.length &&
    (response.envelopeCompleted
      ? response.completedCount === response.memberCount && !response.nextAssignment
      : response.completedCount < response.memberCount && Boolean(response.nextAssignment))
}

function appendDeferredMember(
  context: SecurityChallengeContext,
  run: ActiveEnvelopeRun,
  response: SecurityChallengeVerifyResponse
): boolean {
  const envelope = run.response.envelope
  const next = response.nextAssignment
  if (!envelope || !next || !response.nextProviderPayload ||
      next.action !== context.action || next.routeKey !== context.routeKey ||
      response.nextProviderPayload.challengeId !== next.challengeId ||
      envelope.assignments.some((member) => member.challengeId === next.challengeId) ||
      envelope.assignments.length !== response.completedCount ||
      envelope.assignments.length >= response.memberCount) {
    return false
  }
  envelope.assignments.push(next)
  run.response.providerPayloads.push(response.nextProviderPayload)
  return true
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
    };
}

function capabilityReloadResult(
    response: SecurityChallengeIssueResponse | null,
    outcome: ChallengeCapabilityReloadResult
): SecurityChallengeIssueResult
{
    return failedIssueResult(
        response,
    outcome === 'reload_requested'
        ? 'security_challenge_capability_reload_requested'
        : 'security_challenge_capability_reload_suppressed'
    );
}

function isCapabilityManifestIncompatibleError(error: unknown): boolean
{
    return error instanceof Error && error.message === 'security_challenge_client_capability_incompatible';
}

function sanitizeVerifyResponse(response: SecurityChallengeVerifyResponse): SecurityChallengeVerifyResponse
{
    if (response.verified || response.reason === 'retryable' || response.reason === 'reissueRequired' || response.reason === 'unavailable')
{
        return response;
    }
    return { ...response, reason: 'rejected' };
}
