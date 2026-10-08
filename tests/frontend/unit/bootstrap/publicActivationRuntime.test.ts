import { beforeEach, describe, expect, it, vi } from 'vitest'

const submitIntent = vi.fn(async () => ({ generation: 1, status: 'interactive' as const }))
const warm = vi.fn(async () => ({ ready: true }))
const warmCore = vi.fn(async () => ({ ready: true }))
const createPublicBootActivationIntent = vi.fn((intent: { type: string }, target: string) => ({
  kind: 'activate' as const,
  source: `boot-${intent.type}`,
  target
}))

vi.mock('@/bootstrap/publicActivationCoordinator', () => ({
  PublicActivationCoordinator: class {
    constructor() {}
    submitIntent = submitIntent
    warm = warm
    warmCore = warmCore
  },
  createPublicBootActivationIntent
}))
vi.mock('@/router/publicRoutePreload', () => ({
  prewarmPublicRoute: vi.fn()
}))
vi.mock('@/bootstrap/publicShellPrimitives', () => ({
  markGlobalLoaderBusy: vi.fn(),
  removeGlobalLoader: vi.fn(),
  showGlobalLoader: vi.fn()
}))
vi.mock('@/services/telemetryBus', () => ({
  emitTelemetry: vi.fn()
}))

describe('public activation browser composition', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    window.history.replaceState({}, '', '/article/7?from=boot#comments')
  })

  it('adopts the BootKernel handoff at most once', async () => {
    const { adoptPublicBootIntent } = await import('@/bootstrap/publicActivationRuntime')
    const intent = { type: 'pointerdown', timestamp: 42 }

    adoptPublicBootIntent(intent)
    adoptPublicBootIntent(intent)

    expect(createPublicBootActivationIntent).toHaveBeenCalledOnce()
    expect(createPublicBootActivationIntent).toHaveBeenCalledWith(
      intent,
      '/article/7?from=boot#comments'
    )
    expect(submitIntent).toHaveBeenCalledOnce()
  })

  it('exposes idle core warm separately from route warm', async () => {
    const {
      warmPublicActivation,
      warmPublicFullAppCore
    } = await import('@/bootstrap/publicActivationRuntime')

    await warmPublicFullAppCore()
    await warmPublicActivation('/archive', 'pointerenter')

    expect(warmCore).toHaveBeenCalledOnce()
    expect(warmCore).toHaveBeenCalledWith()
    expect(warm).toHaveBeenCalledWith('/archive', 'pointerenter')
  })

  it('routes search focus through the typed intent API without window events', async () => {
    document.body.innerHTML = '<div id="fsus-aot-shell"></div>'
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
    const { requestPublicSearchFocusIntent } = await import('@/bootstrap/publicActivationRuntime')

    requestPublicSearchFocusIntent()
    await Promise.resolve()

    expect(warm).toHaveBeenCalledWith('/search', 'search-focus')
    expect(submitIntent).toHaveBeenCalledWith({
      kind: 'activate',
      source: 'search-focus',
      target: '/article/7?from=boot#comments'
    })
    expect(dispatchSpy.mock.calls.some(([event]) => {
      return event instanceof Event && typeof event.type === 'string' && event.type.startsWith('fsus:public-shell:')
    })).toBe(false)
    dispatchSpy.mockRestore()
  })

  it('ignores search focus outside the AOT public shell surface', async () => {
    document.body.innerHTML = ''
    const { requestPublicSearchFocusIntent } = await import('@/bootstrap/publicActivationRuntime')

    requestPublicSearchFocusIntent()
    await Promise.resolve()

    expect(warm).not.toHaveBeenCalled()
    expect(submitIntent).not.toHaveBeenCalled()
  })
})
