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
  id: number
  context: SecurityChallengeContext
  mutationIdentity: string | null
  execute: ChallengeAwareCommand<unknown>
  resolve(value: unknown): void
  reject(reason: unknown): void
  initiator: HTMLElement | null
  settled: boolean
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
  restoreFocus(): void
  hasPendingCommand(): boolean
}

let sharedRuntime: RiskChallengeCommandRuntime | null = null

export function useRiskChallengeCommand(baseClient?: SecurityChallengeClient): RiskChallengeCommandRuntime {
  if (!baseClient) {
    sharedRuntime ??= createRiskChallengeCommandRuntime(createSecurityChallengeClient())
    return sharedRuntime
  }
  return createRiskChallengeCommandRuntime(baseClient)
}

export function getRiskChallengeCoordinator(): RiskChallengeCommandRuntime {
  return useRiskChallengeCommand()
}

export function createRiskChallengeCommandRuntime(
  baseClient: SecurityChallengeClient
): RiskChallengeCommandRuntime {
  const challengeVisible = ref(false)
  const challengeContext = shallowRef<SecurityChallengeContext | null>(null)
  let preloaded: SecurityChallengeIssueResult | null = null
  let pending: PendingCommand | null = null
  let acquiring = false
  let sequence = 0
  let focusToRestore: HTMLElement | null = null

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
    refresh: async (context, representation) => {
      preloaded = null
      return await baseClient.refresh(context, representation)
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
    if (current && !current.settled) {
      current.settled = true
      challengeClient.cancelEnvelope(current.context)
    }
    closeChallenge()
    if (current) {
      focusToRestore = current.initiator
      current.reject(createAppError(AppErrorCode.PreconditionRequired, reason))
    }
  }

  const run = async <T>(
    context: SecurityChallengeContext,
    retryPolicy: RiskChallengeRetryPolicy,
    command: ChallengeAwareCommand<T>
  ): Promise<T> => {
    assertRetryPolicy(retryPolicy)
    if (pending || acquiring) {
      throw createAppError(AppErrorCode.Conflict, 'risk_challenge_command_already_pending')
    }
    acquiring = true
    try {
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

        if (error.riskChallengeFailure !== 'required') {
          challengeClient.clearProof(requestContext)
        }
        const issued = await challengeClient.issue(requestContext, {
          forceRefresh: error.riskChallengeFailure !== 'required'
        })
        if (issued.status === 'allow') {
          return await command(null)
        }
        if (issued.status === 'verified') {
          const lease = challengeClient.reserveProof(requestContext)
          if (!lease) {
            throw createAppError(AppErrorCode.Conflict, 'risk_challenge_proof_reservation_failed')
          }
          return await command(lease)
        }
        if (issued.status !== 'challenge') {
          throw createAppError(AppErrorCode.PreconditionRequired, 'risk_challenge_unavailable')
        }

        const initiator = typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null
        preloaded = issued
        challengeContext.value = { ...requestContext }
        challengeVisible.value = true
        return await new Promise<T>((resolve, reject) => {
          pending = {
            id: ++sequence,
            context: { ...requestContext },
            mutationIdentity: retryPolicy.kind === 'mutation_with_identity'
              ? retryPolicy.mutationIdentity
              : null,
            execute: command as ChallengeAwareCommand<unknown>,
            resolve: resolve as (value: unknown) => void,
            reject,
            initiator,
            settled: false
          }
        })
      }
    } finally {
      acquiring = false
    }
  }

  const handleVerified = async (): Promise<void> => {
    const current = pending
    if (!current) {
      closeChallenge()
      return
    }

    if (current.settled) {
      return
    }
    current.settled = true

    const lease = challengeClient.reserveProof(current.context)
    if (!lease) {
      rejectPending('risk_challenge_proof_reservation_failed')
      return
    }

    pending = null
    focusToRestore = current.initiator
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
    handleError() {
      rejectPending('risk_challenge_failed')
    },
    handleExpired() {
      if (pending) {
        challengeClient.clearProof(pending.context)
      }
      rejectPending('risk_challenge_expired')
    },
    handleCancel() {
      if (pending) {
        challengeClient.clearProof(pending.context)
      }
      rejectPending('risk_challenge_cancelled')
    },
    restoreFocus() {
      const target = focusToRestore
      focusToRestore = null
      if (target?.isConnected) {
        target.focus({ preventScroll: true })
      }
    },
    hasPendingCommand() {
      return pending !== null || acquiring
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
