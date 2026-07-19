// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SecurityChallengeKind, type SecurityChallengeIssueResponse } from '@/api/security'
import { useNotification } from '@/composables/useNotification'

const mocks = vi.hoisted(() => {
  const lease = {
    proof: {
      action: 'notification.subscribe',
      routeKey: 'notification.subscribe',
      challengeId: 'pospace-1',
      kind: 2,
      proofToken: 'proof-token',
      policyVersion: 'risk-v2',
      verifiedAtUnixMs: 1_000,
      expiresAtUnixMs: 10_000
    },
    markInFlight: vi.fn(),
    settle: vi.fn()
  }
  const client = {
    issue: vi.fn(),
    refresh: vi.fn(),
    verify: vi.fn(),
    reserveProof: vi.fn(),
    clearProof: vi.fn()
  }
  const executor = {
    execute: vi.fn(),
    cancel: vi.fn(),
    dispose: vi.fn()
  }
  const runtime = {
    start: vi.fn(),
    stop: vi.fn(),
    isConnected: vi.fn(() => false),
    onEvent: undefined,
    onCursorChange: undefined,
    onStatusChange: undefined,
    onDuplicateEvent: undefined,
    onProtocolError: undefined,
    onHandshakeFailure: undefined,
    onReconnectSuccess: undefined
  }
  const notificationStore = {
    unreadCount: { value: 0 },
    runtime: { cursor: null },
    consumeEvent: vi.fn(),
    syncCursor: vi.fn(),
    setStatus: vi.fn(),
    recordDuplicateEvent: vi.fn(),
    recordProtocolError: vi.fn(),
    recordHandshakeFailure: vi.fn(),
    recordReconnect: vi.fn()
  }
  return { lease, client, executor, runtime, notificationStore }
})

vi.mock('pinia', () => ({
  storeToRefs: () => ({ unreadCount: mocks.notificationStore.unreadCount })
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/store/notificationStream', () => ({
  useNotificationStreamStore: () => mocks.notificationStore
}))
vi.mock('@/store/user', () => ({
  useUserStore: () => ({
    isLoggedIn: true,
    userInfo: { status: 0 },
    updateStatus: vi.fn(),
    fetchUserInfo: vi.fn()
  })
}))
vi.mock('@/services/notificationStreamRuntime', () => ({
  notificationStreamRuntime: mocks.runtime
}))
vi.mock('@/security/challenge-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/security/challenge-client')>()
  return { ...actual, createSecurityChallengeClient: () => mocks.client }
})
vi.mock('@/services/securityPoSpaceChallengeExecutor', () => ({
  createPoSpaceChallengeExecutor: () => mocks.executor
}))
vi.mock('@/composables/usePow', () => ({
  usePow: () => ({
    calculate: vi.fn(),
    prewarm: vi.fn(),
    isCalculating: { value: false }
  })
}))
vi.mock('@/api/auth', () => ({ getPowChallenge: vi.fn() }))
vi.mock('@/utils/fingerprint', () => ({ getBrowserFp: () => 'browser-fp' }))
vi.mock('@/services/localSearch', () => ({ invalidateSearchIndexMemory: vi.fn() }))
vi.mock('@/services/serviceWorkerRuntime', () => ({
  forwardCacheControlPayload: vi.fn(),
  forwardSearchIndexUpdate: vi.fn(),
  postSwControlMessage: vi.fn()
}))
vi.mock('@/utils/errorPresentation', () => ({ showErrorToast: vi.fn() }))
vi.mock('@/fsusui/feedback', () => ({
  toast: { article: vi.fn(), info: vi.fn(), success: vi.fn() }
}))
vi.mock('@/services/safeConsole', () => ({ safeConsoleError: vi.fn(), safeConsoleWarn: vi.fn() }))

describe('notification PoSpace headless recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.runtime.isConnected.mockReturnValue(false)
    mocks.runtime.stop.mockResolvedValue(undefined)
    mocks.runtime.start.mockResolvedValue(undefined)
    mocks.client.reserveProof.mockReturnValue(mocks.lease)
  })

  afterEach(async () => {
    await useNotification().stopNotification()
  })

  it('solves the issued PoSpace assignment and restarts with the unified proof lease', async () => {
    mocks.client.refresh.mockResolvedValueOnce(poSpaceIssue())
    mocks.executor.execute.mockResolvedValueOnce({
      status: 'verified',
      proof: mocks.lease.proof,
      response: { verified: true }
    })

    const notification = useNotification()
    await notification.initNotification(true)

    expect(mocks.executor.execute).toHaveBeenCalledWith(expect.objectContaining({
      policyVersion: 'risk-v2',
      assignment: expect.objectContaining({ challengeId: 'pospace-1' }),
      providerPayload: expect.objectContaining({ challengeId: 'pospace-1' })
    }))
    expect(mocks.runtime.start).toHaveBeenCalledWith(undefined, null, 'auth', mocks.lease)
  })

  it('uses bounded server-authoritative reissue and never starts a duplicate stream', async () => {
    mocks.client.refresh
      .mockResolvedValueOnce(poSpaceIssue('pospace-1'))
      .mockResolvedValueOnce(poSpaceIssue('pospace-2'))
      .mockResolvedValueOnce(poSpaceIssue('pospace-3'))
    mocks.executor.execute.mockResolvedValue({
      status: 'unsupported',
      reason: 'worker_unavailable',
      reissueAttributes: {}
    })

    const notification = useNotification()
    await notification.initNotification(true)

    expect(mocks.executor.execute).toHaveBeenCalledTimes(3)
    expect(mocks.client.refresh).toHaveBeenCalledTimes(3)
    expect(mocks.client.refresh).toHaveBeenNthCalledWith(2, expect.objectContaining({
      attributes: expect.objectContaining({
        unsupportedAssignment: expect.objectContaining({ reissueCount: 1, challengeId: 'pospace-1' })
      })
    }))
    expect(mocks.client.refresh).toHaveBeenNthCalledWith(3, expect.objectContaining({
      attributes: expect.objectContaining({
        unsupportedAssignment: expect.objectContaining({ reissueCount: 2, challengeId: 'pospace-2' })
      })
    }))
    expect(mocks.runtime.start).not.toHaveBeenCalled()
  })

  it('disposes the shared Worker owner when notification stops', async () => {
    mocks.client.refresh.mockResolvedValueOnce(poSpaceIssue())
    mocks.executor.execute.mockResolvedValueOnce({
      status: 'verified',
      proof: mocks.lease.proof,
      response: { verified: true }
    })

    const notification = useNotification()
    await notification.initNotification(true)
    await notification.stopNotification()

    expect(mocks.executor.dispose).toHaveBeenCalledTimes(1)
    expect(mocks.runtime.stop).toHaveBeenCalled()
  })
})

function poSpaceIssue(challengeId = 'pospace-1') {
  const response: SecurityChallengeIssueResponse = {
    decision: 'challenge',
    riskScore: 90,
    effectiveRiskScore: 90,
    escalationLevel: 2,
    policyVersion: 'risk-v2',
    retryAfterMs: 0,
    envelope: {
      envelopeId: 'envelope-1',
      policyVersion: 'risk-v2',
      assignments: []
    },
    providerPayloads: []
  }
  return {
    status: 'challenge' as const,
    response,
    assignment: {
      challengeId,
      traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
      tenantId: 'tenant-main',
      kind: SecurityChallengeKind.Argon2IdPoSpaceV1,
      escalationLevel: 2,
      action: 'notification.subscribe',
      routeKey: 'notification.subscribe',
      subjectHash: 'a'.repeat(64),
      clientIpHash: 'b'.repeat(64),
      deviceFpHash: 'c'.repeat(64),
      issuedAtUnixMs: 1,
      expiresAtUnixMs: Date.now() + 60_000
    },
    providerPayload: {
      challengeId,
      payload: {
        algorithm: 'fsu.pospace/argon2id@v1',
        saltHex: '00'.repeat(16),
        memoryKib: '19456',
        iterations: '2',
        lanes: '1',
        targetDurationMs: '750'
      }
    },
    proof: null,
    kindGroup: 'pospace' as const,
    capability: {
      kind: SecurityChallengeKind.Argon2IdPoSpaceV1,
      wireName: 'argon2idPoSpaceV1',
      group: 'pospace' as const,
      kindKnown: true,
      providerAvailable: true,
      executorFactory: null,
      uiHost: 'pospace' as const,
      headlessHost: 'notification-pospace' as const,
      cancellable: true,
      surfaces: ['*'],
      manifestCompatible: true,
      executorAvailable: true,
      hostAvailable: true,
      policyEligible: true,
      unavailableReason: null
    },
    reason: null,
    retryAfterMs: 0
  }
}
