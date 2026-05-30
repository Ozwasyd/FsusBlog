import { afterEach, describe, expect, it, vi } from 'vitest'
import { emitFrontendAudit, type FrontendAuditRecord } from '@/services/auditConsole'

const baseRecord = (overrides: Partial<FrontendAuditRecord> = {}): FrontendAuditRecord => ({
  source: 'frontend',
  type: 'business',
  occurredAtUtc: '2026-05-18T00:00:00.000Z',
  eventInfo: 'test_event',
  context: { ok: true },
  ...overrides
})

describe('emitFrontendAudit', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes normal performance telemetry as info instead of warning', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    emitFrontendAudit(baseRecord({
      type: 'performance',
      eventInfo: 'web_vital_lcp',
      level: 'info'
    }))

    expect(info).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('keeps explicit warning and exception records on warning/error channels', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    emitFrontendAudit(baseRecord({ level: 'warn' }))
    emitFrontendAudit(baseRecord({ type: 'exception', level: 'error' }))

    expect(info).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledTimes(1)
  })
})
