import {
  SecurityChallengeKind,
  type SecurityChallengeAssignment,
  type SecurityChallengeProviderPayload,
  type SecurityChallengeVerifyResponse
} from '@/api/security'
import {
  createSecurityChallengeClient,
  type SecurityChallengeClient,
  type SecurityChallengeContext,
  type SecurityChallengeIssueResult
} from '@/security/challenge-client'
import type { SecurityChallengeProof } from '@/security/challenge-proof-store'
import type { PoSpaceUnsupportedReason } from '@/generated/poSpaceV1Contract'
import { getErrorMessage } from '@/utils/errors'
import {
  createPoSpaceWorkerClient,
  type PoSpaceAssignmentRequest,
  type PoSpaceWorkerClient
} from './securityPoSpaceClient'
import {
  createPoSpaceUnsupportedReissueAttributes,
  createPoSpaceVerifyPayload
} from './securityPoSpaceRuntime'

import { AppErrorCode, createAppError } from '@/utils/appError'
export type PoSpaceChallengeStatus =
  | 'preparing'
  | 'unsupported'
  | 'solving'
  | 'verifying'
  | 'verified'
  | 'failed'
  | 'expired'
  | 'cancelled'

export type PoSpaceChallengeCancelReason = 'cancelled' | 'replaced' | 'disposed'

export type PoSpaceChallengeState =
  | { status: 'preparing' | 'solving' | 'verifying'; reason: null }
  | { status: 'unsupported'; reason: PoSpaceUnsupportedReason }
  | { status: 'verified'; reason: null }
  | { status: 'failed'; reason: string }
  | { status: 'expired'; reason: 'assignment_expired' }
  | { status: 'cancelled'; reason: PoSpaceChallengeCancelReason }

export interface PoSpaceChallengeExecuteInput {
  context: SecurityChallengeContext
  assignment: SecurityChallengeAssignment
  providerPayload: SecurityChallengeProviderPayload
  policyVersion: string
  onState?: (state: Readonly<PoSpaceChallengeState>) => void
}

export type PoSpaceChallengeExecuteResult =
  | {
      status: 'verified'
      proof: SecurityChallengeProof
      response: SecurityChallengeVerifyResponse
    }
  | {
      status: 'continued'
      response: SecurityChallengeVerifyResponse
      next: SecurityChallengeIssueResult
    }
  | {
      status: 'unsupported'
      reason: PoSpaceUnsupportedReason
      reissueAttributes: Record<string, unknown>
    }
  | {
      status: 'failed'
      reason: string
    }
  | {
      status: 'expired'
      reason: 'assignment_expired'
    }
  | {
      status: 'cancelled'
      reason: PoSpaceChallengeCancelReason
    }

export interface PoSpaceChallengeExecutorOptions {
  client?: SecurityChallengeClient
  workerFactory?: () => PoSpaceWorkerClient
  now?: () => number
}

export interface PoSpaceChallengeExecutor {
  execute(input: PoSpaceChallengeExecuteInput): Promise<PoSpaceChallengeExecuteResult>
  cancel(): void
  dispose(): void
}

interface ActiveExecution {
  readonly generation: number
  readonly onState?: PoSpaceChallengeExecuteInput['onState']
  worker: PoSpaceWorkerClient | null
  cancelReason: PoSpaceChallengeCancelReason | null
}

export function createPoSpaceChallengeExecutor(
  options: PoSpaceChallengeExecutorOptions = {}
): PoSpaceChallengeExecutor {
  const client = options.client ?? createSecurityChallengeClient()
  const workerFactory = options.workerFactory ?? (() => createPoSpaceWorkerClient())
  const now = options.now ?? (() => Date.now())
  let generation = 0
  let active: ActiveExecution | null = null
  let disposed = false

  const publish = (run: ActiveExecution, state: PoSpaceChallengeState): void => {
    if (active === run && run.cancelReason === null) {
      run.onState?.(Object.freeze({ ...state }))
    }
  }

  const stop = (reason: PoSpaceChallengeCancelReason, publishState: boolean): void => {
    const run = active
    if (!run) {
      return
    }
    run.cancelReason = reason
    active = null
    run.worker?.dispose()
    run.worker = null
    if (publishState) {
      run.onState?.(Object.freeze({ status: 'cancelled', reason }))
    }
  }

  const isCurrent = (run: ActiveExecution): boolean => (
    !disposed && active === run && run.cancelReason === null
  )

  const cancelledResult = (run: ActiveExecution): PoSpaceChallengeExecuteResult => ({
    status: 'cancelled',
    reason: run.cancelReason ?? (disposed ? 'disposed' : 'replaced')
  })

  const complete = (
    run: ActiveExecution,
    state: PoSpaceChallengeState,
    result: PoSpaceChallengeExecuteResult
  ): PoSpaceChallengeExecuteResult => {
    if (!isCurrent(run)) {
      return cancelledResult(run)
    }
    publish(run, state)
    active = null
    run.worker?.dispose()
    run.worker = null
    return result
  }

  const unsupported = (
    run: ActiveExecution,
    assignment: SecurityChallengeAssignment,
    reason: PoSpaceUnsupportedReason
  ): PoSpaceChallengeExecuteResult => complete(
    run,
    { status: 'unsupported', reason },
    {
      status: 'unsupported',
      reason,
      reissueAttributes: createPoSpaceUnsupportedReissueAttributes(assignment, reason, 1)
    }
  )

  async function execute(input: PoSpaceChallengeExecuteInput): Promise<PoSpaceChallengeExecuteResult> {
    if (disposed) {
      return { status: 'cancelled', reason: 'disposed' }
    }

    stop('replaced', false)
    const run: ActiveExecution = {
      generation: ++generation,
      onState: input.onState,
      worker: null,
      cancelReason: null
    }
    active = run
    publish(run, { status: 'preparing', reason: null })

    try {
      validateInput(input)
      if (input.assignment.expiresAtUnixMs <= now()) {
        return complete(
          run,
          { status: 'expired', reason: 'assignment_expired' },
          { status: 'expired', reason: 'assignment_expired' }
        )
      }

      const assignment = workerAssignment(input)
      const payload = input.providerPayload.payload
      run.worker = workerFactory()
      const capability = await run.worker.capability(payload)
      if (!isCurrent(run)) {
        return cancelledResult(run)
      }
      if (input.assignment.expiresAtUnixMs <= now()) {
        return complete(
          run,
          { status: 'expired', reason: 'assignment_expired' },
          { status: 'expired', reason: 'assignment_expired' }
        )
      }
      if (!capability.supported) {
        if (capability.reason === 'supported') {
          return complete(
            run,
            { status: 'failed', reason: 'pospace_capability_state_invalid' },
            { status: 'failed', reason: 'pospace_capability_state_invalid' }
          )
        }
        return unsupported(run, input.assignment, capability.reason)
      }

      publish(run, { status: 'solving', reason: null })
      const solved = await run.worker.solve(assignment, payload)
      if (!isCurrent(run)) {
        return cancelledResult(run)
      }
      if (input.assignment.expiresAtUnixMs <= now()) {
        return complete(
          run,
          { status: 'expired', reason: 'assignment_expired' },
          { status: 'expired', reason: 'assignment_expired' }
        )
      }
      if (!solved.ok) {
        return unsupported(run, input.assignment, solved.reason)
      }

      const verifyPayload = createPoSpaceVerifyPayload(payload, solved.nonceHex, solved.proofHex)
      if (!isCurrent(run)) {
        return cancelledResult(run)
      }
      publish(run, { status: 'verifying', reason: null })
      const verified = await client.verify(input.context, {
        challengeId: input.assignment.challengeId,
        kind: SecurityChallengeKind.Argon2IdPoSpaceV1,
        action: input.context.action,
        routeKey: input.context.routeKey,
        providerPayload: verifyPayload
      })
      if (!isCurrent(run)) {
        client.clearProof(input.context)
        return cancelledResult(run)
      }
      if ((verified.status === 'continue' || verified.status === 'unsupported') && verified.response && verified.next) {
        return complete(
          run,
          { status: 'verified', reason: null },
          { status: 'continued', response: verified.response, next: verified.next }
        )
      }
      if (verified.status !== 'verified' || !verified.proof || !verified.response) {
        const reason = verified.reason ?? 'security_challenge_verify_failed'
        return complete(run, { status: 'failed', reason }, { status: 'failed', reason })
      }

      return complete(
        run,
        { status: 'verified', reason: null },
        { status: 'verified', proof: verified.proof, response: verified.response }
      )
    } catch (error) {
      if (!isCurrent(run)) {
        return cancelledResult(run)
      }
      const reason = getErrorMessage(error, 'pospace_execution_failed')
      if (reason === 'pospace_worker_unavailable') {
        return unsupported(run, input.assignment, 'worker_unavailable')
      }
      return complete(run, { status: 'failed', reason }, { status: 'failed', reason })
    }
  }

  return {
    execute,
    cancel() {
      stop('cancelled', true)
    },
    dispose() {
      if (disposed) {
        return
      }
      disposed = true
      stop('disposed', true)
    }
  }
}

function validateInput(input: PoSpaceChallengeExecuteInput): void {
  if (input.assignment.kind !== SecurityChallengeKind.Argon2IdPoSpaceV1) {
    throw createAppError(AppErrorCode.Validation, 'pospace_assignment_kind_invalid')
  }
  if (input.providerPayload.challengeId !== input.assignment.challengeId) {
    throw createAppError(AppErrorCode.Validation, 'pospace_provider_payload_mismatch')
  }
  if (input.assignment.action !== input.context.action || input.assignment.routeKey !== input.context.routeKey) {
    throw createAppError(AppErrorCode.Validation, 'pospace_assignment_context_mismatch')
  }
  if (!input.policyVersion.trim()) {
    throw createAppError(AppErrorCode.Validation, 'pospace_policy_version_missing')
  }
}

function workerAssignment(input: PoSpaceChallengeExecuteInput): PoSpaceAssignmentRequest {
  return {
    challengeId: input.assignment.challengeId,
    action: input.assignment.action,
    routeKey: input.assignment.routeKey,
    subjectHash: input.assignment.subjectHash,
    clientIpHash: input.assignment.clientIpHash,
    deviceFpHash: input.assignment.deviceFpHash,
    policyVersion: input.policyVersion
  }
}
