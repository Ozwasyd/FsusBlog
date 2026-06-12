import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AEDS_HEADER_LENGTH, FrameType } from '@wasm/protocol/frame'
import { emitRumMetric, initTelemetryService } from '@/services/telemetryService'
import { emitRumMetric as emitRumMetricFromBus } from '@/services/telemetryBus'

describe('emitRumMetric', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
    setPathname('/')
  })

  it('sends only anonymous public-page performance fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    const sendBeacon = vi.fn().mockReturnValue(false)
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('navigator', { sendBeacon })
    setPathname('/article/42')
    document.body.innerHTML = '<div id="fsus-aot-shell"></div>'

    emitRumMetric('web_vital_lcp', {
      value: 1234,
      durationMs: 1234,
      ignored: 'raw'
    })
    initTelemetryService()
    await vi.advanceTimersByTimeAsync(250)

    expect(fetchMock).toHaveBeenCalledWith('/api/binary/telemetry/rum', expect.objectContaining({
      method: 'POST',
      credentials: 'omit',
      keepalive: true
    }))
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Headers
    expect(headers.get('Content-Type')).toBe('application/octet-stream')
    expect(headers.get('Accept')).toBe('application/octet-stream')
    const frame = init.body as ArrayBuffer
    expect(readFrameType(frame)).toBe(FrameType.RumMetricBatchRequest)
    const payloadView = new DataView(frame, AEDS_HEADER_LENGTH)
    expect(payloadView.getInt32(0, true)).toBe(1)
    expect(payloadView.getInt32(4, true)).toBe(2)
    const text = new TextDecoder().decode(new Uint8Array(frame))
    expect(text).toContain('web_vital_lcp')
    expect(text).toContain('article')
    expect(text).toContain('server-aot')
    expect(text).toContain('durationMs')
    expect(text).not.toContain('/article/42')
    expect(text).not.toContain('ignored')
  })

  it('does not send RUM from private routes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('navigator', { sendBeacon: vi.fn().mockReturnValue(false) })
    setPathname('/admin/dashboard')

    emitRumMetric('web_vital_cls', { value: 0.03 })
    initTelemetryService()
    await vi.advanceTimersByTimeAsync(250)

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not retain JSON fallback compatibility in the telemetry service', () => {
    const source = readFileSync(fileURLToPath(new URL('../../../../src/frontend/src/services/telemetryService.ts', import.meta.url)), 'utf8')

    expect(source).not.toContain('/api/telemetry/rum')
    expect(source).not.toContain('application/json')
    expect(source).not.toContain('response.json')
    expect(source).not.toContain('JSON.stringify')
  })

  it('throttles binary failure audit output during backend outage storms', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.setSystemTime(new Date('2026-06-11T12:24:42.000Z'))
    initTelemetryService()

    for (let i = 0; i < 10; i += 1) {
      window.dispatchEvent(new window.CustomEvent('fsus:binary:failure', {
        detail: {
          kind: 'network',
          message: 'Failed to fetch',
          url: '/api/binary/auth/pow-challenge'
        }
      }))
    }

    expect(warn).toHaveBeenCalledTimes(3)
    expect(localStorage.getItem('fsus.telemetry.binaryFailureCount')).toBe('10')
  })

  it('drains lightweight bus RUM emitted before full telemetry initializes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('navigator', { sendBeacon: vi.fn().mockReturnValue(false) })
    setPathname('/')

    emitRumMetricFromBus('navigation_timing', {
      domInteractive: 120,
      responseStart: 20
    })
    expect(fetchMock).not.toHaveBeenCalled()

    initTelemetryService()
    await vi.advanceTimersByTimeAsync(250)

    expect(fetchMock).toHaveBeenCalledWith('/api/binary/telemetry/rum', expect.objectContaining({
      method: 'POST',
      keepalive: true
    }))
  })

  it('keeps binary failure event handling non-throwing when console forwarding fails', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('send was called before connect')
    })
    vi.setSystemTime(new Date('2026-06-11T12:25:12.000Z'))
    initTelemetryService()

    expect(() => window.dispatchEvent(new window.CustomEvent('fsus:binary:failure', {
      detail: {
        kind: 'network',
        message: 'Failed to fetch',
        url: '/api/binary/auth/pow-challenge'
      }
    }))).not.toThrow()
  })
})

function setPathname(pathname: string): void {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      pathname
    }
  })
}

function readFrameType(buffer: ArrayBuffer): number {
  return new DataView(buffer).getUint16(8, true)
}
