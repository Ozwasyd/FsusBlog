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
    vi.unstubAllEnvs()
  })

  it('does not write high-frequency info telemetry by default', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    emitFrontendAudit(baseRecord({
      type: 'performance',
      eventInfo: 'web_vital_lcp',
      level: 'info'
    }))

    expect(info).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('can opt into info telemetry console output with an explicit flag', () => {
    vi.stubEnv('VITE_FSUSBLOG_AUDIT_CONSOLE_INFO', '1')
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)

    emitFrontendAudit(baseRecord({
      type: 'performance',
      eventInfo: 'web_vital_lcp',
      level: 'info'
    }))

    expect(info).toHaveBeenCalledTimes(1)
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

  it('does not throw when the browser console transport is disconnected', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('send was called before connect')
    })

    expect(() => emitFrontendAudit(baseRecord({ level: 'warn' }))).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
