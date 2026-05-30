import { afterEach, describe, expect, it, vi } from 'vitest'
import { emitRumMetric } from '@/services/telemetryService'

describe('emitRumMetric', () => {
  afterEach(() => {
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
    await Promise.resolve()

    expect(fetchMock).toHaveBeenCalledWith('/api/telemetry/rum', expect.objectContaining({
      method: 'POST',
      credentials: 'omit',
      keepalive: true
    }))
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body))
    expect(body).toMatchObject({
      name: 'web_vital_lcp',
      pageType: 'article',
      aotSource: 'server-aot',
      value: 1234,
      metrics: {
        value: 1234,
        durationMs: 1234
      }
    })
    expect(JSON.stringify(body)).not.toContain('/article/42')
    expect(JSON.stringify(body)).not.toContain('ignored')
  })

  it('does not send RUM from private routes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('navigator', { sendBeacon: vi.fn().mockReturnValue(false) })
    setPathname('/admin/dashboard')

    emitRumMetric('web_vital_cls', { value: 0.03 })
    await Promise.resolve()

    expect(fetchMock).not.toHaveBeenCalled()
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
