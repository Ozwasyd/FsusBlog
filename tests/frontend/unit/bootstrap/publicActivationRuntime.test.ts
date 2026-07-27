import { beforeEach, describe, expect, it, vi } from 'vitest'

const submitIntent = vi.fn(async () => ({ generation: 1, status: 'interactive' as const }))
const createPublicBootActivationIntent = vi.fn((intent: { type: string }, target: string) => ({
  kind: 'activate' as const,
  source: `boot-${intent.type}`,
  target
}))

vi.mock('@/bootstrap/publicActivationCoordinator', () => ({
  PublicActivationCoordinator: class {
    constructor() {}
    submitIntent = submitIntent
    warm = vi.fn()
  },
  createPublicBootActivationIntent
}))
vi.mock('@/router/publicRoutePreload', () => ({
  prewarmPublicRoute: vi.fn()
}))
vi.mock('@/services/navigationProgress', () => ({
  hideNavigationProgress: vi.fn(),
  showNavigationProgress: vi.fn()
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
})
