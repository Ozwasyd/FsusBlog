import { describe, expect, it } from 'vitest'
import {
  normalizeNotificationStreamHandshakeFailure,
  resolveNotificationStreamEndpointUrl
} from '@/services/notificationStreamRuntime'
import { NotificationStreamFailureCodes } from '@/services/notificationStreamTypes'

describe('resolveNotificationStreamEndpointUrl', () => {
  it('uses the configured API origin for dev WebSocket connections', () => {
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
})
