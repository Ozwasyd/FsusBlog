import { describe, expect, it, vi } from 'vitest'
import { BinaryTransportError } from '@/services/binaryTransport'
import { useRiskChallengeCommand } from '@/composables/useRiskChallengeCommand'
import type {
  SecurityChallengeClient,
  SecurityChallengeContext,
  SecurityChallengeProofLease
} from '@/security/challenge-client'
import { SecurityChallengeKind } from '@/contracts/binaryApi'
import { resolveChallengeCapability } from '@/security/challenge-capability-registry'

const context: SecurityChallengeContext = {
  action: 'auth.passkey.begin',
  routeKey: 'auth.passkey.begin'
}

describe('useRiskChallengeCommand', () => {
  it('replays the exact pending command once after a structured 428 challenge', async () => {
    const lease = createLease()
    const client = createClient(lease)
    const runtime = useRiskChallengeCommand(client)
    const command = vi.fn()
      .mockRejectedValueOnce(new BinaryTransportError({
        kind: 'precondition_required',
        message: 'challenge required',
        status: 428,
        riskChallengeFailure: 'required',
        riskControlDecision: 'challenge',
        riskChallengeHandoff: handoff()
      }))
      .mockResolvedValueOnce('completed')

    const result = runtime.run(
      context,
      { kind: 'mutation_with_identity', mutationIdentity: 'mutation-1' },
      command
    )
    await vi.waitFor(() => expect(runtime.challengeVisible.value).toBe(true))
    expect(command).toHaveBeenNthCalledWith(1, null)
    expect(runtime.challengeContext.value?.identity).toBe('mutation-1')

    await runtime.handleVerified()

    await expect(result).resolves.toBe('completed')
    expect(command).toHaveBeenCalledTimes(2)
    expect(command).toHaveBeenNthCalledWith(2, lease)
  })

  it('does not enter a challenge flow for ordinary business failures', async () => {
    const runtime = useRiskChallengeCommand(createClient(createLease()))
    const error = new BinaryTransportError({
      kind: 'validation',
      message: 'business rejected',
      status: 422
    })

    await expect(runtime.run(context, { kind: 'idempotent' }, async () => {
      throw error
    })).rejects.toBe(error)
    expect(runtime.challengeVisible.value).toBe(false)
  })

  it('requires a stable identity before retrying a mutation', async () => {
    const runtime = useRiskChallengeCommand(createClient(createLease()))
    await expect(runtime.run(
      context,
      { kind: 'mutation_with_identity', mutationIdentity: '  ' },
      async () => 'unreachable'
    )).rejects.toMatchObject({ message: 'risk_challenge_mutation_identity_required' })
  })

  it('retries immediately when the server changes the current decision to allow', async () => {
    const client = createClient(createLease(), 'allow')
    const runtime = useRiskChallengeCommand(client)
    const command = vi.fn()
      .mockRejectedValueOnce(challengeRequiredError())
      .mockResolvedValueOnce('allowed')

    await expect(runtime.run(context, { kind: 'idempotent' }, command)).resolves.toBe('allowed')
    expect(command).toHaveBeenCalledTimes(2)
    expect(runtime.challengeVisible.value).toBe(false)
  })

  it('fails closed when a 428 omits or changes the server handoff identity', async () => {
    const client = createClient(createLease())
    const runtime = useRiskChallengeCommand(client)
    const invalid = [
      undefined,
      { ...handoff(), action: 'comment.create' },
      { ...handoff(), routeKey: 'other.route' }
    ]

    for (const riskChallengeHandoff of invalid) {
      await expect(runtime.run(context, { kind: 'idempotent' }, async () => {
        throw new BinaryTransportError({
          kind: 'precondition_required',
          message: 'challenge required',
          status: 428,
          riskChallengeFailure: 'required',
          riskControlDecision: 'challenge',
          riskChallengeHandoff
        })
      })).rejects.toMatchObject({ message: 'risk_challenge_handoff_invalid' })
    }
    expect(client.issue).not.toHaveBeenCalled()
  })

  it('uses the current server-selected challenge capability after a policy switch', async () => {
    const lease = createLease()
    const client = createClient(lease, 'challenge', SecurityChallengeKind.PerceptionLocalizationV2)
    const runtime = useRiskChallengeCommand(client)
    const result = runtime.run(context, { kind: 'idempotent' }, vi.fn()
      .mockRejectedValueOnce(challengeRequiredError())
      .mockResolvedValueOnce('completed'))

    await vi.waitFor(() => expect(runtime.challengeVisible.value).toBe(true))
    expect(client.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        action: context.action,
        routeKey: context.routeKey,
        attributes: expect.objectContaining({ riskChallengePolicyVersion: 'policy-v2' })
      }),
      { forceRefresh: false }
    )
    runtime.handleCancel()
    await expect(result).rejects.toMatchObject({ message: 'risk_challenge_cancelled' })
  })

  it('clears an old-policy proof and reissues against the policy version from the latest 428', async () => {
    const client = createClient(createLease())
    const runtime = useRiskChallengeCommand(client)
    const result = runtime.run(context, { kind: 'idempotent' }, vi.fn()
      .mockRejectedValueOnce(new BinaryTransportError({
        kind: 'precondition_required',
        message: 'old policy proof rejected',
        status: 428,
        riskChallengeFailure: 'binding_mismatch',
        riskControlDecision: 'challenge',
        riskChallengeHandoff: handoff()
      }))
      .mockResolvedValueOnce('completed'))

    await vi.waitFor(() => expect(runtime.challengeVisible.value).toBe(true))
    expect(client.clearProof).toHaveBeenCalledWith(expect.objectContaining({
      attributes: expect.objectContaining({ riskChallengePolicyVersion: 'policy-v2' })
    }))
    expect(client.issue).toHaveBeenCalledWith(expect.anything(), { forceRefresh: true })
    runtime.handleCancel()
    await expect(result).rejects.toMatchObject({ message: 'risk_challenge_cancelled' })
  })

  it('deduplicates concurrent source activation before challenge issue completes', async () => {
    const client = createClient(createLease())
    const runtime = useRiskChallengeCommand(client)
    const firstCommand = vi.fn().mockRejectedValue(challengeRequiredError())
    const secondCommand = vi.fn().mockRejectedValue(challengeRequiredError())
    const first = runtime.run(context, { kind: 'idempotent' }, firstCommand)
    const second = runtime.run(context, { kind: 'idempotent' }, secondCommand)

    await expect(second).rejects.toMatchObject({ message: 'risk_challenge_command_already_pending' })
    expect(firstCommand).toHaveBeenCalledTimes(1)
    expect(secondCommand).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(runtime.challengeVisible.value).toBe(true))
    runtime.handleCancel()
    await expect(first).rejects.toMatchObject({ message: 'risk_challenge_cancelled' })
    expect(client.issue).toHaveBeenCalledTimes(1)
  })

  it('latches duplicate verified events and resumes the pending command exactly once', async () => {
    const runtime = useRiskChallengeCommand(createClient(createLease()))
    const command = vi.fn()
      .mockRejectedValueOnce(challengeRequiredError())
      .mockResolvedValueOnce('done')
    const result = runtime.run(context, { kind: 'idempotent' }, command)
    await vi.waitFor(() => expect(runtime.challengeVisible.value).toBe(true))

    await Promise.all([runtime.handleVerified(), runtime.handleVerified()])

    await expect(result).resolves.toBe('done')
    expect(command).toHaveBeenCalledTimes(2)
  })

  it('revokes and rejects once when route/unmount cancellation races a late verified event', async () => {
    const client = createClient(createLease())
    const runtime = useRiskChallengeCommand(client)
    const command = vi.fn().mockRejectedValueOnce(challengeRequiredError())
    const result = runtime.run(context, { kind: 'idempotent' }, command)
    await vi.waitFor(() => expect(runtime.challengeVisible.value).toBe(true))

    runtime.handleCancel()
    await runtime.handleVerified()

    await expect(result).rejects.toMatchObject({ message: 'risk_challenge_cancelled' })
    expect(client.cancelEnvelope).toHaveBeenCalledTimes(1)
    expect(command).toHaveBeenCalledTimes(1)
  })
})

function handoff() {
  return {
    decision: 'challenge' as const,
    action: context.action,
    routeKey: context.routeKey,
    policyVersion: 'policy-v2'
  }
}

function challengeRequiredError(): BinaryTransportError {
  return new BinaryTransportError({
    kind: 'precondition_required',
    message: 'challenge required',
    status: 428,
    riskChallengeFailure: 'required',
    riskControlDecision: 'challenge',
    riskChallengeHandoff: handoff()
  })
}

function createLease(): SecurityChallengeProofLease {
  return {
    proof: {
      action: context.action,
      routeKey: context.routeKey,
      challengeId: 'challenge-1',
      kind: SecurityChallengeKind.PerceptionLocalizationV2,
      proofToken: 'proof-token',
      policyVersion: 'policy-v1',
      verifiedAtUnixMs: 1,
      expiresAtUnixMs: 60_000
    },
    markInFlight: () => true,
    settle: () => true
  }
}

function createClient(
  lease: SecurityChallengeProofLease,
  status: 'challenge' | 'allow' = 'challenge',
  kind = SecurityChallengeKind.PerceptionLocalizationV2
): SecurityChallengeClient {
  return {
    issue: vi.fn(async () => status === 'allow' ? {
      status: 'allow' as const,
      response: null,
      assignment: null,
      providerPayload: null,
      proof: null,
      capability: null,
      kindGroup: 'unsupported' as const,
      reason: null,
      retryAfterMs: 0
    } : ({
      status: 'challenge' as const,
      response: null,
      assignment: {
        challengeId: 'challenge-1',
        traceparent: '',
        tenantId: '',
        kind,
        escalationLevel: 1,
        action: context.action,
        routeKey: context.routeKey,
        issuedAtUnixMs: 1,
        expiresAtUnixMs: 60_000,
        subjectHash: '',
        clientIpHash: '',
        deviceFpHash: ''
      },
      providerPayload: null,
      proof: null,
      capability: resolveChallengeCapability(kind, { action: context.action }),
      kindGroup: 'perception' as const,
      reason: null,
      retryAfterMs: 0
    })),
    refresh: vi.fn(),
    replace: vi.fn(),
    verify: vi.fn(),
    reserveProof: vi.fn(() => lease),
    cancelEnvelope: vi.fn(),
    clearProof: vi.fn()
  }
}
