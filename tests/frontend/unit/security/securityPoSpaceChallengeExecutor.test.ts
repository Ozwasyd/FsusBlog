import { describe, expect, it, vi, type Mock } from 'vitest'
import {
  SecurityChallengeKind,
  type SecurityChallengeAssignment,
  type SecurityChallengeProviderPayload,
  type SecurityChallengeVerifyResponse
} from '@/api/security'
import type {
  SecurityChallengeClient,
  SecurityChallengeContext,
  SecurityChallengeVerifyResult
} from '@/security/challenge-client'
import type { SecurityChallengeProof } from '@/security/challenge-proof-store'
import {
  createPoSpaceChallengeExecutor,
  type PoSpaceChallengeExecuteInput,
  type PoSpaceChallengeState
} from '@/services/securityPoSpaceChallengeExecutor'
import type {
  PoSpaceWorkerClient,
  PoSpaceWorkerSolveResult
} from '@/services/securityPoSpaceClient'
import type { PoSpaceCapabilitySnapshot } from '@/services/securityPoSpaceRuntime'
import { AppErrorCode, createAppError } from '@/utils/appError'

const now = 1_770_000_000_000
const context: SecurityChallengeContext = {
  action: 'notification.subscribe',
  routeKey: 'notification.subscribe'
}
const policyVersion = 'risk-policy-v2'
const envelopeId = '01900000-0000-7000-8000-000000000001'
const saltHex = '000102030405060708090a0b0c0d0e0f'
const nonceHex = '00112233445566778899aabbccddeeff'
const proofHex = 'b3125c3ae22f4e6e2d5aad929304cf5d2672dca2f8dca3c19480f13ab2fd8b32'

const assignment = (challengeId = '01900000-0000-7000-8000-000000000000'): SecurityChallengeAssignment => ({
  challengeId,
  traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
  tenantId: 'default',
  kind: SecurityChallengeKind.Argon2IdPoSpaceV1,
  escalationLevel: 2,
  action: context.action,
  routeKey: context.routeKey,
  subjectHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  clientIpHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  deviceFpHash: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  issuedAtUnixMs: now - 1000,
  expiresAtUnixMs: now + 60_000
})

const providerPayload = (challengeId = assignment().challengeId): SecurityChallengeProviderPayload => ({
  challengeId,
  payload: {
    algorithm: 'fsu.pospace/argon2id@v1',
    saltHex,
    memoryKib: '19456',
    iterations: '2',
    lanes: '1',
    targetDurationMs: '100'
  }
})

const capability = (
  supported = true,
  reason: PoSpaceCapabilitySnapshot['reason'] = 'supported'
): PoSpaceCapabilitySnapshot => ({
  supported,
  reason,
  memoryTier: 'high',
  hardwareConcurrency: 8,
  mobileHint: false,
  maxAllowedMemoryKib: supported ? 65_536 : 0,
  requestedMemoryKib: 19_456,
  workerAvailable: reason !== 'worker_unavailable'
})

const solved: PoSpaceWorkerSolveResult = {
  ok: true,
  nonceHex,
  proofHex,
  durationMs: 120,
  capability: capability()
}

function verifiedResult(challengeId: string): SecurityChallengeVerifyResult {
  const response: SecurityChallengeVerifyResponse = {
    verified: true,
    envelopeId,
    challengeId,
    kind: SecurityChallengeKind.Argon2IdPoSpaceV1,
    policyVersion,
    completedCount: 1,
    memberCount: 1,
    envelopeCompleted: true,
    proofToken: `proof-token-${challengeId}`,
    expiresAtUnixMs: now + 120_000,
    reason: '',
    retryAfterMs: 0
  }
  const proof: SecurityChallengeProof = {
    action: context.action,
    routeKey: context.routeKey,
    challengeId,
    kind: SecurityChallengeKind.Argon2IdPoSpaceV1,
    proofToken: response.proofToken,
    policyVersion,
    verifiedAtUnixMs: now,
    expiresAtUnixMs: response.expiresAtUnixMs
  }
  return {
    status: 'verified',
    response,
    proof,
    next: null,
    reason: null,
    retryAfterMs: 0
  }
}

function fakeClient(
  verifyImplementation: SecurityChallengeClient['verify'] = async (_context, request) => verifiedResult(request.challengeId)
): SecurityChallengeClient {
  return {
    issue: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
    verify: vi.fn(verifyImplementation),
    reserveProof: vi.fn(),
    cancelEnvelope: vi.fn(),
    clearProof: vi.fn()
  }
}

type FakeWorker = PoSpaceWorkerClient & {
  capability: Mock<PoSpaceWorkerClient['capability']>
  solve: Mock<PoSpaceWorkerClient['solve']>
  dispose: Mock<PoSpaceWorkerClient['dispose']>
}

function fakeWorker(options: {
  capabilityResult?: PoSpaceCapabilitySnapshot
  solveImplementation?: PoSpaceWorkerClient['solve']
} = {}): FakeWorker {
  return {
    capability: vi.fn<PoSpaceWorkerClient['capability']>().mockResolvedValue(options.capabilityResult ?? capability()),
    solve: vi.fn<PoSpaceWorkerClient['solve']>(options.solveImplementation ?? (async () => solved)),
    dispose: vi.fn<PoSpaceWorkerClient['dispose']>()
  }
}

function executeInput(overrides: Partial<PoSpaceChallengeExecuteInput> = {}): PoSpaceChallengeExecuteInput {
  return {
    context,
    assignment: assignment(),
    providerPayload: providerPayload(),
    policyVersion,
    ...overrides
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('security PoSpace challenge executor', () => {
  it('runs capability, solve and verify without exposing raw security material in state', async () => {
    const worker = fakeWorker()
    const client = fakeClient()
    const states: PoSpaceChallengeState[] = []
    const consoleLog = vi.spyOn(console, 'log')
    const consoleError = vi.spyOn(console, 'error')
    const executor = createPoSpaceChallengeExecutor({ client, workerFactory: () => worker, now: () => now })

    const result = await executor.execute(executeInput({ onState: (state) => states.push(state) }))

    expect(result).toMatchObject({ status: 'verified', proof: { proofToken: expect.any(String) } })
    expect(states.map((state) => state.status)).toEqual(['preparing', 'solving', 'verifying', 'verified'])
    expect(worker.solve).toHaveBeenCalledWith(expect.objectContaining({ policyVersion }), providerPayload().payload)
    expect(client.verify).toHaveBeenCalledWith(context, expect.objectContaining({
      providerPayload: expect.objectContaining({ saltHex, nonceHex, proofHex })
    }))
    const serializedStates = JSON.stringify(states)
    for (const secret of [saltHex, nonceHex, proofHex, assignment().subjectHash, assignment().clientIpHash, assignment().deviceFpHash]) {
      expect(serializedStates).not.toContain(secret)
    }
    expect(consoleLog).not.toHaveBeenCalled()
    expect(consoleError).not.toHaveBeenCalled()
    expect(worker.dispose).toHaveBeenCalledTimes(1)
    consoleLog.mockRestore()
    consoleError.mockRestore()
  })

  it.each([
    ['worker_unavailable', 'worker_unavailable'],
    ['slow_device', 'slow_device']
  ] as const)('returns low-cardinality reissue attributes for %s capability', async (_label, reason) => {
    const worker = fakeWorker({ capabilityResult: capability(false, reason) })
    const client = fakeClient()
    const result = await createPoSpaceChallengeExecutor({ client, workerFactory: () => worker, now: () => now })
      .execute(executeInput())

    expect(result).toEqual({
      status: 'unsupported',
      reason,
      reissueAttributes: {
        unsupportedAssignment: {
          challengeId: assignment().challengeId,
          kind: 'argon2idPoSpaceV1',
          action: context.action,
          routeKey: context.routeKey,
          reason,
          reissueCount: 1
        }
      }
    })
    expect(worker.solve).not.toHaveBeenCalled()
    expect(client.verify).not.toHaveBeenCalled()
  })

  it.each([
    ['pospace_worker_timeout', AppErrorCode.Timeout],
    ['pospace_worker_failed', AppErrorCode.InfraFailure]
  ] as const)('normalizes Worker %s without verification', async (reason, code) => {
    const worker = fakeWorker({
      solveImplementation: async () => { throw createAppError(code, reason) }
    })
    const client = fakeClient()

    const result = await createPoSpaceChallengeExecutor({ client, workerFactory: () => worker, now: () => now })
      .execute(executeInput())

    expect(result).toEqual({ status: 'failed', reason })
    expect(client.verify).not.toHaveBeenCalled()
  })

  it('returns failed when unified verification rejects and does not return a proof', async () => {
    const client = fakeClient(async () => ({
      status: 'failed',
      response: null,
      proof: null,
      next: null,
      reason: 'pospace_proof_invalid',
      retryAfterMs: 0
    }))

    const result = await createPoSpaceChallengeExecutor({ client, workerFactory: () => fakeWorker(), now: () => now })
      .execute(executeInput())

    expect(result).toEqual({ status: 'failed', reason: 'pospace_proof_invalid' })
  })

  it('cancels a pending solve and blocks stale verification', async () => {
    const pending = deferred<PoSpaceWorkerSolveResult>()
    const worker = fakeWorker({ solveImplementation: () => pending.promise })
    const client = fakeClient()
    const states: PoSpaceChallengeState[] = []
    const executor = createPoSpaceChallengeExecutor({ client, workerFactory: () => worker, now: () => now })
    const execution = executor.execute(executeInput({ onState: (state) => states.push(state) }))
    await vi.waitFor(() => expect(worker.solve).toHaveBeenCalledTimes(1))

    executor.cancel()
    pending.resolve(solved)

    await expect(execution).resolves.toEqual({ status: 'cancelled', reason: 'cancelled' })
    expect(states.at(-1)).toEqual({ status: 'cancelled', reason: 'cancelled' })
    expect(worker.dispose).toHaveBeenCalledTimes(1)
    expect(client.verify).not.toHaveBeenCalled()
  })

  it('clears a proof written by a verification that returns after cancellation', async () => {
    const pending = deferred<SecurityChallengeVerifyResult>()
    let storedProof: SecurityChallengeProof | null = null
    const client = fakeClient(async () => {
      const result = await pending.promise
      storedProof = result.proof
      return result
    })
    client.clearProof = vi.fn(() => {
      storedProof = null
    })
    const worker = fakeWorker()
    const executor = createPoSpaceChallengeExecutor({ client, workerFactory: () => worker, now: () => now })
    const execution = executor.execute(executeInput())
    await vi.waitFor(() => expect(client.verify).toHaveBeenCalledTimes(1))

    executor.cancel()
    pending.resolve(verifiedResult(assignment().challengeId))

    await expect(execution).resolves.toEqual({ status: 'cancelled', reason: 'cancelled' })
    expect(client.clearProof).toHaveBeenCalledWith(context)
    expect(storedProof).toBeNull()
  })

  it('expires after solving and never submits a stale proof', async () => {
    let clock = now
    const expiringAssignment = { ...assignment(), expiresAtUnixMs: now + 10 }
    const worker = fakeWorker({
      solveImplementation: async () => {
        clock = now + 20
        return solved
      }
    })
    const client = fakeClient()

    const result = await createPoSpaceChallengeExecutor({ client, workerFactory: () => worker, now: () => clock })
      .execute(executeInput({ assignment: expiringAssignment }))

    expect(result).toEqual({ status: 'expired', reason: 'assignment_expired' })
    expect(client.verify).not.toHaveBeenCalled()
  })

  it('replaces an older generation without letting its late solve verify or overwrite state', async () => {
    const firstPending = deferred<PoSpaceWorkerSolveResult>()
    const firstWorker = fakeWorker({ solveImplementation: () => firstPending.promise })
    const secondWorker = fakeWorker()
    const workerFactory = vi.fn()
      .mockReturnValueOnce(firstWorker)
      .mockReturnValueOnce(secondWorker)
    const client = fakeClient()
    const executor = createPoSpaceChallengeExecutor({ client, workerFactory, now: () => now })
    const oldStates: PoSpaceChallengeState[] = []
    const first = executor.execute(executeInput({ onState: (state) => oldStates.push(state) }))
    await vi.waitFor(() => expect(firstWorker.solve).toHaveBeenCalledTimes(1))

    const replacementId = '01900000-0000-7000-8000-000000000001'
    const second = executor.execute(executeInput({
      assignment: assignment(replacementId),
      providerPayload: providerPayload(replacementId)
    }))
    firstPending.resolve(solved)

    await expect(first).resolves.toEqual({ status: 'cancelled', reason: 'replaced' })
    await expect(second).resolves.toMatchObject({ status: 'verified', proof: { challengeId: replacementId } })
    expect(firstWorker.dispose).toHaveBeenCalledTimes(1)
    expect(client.verify).toHaveBeenCalledTimes(1)
    expect(client.verify).toHaveBeenCalledWith(context, expect.objectContaining({ challengeId: replacementId }))
    expect(oldStates.map((state) => state.status)).not.toContain('verified')
  })

  it('disposes a pending generation and remains terminal for later execute calls', async () => {
    const pending = deferred<PoSpaceWorkerSolveResult>()
    const worker = fakeWorker({ solveImplementation: () => pending.promise })
    const client = fakeClient()
    const executor = createPoSpaceChallengeExecutor({ client, workerFactory: () => worker, now: () => now })
    const execution = executor.execute(executeInput())
    await vi.waitFor(() => expect(worker.solve).toHaveBeenCalledTimes(1))

    executor.dispose()
    pending.resolve(solved)

    await expect(execution).resolves.toEqual({ status: 'cancelled', reason: 'disposed' })
    await expect(executor.execute(executeInput())).resolves.toEqual({ status: 'cancelled', reason: 'disposed' })
    expect(worker.dispose).toHaveBeenCalledTimes(1)
    expect(client.verify).not.toHaveBeenCalled()
  })

  it('requires the authoritative issue-response policyVersion outside the assignment', async () => {
    const workerFactory = vi.fn(() => fakeWorker())
    const client = fakeClient()

    const result = await createPoSpaceChallengeExecutor({ client, workerFactory, now: () => now })
      .execute(executeInput({ policyVersion: '' }))

    expect(result).toEqual({ status: 'failed', reason: 'pospace_policy_version_missing' })
    expect(workerFactory).not.toHaveBeenCalled()
    expect(client.verify).not.toHaveBeenCalled()
  })
})
