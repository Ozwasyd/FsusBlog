import { beforeEach, describe, expect, it, vi } from 'vitest'

const prepareCodeFonts = vi.fn(async () => undefined)
const initTelemetryService = vi.fn()

vi.mock('@/bootstrap/codeFontPreparation', () => ({
  prepareCodeFonts
}))

vi.mock('@/services/telemetryService', () => ({
  initTelemetryService
}))

describe('scheduleNonCriticalResources', () => {
  beforeEach(() => {
    vi.resetModules()
    prepareCodeFonts.mockClear()
    initTelemetryService.mockClear()
    vi.useFakeTimers()
  })

  it('idle path never prepares locale CJK fonts and only prepares code fonts when code is visible', async () => {
    const requestIdleCallback = vi.fn((callback: IdleRequestCallback) => {
      callback({ didTimeout: false, timeRemaining: () => 10 } as IdleDeadline)
      return 1
    })
    vi.stubGlobal('window', {
      requestIdleCallback,
      setTimeout: globalThis.setTimeout.bind(globalThis)
    })
    vi.stubGlobal('document', {
      querySelector: vi.fn(() => null)
    })

    const { scheduleNonCriticalResources } = await import('@/bootstrap/nonCriticalResources')
    scheduleNonCriticalResources()

    expect(prepareCodeFonts).not.toHaveBeenCalled()
    expect(requestIdleCallback).toHaveBeenCalled()
    await vi.runAllTimersAsync()
    expect(initTelemetryService).toHaveBeenCalledTimes(1)
    expect(prepareCodeFonts).not.toHaveBeenCalled()
  })

  it('prepares code fonts when a code surface is already present without locale font side effects', async () => {
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout.bind(globalThis)
    })
    vi.stubGlobal('document', {
      querySelector: vi.fn((selector: string) => selector.includes('code') ? {} : null)
    })

    const { scheduleNonCriticalResources } = await import('@/bootstrap/nonCriticalResources')
    scheduleNonCriticalResources()
    await Promise.resolve()

    expect(prepareCodeFonts).toHaveBeenCalledTimes(1)
  })
})
