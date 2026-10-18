import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NotificationStreamRuntime,
  normalizeNotificationStreamHandshakeFailure,
  resolveNotificationStreamEndpointUrl
} from '@/services/notificationStreamRuntime'
import {
  NotificationStreamEventType,
  NotificationStreamFailureCodes,
  type NotificationStreamEventV2
} from '@/services/notificationStreamTypes'
import { decodeNotificationFrame } from '@/adapters/binary/notificationAdapter'
import { SecurityChallengeKind } from '@/api/security'

vi.mock('@/adapters/binary/notificationAdapter', () => ({
  decodeNotificationApiErrorFrame: vi.fn(),
  decodeNotificationFrame: vi.fn()
}))

const mockedDecodeNotificationFrame = vi.mocked(decodeNotificationFrame)

class ManualWebSocket {
  static instances: ManualWebSocket[] = []

  public binaryType = ''
  public onopen: (() => void) | null = null
  public onmessage: ((message: { data: ArrayBuffer }) => void) | null = null
  public onerror: (() => void) | null = null
  public onclose: ((event: { code: number }) => void) | null = null
  public readonly url: URL

  constructor(url: URL) {
    this.url = url
    ManualWebSocket.instances.push(this)
  }

  close(code = 1000): void {
    this.onclose?.({ code })
  }

  open(): void {
    this.onopen?.()
  }

  message(event: NotificationStreamEventV2): void {
    mockedDecodeNotificationFrame.mockReturnValueOnce({ kind: 'event', event })
    this.onmessage?.({ data: new ArrayBuffer(1) })
  }
}

function createEvent(id: number): NotificationStreamEventV2 {
  return {
    id,
    ts: 1_700_000_000_000 + id,
    type: NotificationStreamEventType.NoticeReceived,
    payload: { title: `event-${id}` }
  }
}

async function waitForSocket(index: number): Promise<ManualWebSocket> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const socket = ManualWebSocket.instances[index]
    if (socket) {
      return socket
    }

    await Promise.resolve()
  }

  throw new Error(`missing manual websocket at index ${index}`)
}

describe('resolveNotificationStreamEndpointUrl', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    ManualWebSocket.instances = []
    mockedDecodeNotificationFrame.mockReset()
    window.location.href = 'https://example.com/'
    vi.stubGlobal('WebSocket', ManualWebSocket)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers(),
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(0))
    }))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('supports an explicitly configured API origin for dev WebSocket connections', () => {
    const url = resolveNotificationStreamEndpointUrl(
      '/api/notifications/stream',
      'websocket',
      'http://127.0.0.1:7568',
      'http://127.0.0.1:3000'
    )

    expect(url.toString()).toBe('ws://127.0.0.1:7568/api/notifications/stream')
  })

  it('keeps preflight on HTTP and falls back to the current origin without configuration', () => {
    const url = resolveNotificationStreamEndpointUrl(
      '/api/notifications/stream/preflight',
      'http',
      undefined,
      'https://example.com'
    )

    expect(url.toString()).toBe('https://example.com/api/notifications/stream/preflight')
  })

  it('preserves RiskControl handshake failure codes from preflight responses', () => {
    expect(normalizeNotificationStreamHandshakeFailure('risk_challenge_required', 428, 'guest'))
      .toBe(NotificationStreamFailureCodes.RiskChallengeRequired)
    expect(normalizeNotificationStreamHandshakeFailure('risk_challenge_rejected', 428, 'guest'))
      .toBe(NotificationStreamFailureCodes.RiskChallengeRejected)
    expect(normalizeNotificationStreamHandshakeFailure('risk_challenge_expired', 428, 'guest'))
      .toBe(NotificationStreamFailureCodes.RiskChallengeExpired)
    expect(normalizeNotificationStreamHandshakeFailure('risk_challenge_replayed', 428, 'guest'))
      .toBe(NotificationStreamFailureCodes.RiskChallengeReplayed)
    expect(normalizeNotificationStreamHandshakeFailure('risk_challenge_binding_mismatch', 428, 'guest'))
      .toBe(NotificationStreamFailureCodes.RiskChallengeBindingMismatch)
    expect(normalizeNotificationStreamHandshakeFailure('risk_challenge_revoked', 428, 'guest'))
      .toBe(NotificationStreamFailureCodes.RiskChallengeRevoked)
    expect(normalizeNotificationStreamHandshakeFailure('risk_challenge_kind_mismatch', 428, 'guest'))
      .toBe(NotificationStreamFailureCodes.RiskChallengeKindMismatch)
    expect(normalizeNotificationStreamHandshakeFailure('risk_control_blocked', 429, 'guest'))
      .toBe(NotificationStreamFailureCodes.RiskControlBlocked)
    expect(normalizeNotificationStreamHandshakeFailure('risk_control_throttled', 429, 'guest'))
      .toBe(NotificationStreamFailureCodes.RiskControlThrottled)
  })

  it('keeps legacy guest fallback semantics for unknown preflight errors', () => {
    expect(normalizeNotificationStreamHandshakeFailure(undefined, 401, 'guest'))
      .toBe(NotificationStreamFailureCodes.PowFailed)
    expect(normalizeNotificationStreamHandshakeFailure(undefined, 401, 'auth'))
      .toBe(NotificationStreamFailureCodes.AuthFailed)
    expect(normalizeNotificationStreamHandshakeFailure('unexpected', 428, 'guest'))
      .toBe(NotificationStreamFailureCodes.NetworkError)
  })

  it('skips handshake preflight for authenticated reconnect after a successful connection', async () => {
    const runtime = new NotificationStreamRuntime()
    const fetchMock = vi.mocked(fetch)

    const firstStart = runtime.start(undefined, undefined, 'auth')
    ;(await waitForSocket(0)).open()
    await firstStart
    fetchMock.mockClear()

    ManualWebSocket.instances[0]?.close(1006)
    await vi.advanceTimersByTimeAsync(1000)
    await waitForSocket(1)

    expect(ManualWebSocket.instances).toHaveLength(2)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps guest proof connections on the handshake preflight path', async () => {
    const runtime = new NotificationStreamRuntime()
    const fetchMock = vi.mocked(fetch)

    const started = runtime.start({
      nonce: 'nonce',
      salt: 'salt',
      fp: 'fp',
      signature: 'sig',
      difficulty: 4,
      timestamp: 1
    }, undefined, 'guest')
    ;(await waitForSocket(0)).open()
    await started

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/notifications/stream/preflight')
  })

  it('consumes a challenge lease in preflight, keeps proof out of URL, and reissues on reconnect', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock
      .mockResolvedValueOnce(new Response(null))
      .mockResolvedValueOnce(new Response(null, {
        status: 428,
        headers: { 'X-Fsus-Notification-Stream-Error-Code': 'risk_challenge_required' }
      }))
    const settle = vi.fn().mockReturnValue(true)
    const runtime = new NotificationStreamRuntime()
    const handshakeFailure = vi.fn()
    runtime.onHandshakeFailure = handshakeFailure

    const started = runtime.start(undefined, undefined, 'auth', {
      proof: {
        action: 'notification.subscribe',
        routeKey: 'notification.subscribe',
        challengeId: 'challenge-1',
        kind: SecurityChallengeKind.Sha256PowV1,
        proofToken: 'secret-proof-token',
        policyVersion: 'risk-v2',
        verifiedAtUnixMs: 1000,
        expiresAtUnixMs: 10_000
      },
      markInFlight: vi.fn().mockReturnValue(true),
      settle
    })
    const socket = await waitForSocket(0)
    socket.open()
    await started

    expect(socket.url.searchParams.has('challengeProof')).toBe(false)
    expect(socket.url.toString()).not.toContain('secret-proof-token')
    expect((fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>)['X-Fsus-Challenge-Proof']).toBe('secret-proof-token')
    expect(settle).toHaveBeenCalledWith('accepted')

    socket.close(1006)
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(ManualWebSocket.instances).toHaveLength(1)
    expect(handshakeFailure).toHaveBeenCalledWith(NotificationStreamFailureCodes.RiskChallengeRequired)
  })

  it('batches cursor snapshots while keeping duplicate and out-of-order detection', async () => {
    const runtime = new NotificationStreamRuntime()
    const cursorChanges = vi.fn()
    const duplicateEvents = vi.fn()
    runtime.onCursorChange = cursorChanges
    runtime.onDuplicateEvent = duplicateEvents

    const started = runtime.start(undefined, undefined, 'auth')
    ;(await waitForSocket(0)).open()
    await started
    cursorChanges.mockClear()

    for (let id = 1; id <= 600; id += 1) {
      ManualWebSocket.instances[0]?.message(createEvent(id))
    }
    ManualWebSocket.instances[0]?.message(createEvent(590))
    ManualWebSocket.instances[0]?.message(createEvent(100))

    expect(cursorChanges).not.toHaveBeenCalledTimes(600)
    await vi.advanceTimersByTimeAsync(16)

    expect(cursorChanges).toHaveBeenCalledTimes(1)
    expect(cursorChanges).toHaveBeenLastCalledWith({
      lastEventId: 600,
      recentEventIds: expect.arrayContaining([600])
    })
    expect(runtime.snapshotCursor().recentEventIds).toHaveLength(512)
    expect(duplicateEvents).toHaveBeenCalledWith(590)
    expect(duplicateEvents).toHaveBeenCalledWith(100)
  })

  it('accepts account session revocation as a valid private event', async () => {
    const runtime = new NotificationStreamRuntime()
    const events = vi.fn()
    const protocolErrors = vi.fn()
    runtime.onEvent = events
    runtime.onProtocolError = protocolErrors

    const started = runtime.start(undefined, undefined, 'auth')
    ;(await waitForSocket(0)).open()
    await started
    ManualWebSocket.instances[0]?.message({
      id: 1,
      type: NotificationStreamEventType.SessionRevoked,
      ts: Date.now(),
      payload: {
        reason: 'passkey_counter_rollback',
        revokedSessionCount: 2,
        time: new Date().toISOString()
      }
    })

    expect(events).toHaveBeenCalledWith(expect.objectContaining({
      type: NotificationStreamEventType.SessionRevoked
    }))
    expect(protocolErrors).not.toHaveBeenCalled()
  })
})
