import { ref, shallowRef, type Ref, type ShallowRef } from 'vue'
import { BinaryTransportError } from '@/composition/binaryTransport'
import {
  createSecurityChallengeClient,
  type SecurityChallengeClient,
  type SecurityChallengeContext,
  type SecurityChallengeIssueResult,
  type SecurityChallengeProofLease
} from '@/security/challenge-client'
import { createAppError, AppErrorCode } from '@/utils/appError'
import type { RiskChallengeHandoff } from '@/contracts/riskChallenge'

export type RiskChallengeRetryPolicy =
  | { kind: 'idempotent' }
  | { kind: 'mutation_with_identity', mutationIdentity: string }

type ChallengeAwareCommand<T> = (proof: SecurityChallengeProofLease | null) => Promise<T>

interface PendingCommand {
  context: SecurityChallengeContext
  mutationIdentity: string | null
  execute: ChallengeAwareCommand<unknown>
  resolve(value: unknown): void
  reject(reason: unknown): void
}

export interface RiskChallengeCommandRuntime {
  challengeVisible: Ref<boolean>
  challengeContext: ShallowRef<SecurityChallengeContext | null>
  challengeClient: SecurityChallengeClient
  run<T>(
    context: SecurityChallengeContext,
    retryPolicy: RiskChallengeRetryPolicy,
    command: ChallengeAwareCommand<T>
  ): Promise<T>
  handleVerified(): Promise<void>
  handleError(reason?: string): void
  handleExpired(): void
  handleCancel(): void
}

export function useRiskChallengeCommand(
  baseClient: SecurityChallengeClient = createSecurityChallengeClient()
): RiskChallengeCommandRuntime {
  const challengeVisible = ref(false)
  const challengeContext = shallowRef<SecurityChallengeContext | null>(null)
  let preloaded: SecurityChallengeIssueResult | null = null
  let pending: PendingCommand | null = null

  const challengeClient: SecurityChallengeClient = {
    ...baseClient,
    issue: async (context, options = {}) => {
      if (!options.forceRefresh && preloaded) {
        const current = preloaded
        preloaded = null
        return current
      }
      return await baseClient.issue(context, options)
    },
    refresh: async (context) => {
      preloaded = null
      return await baseClient.refresh(context)
    }
  }

  const closeChallenge = (): void => {
    challengeVisible.value = false
    challengeContext.value = null
    preloaded = null
  }

  const rejectPending = (reason: string): void => {
    const current = pending
    pending = null
    if (current) {
      baseClient.cancelEnvelope(current.context)
    }
    closeChallenge()
    current?.reject(createAppError(AppErrorCode.PreconditionRequired, reason))
  }

  const run = async <T>(
    context: SecurityChallengeContext,
    retryPolicy: RiskChallengeRetryPolicy,
    command: ChallengeAwareCommand<T>
  ): Promise<T> => {
    assertRetryPolicy(retryPolicy)
    try {
      return await command(null)
    } catch (error) {
      if (!(error instanceof BinaryTransportError) || !error.riskChallengeFailure) {
        throw error
      }

      const serverContext = contextFromHandoff(context, error.riskChallengeHandoff)
      const requestContext = retryPolicy.kind === 'mutation_with_identity'
        ? { ...serverContext, identity: retryPolicy.mutationIdentity }
        : serverContext

      if (pending) {
        throw createAppError(AppErrorCode.Conflict, 'risk_challenge_command_already_pending')
      }

      if (error.riskChallengeFailure !== 'required') {
        baseClient.clearProof(requestContext)
      }
      const issued = await baseClient.issue(requestContext, {
        forceRefresh: error.riskChallengeFailure !== 'required'
      })
      if (issued.status === 'allow') {
        return await command(null)
      }
      if (issued.status === 'verified') {
        const lease = baseClient.reserveProof(requestContext)
        if (!lease) {
          throw createAppError(AppErrorCode.Conflict, 'risk_challenge_proof_reservation_failed')
        }
        return await command(lease)
      }
      if (issued.status !== 'challenge') {
        throw createAppError(AppErrorCode.PreconditionRequired, issued.reason ?? 'risk_challenge_unavailable')
      }

      preloaded = issued
      challengeContext.value = { ...requestContext }
      challengeVisible.value = true
      return await new Promise<T>((resolve, reject) => {
        pending = {
          context: { ...requestContext },
          mutationIdentity: retryPolicy.kind === 'mutation_with_identity'
            ? retryPolicy.mutationIdentity
            : null,
          execute: command as ChallengeAwareCommand<unknown>,
          resolve: resolve as (value: unknown) => void,
          reject
        }
      })
    }
  }

  const handleVerified = async (): Promise<void> => {
    const current = pending
    if (!current) {
      closeChallenge()
      return
    }

    const lease = baseClient.reserveProof(current.context)
    if (!lease) {
      rejectPending('risk_challenge_proof_reservation_failed')
      return
    }

    pending = null
    closeChallenge()
    try {
      current.resolve(await current.execute(lease))
    } catch (error) {
      current.reject(error)
    }
  }

  return {
    challengeVisible,
    challengeContext,
    challengeClient,
    run,
    handleVerified,
    handleError(reason = 'risk_challenge_failed') {
      rejectPending(reason)
    },
    handleExpired() {
      if (pending) {
        baseClient.clearProof(pending.context)
      }
      rejectPending('risk_challenge_expired')
    },
    handleCancel() {
      if (pending) {
        baseClient.clearProof(pending.context)
      }
      rejectPending('risk_challenge_cancelled')
    }
  }
}

function contextFromHandoff(
  expected: SecurityChallengeContext,
  handoff: RiskChallengeHandoff | undefined
): SecurityChallengeContext {
  if (!handoff
    || handoff.action !== expected.action
    || handoff.routeKey !== expected.routeKey
    || !handoff.policyVersion.trim()) {
    throw createAppError(AppErrorCode.PreconditionRequired, 'risk_challenge_handoff_invalid')
  }

  return {
    ...expected,
    action: handoff.action,
    routeKey: handoff.routeKey,
    attributes: {
      ...expected.attributes,
      riskChallengePolicyVersion: handoff.policyVersion
    }
  }
}

function assertRetryPolicy(policy: RiskChallengeRetryPolicy): void {
  if (policy.kind === 'mutation_with_identity' && !policy.mutationIdentity.trim()) {
    throw createAppError(AppErrorCode.Validation, 'risk_challenge_mutation_identity_required')
  }
}
