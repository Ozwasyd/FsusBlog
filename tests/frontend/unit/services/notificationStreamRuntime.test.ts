import { describe, expect, it } from 'vitest'
import { resolveNotificationStreamEndpointUrl } from '@/services/notificationStreamRuntime'

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
      'https://fsus.blog'
    )

    expect(url.toString()).toBe('https://fsus.blog/api/notifications/stream/preflight')
  })
})
