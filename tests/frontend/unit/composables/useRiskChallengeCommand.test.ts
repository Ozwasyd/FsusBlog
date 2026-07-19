import { describe, expect, it, vi } from 'vitest'
import { BinaryTransportError } from '@/services/binaryTransport'
import { useRiskChallengeCommand } from '@/composables/useRiskChallengeCommand'
import type {
  SecurityChallengeClient,
  SecurityChallengeContext,
  SecurityChallengeProofLease
} from '@/security/challenge-client'
import { SecurityChallengeKind } from '@/contracts/binaryApi'

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
        riskChallengeFailure: 'required'
      }))
      .mockResolvedValueOnce('completed')

    const result = runtime.run(
      context,
      { kind: 'mutation_with_identity', mutationIdentity: 'mutation-1' },
      command
    )
    await vi.waitFor(() => expect(runtime.challengeVisible.value).toBe(true))
    expect(command).toHaveBeenNthCalledWith(1, null)

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
})

function createLease(): SecurityChallengeProofLease {
  return {
    proof: {
      action: context.action,
      routeKey: context.routeKey,
      challengeId: 'challenge-1',
      kind: SecurityChallengeKind.CaptchaV1,
      proofToken: 'proof-token',
      policyVersion: 'policy-v1',
      verifiedAtUnixMs: 1,
      expiresAtUnixMs: 60_000
    },
    markInFlight: () => true,
    settle: () => true
  }
}

function createClient(lease: SecurityChallengeProofLease): SecurityChallengeClient {
  return {
    issue: vi.fn(async () => ({
      status: 'challenge',
      response: null,
      assignment: {
        challengeId: 'challenge-1',
        traceparent: '',
        tenantId: '',
        kind: SecurityChallengeKind.CaptchaV1,
        escalationLevel: 1,
        action: context.action,
        routeKey: context.routeKey,
        issuedAtUnixMs: 1,
        expiresAtUnixMs: 60_000,
        attemptLimit: 1,
        providerKey: '',
        providerVersion: '',
        providerPayloadRef: '',
        metadata: {}
      },
      providerPayload: null,
      proof: null,
      kindGroup: 'captcha',
      reason: null,
      retryAfterMs: 0
    })),
    refresh: vi.fn(),
    verify: vi.fn(),
    reserveProof: vi.fn(() => lease),
    clearProof: vi.fn()
  }
}
